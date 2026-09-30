// TackQuote wholesale shipping rates: Discount Function, target
// cart.delivery-options.discounts.generate.run.
//
// A Delivery Customization can "rename, reorder, and sort" delivery options but
// cannot set their price (https://shopify.dev/docs/api/functions/2026-07/delivery-customization).
// The documented way for an app to charge a buyer less for shipping is a
// delivery discount: `deliveryDiscountsAdd` with a fixed amount or percentage
// against a delivery group or option
// (https://shopify.dev/docs/api/functions/2026-07/discount). So a TackQuote
// shipping rate of X becomes "this option, minus (its price - X)".
//
// For a LINKED TackQuote buyer (a customer with `$app:buyer`), the rule that
// prices is TackQuote's own (first match wins, `resolve_shipping` in
// contract.rs, ported from shipping-rule-evaluation.ts). It applies to:
//   * the options whose titles match the rule's `m`, or
//   * without `m`, the default option: the cheapest SHIPPING option.
// A discount only ever lowers a price. And it never makes a non-default option
// cheaper than the default one ends up: checkout selects the cheapest option
// by default (App Store requirement 1.1.10,
// https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices), so a
// matched option is lowered at most to the default option's final price.
//
// Guests and unlinked customers get nothing. Anything malformed is omitted and
// logged, never defaulted: a broken rule is not a rate.

use super::schema;
use crate::contract::{
    amount_to_units, cheapest_index, read_buyer, read_shipping_rules, resolve_shipping, title_matches,
    units_to_f64, Buyer, Omissions, Parsed, ShippingFacts, ShippingRules,
};
use crate::i18n;
use shopify_function::prelude::*;
use shopify_function::Result;

type Input = schema::cart_delivery_options_discounts_generate_run::Input;
type Output = schema::CartDeliveryOptionsDiscountsGenerateRunResult;
type Group = schema::cart_delivery_options_discounts_generate_run::input::cart::DeliveryGroups;

/// Function output is capped at 20 kB (https://shopify.dev/docs/api/functions/2026-07,
/// "Resource limits"); an over-limit result is a function error, which drops
/// every discount. Candidates are budgeted a whole delivery group at a time:
/// a group's cuts only keep the default option cheapest together (a matched
/// option is lowered to the DEFAULT option's final price), so a group is
/// never cut in half.
pub const OUTPUT_BUDGET_BYTES: usize = 15_000;

fn cut_bytes(c: &Cut, message: &str) -> usize {
    c.handle.len() + message.len() + 150
}

#[shopify_function]
fn cart_delivery_options_discounts_generate_run(input: Input) -> Result<Output> {
    let (output, omitted) = compute(&input);
    if !omitted.is_empty() {
        log!("{}", omitted.render("tackquote-wholesale-shipping-discount"));
    }
    Ok(output)
}

fn empty() -> Output {
    Output { operations: vec![] }
}

/// One discounted option: its handle and the amount off, in presentment units.
#[derive(Debug, PartialEq)]
pub struct Cut {
    pub handle: String,
    pub off: i64,
}

fn group_cuts(
    group: &Group,
    doc: &ShippingRules,
    buyer: &Buyer,
    subtotal: i64,
    presentment: &str,
    rate: f64,
    omitted: &mut Omissions,
) -> Vec<Cut> {
    let country = group.delivery_address().and_then(|a| a.country_code()).map(|c| c.as_str());
    let facts = ShippingFacts { subtotal, presentment, rate, country };
    let (rule, amount) = match resolve_shipping(doc, buyer, &facts) {
        Ok(r) => match r.rate {
            Some(x) => x,
            None => return vec![],
        },
        Err(reason) => {
            omitted.add(reason, None);
            return vec![];
        }
    };

    let mut options: Vec<(&String, Option<&str>, i64)> = Vec::new();
    for o in group.delivery_options() {
        if *o.delivery_method_type() != schema::DeliveryMethod::Shipping {
            continue;
        }
        let Some(cost) = amount_to_units(o.cost().amount().0) else {
            omitted.add("option_cost", None);
            return vec![];
        };
        options.push((o.handle(), o.title().map(|t| t.as_str()), cost));
    }
    let costs: Vec<i64> = options.iter().map(|o| o.2).collect();
    let Some(cheapest) = cheapest_index(&costs) else { return vec![] };

    let targeted: Vec<usize> = match &rule.matches {
        Some(m) => (0..options.len()).filter(|&i| title_matches(options[i].1, m)).collect(),
        None => vec![cheapest],
    };
    // The default option's final price: its own rate if it is targeted.
    let default_final = if targeted.contains(&cheapest) { costs[cheapest].min(amount) } else { costs[cheapest] };

    let mut cuts = Vec::new();
    for i in targeted {
        let target = if i == cheapest { amount } else { amount.max(default_final) };
        let off = costs[i] - target;
        if off > 0 {
            cuts.push(Cut { handle: options[i].0.clone(), off });
        }
    }
    cuts
}

/// Pure core: the cuts per option plus what was omitted, so tests can assert
/// on both.
pub fn compute_cuts(input: &Input) -> (Vec<Cut>, Omissions) {
    let mut omitted = Omissions::default();
    if !input.discount().discount_classes().contains(&schema::DiscountClass::Shipping) {
        return (vec![], omitted);
    }
    let customer = match input.cart().buyer_identity().and_then(|b| b.customer()) {
        Some(c) => c,
        None => return (vec![], omitted),
    };
    let buyer = match read_buyer(customer.buyer().map(|m| m.json_value())) {
        Parsed::Ok(b) => b,
        Parsed::Absent => return (vec![], omitted),
        Parsed::Malformed(reason) => {
            omitted.add(&format!("buyer_{reason}"), None);
            return (vec![], omitted);
        }
    };
    let doc = match read_shipping_rules(input.discount().shipping_rules().map(|m| m.json_value())) {
        Parsed::Ok(d) => d,
        Parsed::Absent => return (vec![], omitted),
        Parsed::Malformed(reason) => {
            omitted.add(&format!("rules_{reason}"), None);
            return (vec![], omitted);
        }
    };
    let subtotal_money = input.cart().cost().subtotal_amount();
    let Some(subtotal) = amount_to_units(subtotal_money.amount().0) else {
        omitted.add("subtotal", None);
        return (vec![], omitted);
    };
    let presentment = subtotal_money.currency_code().as_str();
    let rate = input.presentment_currency_rate().0;

    let message = i18n::wholesale_shipping(input.localization().language().iso_code());
    let mut cuts = Vec::new();
    let mut bytes = 0usize;
    for group in input.cart().delivery_groups() {
        let group_cuts = group_cuts(group, &doc, &buyer, subtotal, presentment, rate, &mut omitted);
        let b: usize = group_cuts.iter().map(|c| cut_bytes(c, message)).sum();
        if bytes + b > OUTPUT_BUDGET_BYTES {
            omitted.add("output_budget", None);
            continue;
        }
        bytes += b;
        cuts.extend(group_cuts);
    }
    (cuts, omitted)
}

pub fn compute(input: &Input) -> (Output, Omissions) {
    let (cuts, omitted) = compute_cuts(input);
    if cuts.is_empty() {
        return (empty(), omitted);
    }
    let message = i18n::wholesale_shipping(input.localization().language().iso_code()).to_string();
    let candidates = cuts
        .into_iter()
        .map(|c| schema::DeliveryDiscountCandidate {
            targets: vec![schema::DeliveryDiscountCandidateTarget::DeliveryOption(schema::DeliveryOptionTarget {
                handle: c.handle,
            })],
            value: schema::DeliveryDiscountCandidateValue::FixedAmount(schema::FixedAmount {
                amount: Decimal(units_to_f64(c.off)),
            }),
            message: Some(message.clone()),
            associated_discount_code: None,
        })
        .collect();
    (
        Output {
            operations: vec![schema::DeliveryOperation::DeliveryDiscountsAdd(schema::DeliveryDiscountsAddOperation {
                selection_strategy: schema::DeliveryDiscountSelectionStrategy::All,
                candidates,
            })],
        },
        omitted,
    )
}

#[cfg(test)]
mod tests;
