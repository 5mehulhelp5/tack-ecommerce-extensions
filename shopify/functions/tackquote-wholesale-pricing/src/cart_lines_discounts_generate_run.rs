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
    amount_to_units, read_buyer, read_price_tiers, resolve_unit_price, to_presentment,
    units_to_f64, variant_key, Omissions, Parsed, PriceTiers,
};
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::BTreeMap;

/// The automatic discount title TackQuote creates at install; see
/// APP_TOML_AND_SCOPES.md.
pub const DISCOUNT_TITLE: &str = "Wholesale price";

type Input = schema::cart_lines_discounts_generate_run::Input;
type Output = schema::CartLinesDiscountsGenerateRunResult;
type Merchandise = schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise;

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

    let buyer = match read_buyer(customer.buyer().map(|m| m.json_value())) {
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
    //
    // Maps are keyed by the numeric variant id, not the gid string: every gid
    // shares a 29-byte prefix, and comparing it dominated the instruction count
    // on large carts (measured with function-runner --profile).
    let mut variant_lines = Vec::new();
    let mut qty_by_variant: BTreeMap<u64, i64> = BTreeMap::new();
    for line in input.cart().lines() {
        if let Merchandise::ProductVariant(v) = line.merchandise() {
            let vkey = variant_key(v.id().as_str());
            let Some(num) = vkey.and_then(|k| k.parse::<u64>().ok()) else {
                omitted.add("variant_id", None);
                continue;
            };
            *qty_by_variant.entry(num).or_insert(0) += i64::from(*line.quantity());
            variant_lines.push((line, v, vkey, num));
        }
    }

    let mut tiers_cache: BTreeMap<u64, Option<PriceTiers>> = BTreeMap::new();
    let mut by_amount: BTreeMap<i64, Vec<schema::ProductDiscountCandidateTarget>> = BTreeMap::new();

    for (line, variant, vkey, num) in variant_lines {
        let tiers = tiers_cache
            .entry(num)
            .or_insert_with(|| match read_price_tiers(variant.price_tiers().map(|m| m.json_value())) {
                Parsed::Ok(t) => Some(t),
                // Absent is normal. A value over 10,000 bytes also arrives as
                // null, which is why the push pipeline must refuse to write one.
                Parsed::Absent => None,
                Parsed::Malformed(reason) => {
                    omitted.add(&format!("tiers_{reason}"), vkey);
                    None
                }
            })
            .as_ref();

        let qty = *qty_by_variant.get(&num).unwrap_or(&0);
        let price = match resolve_unit_price(&buyer, vkey, tiers, qty) {
            Ok(Some(p)) => p,
            Ok(None) => continue,
            Err(reason) => {
                omitted.add(reason, vkey);
                continue;
            }
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

        by_amount.entry(off).or_default().push(schema::ProductDiscountCandidateTarget::CartLine(
            schema::CartLineTarget { id: line.id().clone(), quantity: None },
        ));
    }

    // One candidate per distinct per-unit amount, targeting every line that
    // gets it. Function output is capped at 20 kB for carts up to 200 lines
    // (https://shopify.dev/docs/api/functions/2026-07), and one candidate per
    // line would pass it on a large cart. No per-candidate `message` for the
    // same reason: the automatic discount's title ("Wholesale price", set by
    // discountAutomaticAppCreate) labels it at checkout.
    let candidates: Vec<schema::ProductDiscountCandidate> = by_amount
        .into_iter()
        .map(|(off, targets)| schema::ProductDiscountCandidate {
            targets,
            message: None,
            value: schema::ProductDiscountCandidateValue::FixedAmount(
                schema::ProductDiscountCandidateFixedAmount {
                    amount: Decimal(units_to_f64(off)),
                    applies_to_each_item: Some(true),
                },
            ),
            associated_discount_code: None,
            prerequisites: None,
        })
        .collect();

    if candidates.is_empty() {
        return (empty(), omitted);
    }
    (
        Output {
            operations: vec![schema::CartOperation::ProductDiscountsAdd(
                schema::ProductDiscountsAddOperation {
                    // Candidates target disjoint lines; all of them apply.
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
