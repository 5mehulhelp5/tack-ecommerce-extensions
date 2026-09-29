// TackQuote wholesale pricing: Discount Function, target
// cart.lines.discounts.generate.run, product discount class, installed as an
// automatic app discount with discountAutomaticAppCreate.
//
// Per cart line it takes the buyer's TackQuote unit price for the variant's
// quantity and discounts the difference from the line's retail unit price:
//
//   fixedAmount per unit = retail (presentment) - tier price (shop) x presentmentCurrencyRate
//
// Skipped when that is <= 0: a discount can only lower a price.
//
// Why a discount rather than a Cart Transform price override: `lineUpdate` is
// available only on Shopify Plus and development stores, and this must work
// on every plan. A public app's discount function also has no network access,
// so every price it needs is pushed into `$app` metafields beforehand
// (../../METAFIELD_CONTRACT.md).
//
// Guests get nothing (buyerIdentity is empty for them). A signed-in customer
// without a `$app:buyer` metafield is not a linked TackQuote buyer and gets
// nothing either. Anything malformed is omitted and logged, never defaulted.

use super::schema;
use crate::contract::{
    amount_to_units, parse_buyer, parse_price_tiers, resolve_unit_price, to_presentment,
    units_to_f64, variant_key, Omissions, Parsed, PriceTiers,
};
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::BTreeMap;

pub const DISCOUNT_MESSAGE: &str = "Wholesale price";

type Input = schema::cart_lines_discounts_generate_run::Input;
type Output = schema::CartLinesDiscountsGenerateRunResult;

#[shopify_function]
fn cart_lines_discounts_generate_run(input: Input) -> Result<Output> {
    let (output, omitted) = compute(&input);
    if !omitted.is_empty() {
        log!("{}", omitted.render("tackquote-wholesale-pricing"));
    }
    Ok(output)
}

fn empty() -> Output {
    Output { operations: vec![] }
}

/// Pure core: the result plus what was omitted, so tests can assert on both.
pub fn compute(input: &Input) -> (Output, Omissions) {
    let mut omitted = Omissions::default();

    if !input
        .discount()
        .discount_classes()
        .contains(&schema::DiscountClass::Product)
    {
        return (empty(), omitted);
    }

    // Guest: no buyer identity or no customer. Normal, not logged.
    let customer = match input.cart().buyer_identity().and_then(|b| b.customer()) {
        Some(c) => c,
        None => return (empty(), omitted),
    };

    let buyer = match parse_buyer(customer.buyer().map(|m| m.json_value())) {
        Parsed::Ok(b) => b,
        Parsed::Absent => return (empty(), omitted), // not a linked buyer
        Parsed::Malformed(reason) => {
            omitted.add(&format!("buyer_{reason}"), None);
            return (empty(), omitted);
        }
    };

    let rate = input.presentment_currency_rate().0;
    if !rate.is_finite() || rate <= 0.0 {
        omitted.add("presentment_rate", None);
        return (empty(), omitted);
    }

    // Tiers are chosen on the variant's TOTAL quantity: one variant can sit on
    // two lines (different line attributes), and 6 + 6 is an order of 12.
    let mut qty_by_variant: BTreeMap<&str, i64> = BTreeMap::new();
    for line in input.cart().lines() {
        if let schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(v) =
            line.merchandise()
        {
            *qty_by_variant.entry(v.id().as_str()).or_insert(0) += i64::from(*line.quantity());
        }
    }

    let mut tiers_cache: BTreeMap<&str, Option<PriceTiers>> = BTreeMap::new();
    let mut candidates = Vec::new();

    for line in input.cart().lines() {
        let variant = match line.merchandise() {
            schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(v) => v,
            _ => continue,
        };
        let vid = variant.id().as_str();
        let vkey = variant_key(vid);

        if !tiers_cache.contains_key(vid) {
            let parsed = match parse_price_tiers(variant.price_tiers().map(|m| m.json_value())) {
                Parsed::Ok(t) => Some(t),
                // Absent is normal. A value over 10,000 bytes also arrives as
                // null, which is why the push pipeline must refuse to write one.
                Parsed::Absent => None,
                Parsed::Malformed(reason) => {
                    omitted.add(&format!("tiers_{reason}"), vkey);
                    None
                }
            };
            tiers_cache.insert(vid, parsed);
        }
        let tiers = tiers_cache.get(vid).and_then(|t| t.as_ref());

        let qty = *qty_by_variant.get(vid).unwrap_or(&0);
        let price = match resolve_unit_price(&buyer, vkey, tiers, qty) {
            Some(p) => p,
            None => continue,
        };

        let money = line.cost().amount_per_quantity();
        let retail = match amount_to_units(money.amount().0) {
            Some(u) => u,
            None => {
                omitted.add("retail_amount", vkey);
                continue;
            }
        };
        let target = match to_presentment(price.units, price.currency, money.currency_code().as_str(), rate) {
            Some(u) => u,
            None => {
                omitted.add("currency_mismatch", vkey);
                continue;
            }
        };

        let off = retail - target;
        if off <= 0 {
            continue; // not below retail: never raise a price
        }

        candidates.push(schema::ProductDiscountCandidate {
            targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                schema::CartLineTarget {
                    id: line.id().clone(),
                    quantity: None,
                },
            )],
            message: Some(DISCOUNT_MESSAGE.to_string()),
            value: schema::ProductDiscountCandidateValue::FixedAmount(
                schema::ProductDiscountCandidateFixedAmount {
                    amount: Decimal(units_to_f64(off)),
                    applies_to_each_item: Some(true),
                },
            ),
            associated_discount_code: None,
            prerequisites: None,
        });
    }

    if candidates.is_empty() {
        return (empty(), omitted);
    }
    (
        Output {
            operations: vec![schema::CartOperation::ProductDiscountsAdd(
                schema::ProductDiscountsAddOperation {
                    // Each candidate targets a different line; all should apply.
                    selection_strategy: schema::ProductDiscountSelectionStrategy::All,
                    candidates,
                },
            )],
        },
        omitted,
    )
}

#[cfg(test)]
mod tests;
