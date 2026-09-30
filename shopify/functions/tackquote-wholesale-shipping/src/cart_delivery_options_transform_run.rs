// TackQuote wholesale shipping: Delivery Customization Function, target
// cart.delivery-options.transform.run.
//
// For a LINKED TackQuote buyer (a customer with a `$app:buyer` metafield) whose
// groups match a TackQuote shipping rule, this renames, hides or sorts the
// SHIPPING options of each delivery group, as that rule says. The rules come
// from the DeliveryCustomization's `$app:shipping_rules` (contract v2), which
// TackQuote pushes from its own shipping-rules module.
//
// What it can never do, by construction:
//   * set a price. A Delivery Customization cannot ("Rename, reorder, and sort
//     the delivery options", https://shopify.dev/docs/api/functions/2026-07/delivery-customization).
//     Wholesale rates are the job of tackquote-wholesale-shipping-discount.
//   * make a more expensive option the default. Shopify App Store requirement
//     1.1.10 ("Shipping must default to the lowest-priced option",
//     https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices),
//     and the schema's own note on DeliveryOptionMoveOperation: "The cheapest
//     shipping delivery option must always be the first option selected."
//     So the cheapest shipping option is never hidden, and whenever this
//     function reorders anything it puts the cheapest first.
//
// Pickup, local delivery and every non-SHIPPING method are left exactly where
// and as they are. Guests and unlinked customers get no operations. Anything
// malformed is omitted and logged, never defaulted.

use super::schema;
use crate::contract::{
    amount_to_units, cheapest_index, read_buyer, read_shipping_rules, resolve_shipping, title_matches, Omissions,
    Parsed, ShippingFacts, ShippingRule,
};
use shopify_function::prelude::*;
use shopify_function::Result;

type Input = schema::cart_delivery_options_transform_run::Input;
type Output = schema::CartDeliveryOptionsTransformRunResult;
type Group = schema::cart_delivery_options_transform_run::input::cart::DeliveryGroups;

/// Function output is capped at 20 kB (https://shopify.dev/docs/api/functions/2026-07,
/// "Resource limits"), and an over-limit result is a function error, which
/// drops every operation. Real delivery-option handles are ~65 characters, so
/// a large cart with many groups and a price sort could reach the cap. The
/// operations are therefore budgeted, in an order that keeps the guarantee:
/// per group, the move that puts the cheapest option first comes before any
/// other operation, so a cut can only lose cosmetic ones.
pub const OUTPUT_BUDGET_BYTES: usize = 15_000;

/// A conservative JSON size for one operation: the handle, the title for a
/// rename, and the fixed keys and punctuation.
fn op_bytes(op: &schema::Operation) -> usize {
    match op {
        schema::Operation::DeliveryOptionHide(h) => h.delivery_option_handle.len() + 60,
        schema::Operation::DeliveryOptionMove(m) => m.delivery_option_handle.len() + 70,
        schema::Operation::DeliveryOptionRename(r) => r.delivery_option_handle.len() + r.title.len() + 70,
    }
}

#[shopify_function]
fn cart_delivery_options_transform_run(input: Input) -> Result<Output> {
    let (output, omitted) = compute(&input);
    if !omitted.is_empty() {
        log!("{}", omitted.render("tackquote-wholesale-shipping"));
    }
    Ok(output)
}

fn empty() -> Output {
    Output { operations: vec![] }
}

struct ShippingOption<'a> {
    handle: &'a String,
    title: Option<&'a str>,
    cost: i64,
}

/// The operations for one delivery group under one presentation rule.
/// In output order: the move that puts the cheapest option first (when it is
/// not first already), then hides, renames and the remaining moves.
fn present(rule: &ShippingRule, options: &[ShippingOption], omitted: &mut Omissions) -> Vec<schema::Operation> {
    let mut ops = Vec::new();
    let costs: Vec<i64> = options.iter().map(|o| o.cost).collect();
    let Some(cheapest) = cheapest_index(&costs) else { return ops };

    // Hide: never the cheapest. That is also what keeps at least one option.
    let mut hidden = vec![false; options.len()];
    if let Some(needles) = &rule.hide {
        for (i, o) in options.iter().enumerate() {
            if !title_matches(o.title, needles) {
                continue;
            }
            if i == cheapest {
                omitted.add("hide_cheapest_kept", None);
                continue;
            }
            hidden[i] = true;
            ops.push(schema::Operation::DeliveryOptionHide(schema::DeliveryOptionHideOperation {
                delivery_option_handle: o.handle.clone(),
            }));
        }
    }

    // Rename: the options the rule targets, else the default (cheapest) one.
    if let Some(title) = &rule.rename {
        for (i, o) in options.iter().enumerate() {
            let targeted = match &rule.matches {
                Some(m) => title_matches(o.title, m),
                None => i == cheapest,
            };
            if targeted && !hidden[i] {
                ops.push(schema::Operation::DeliveryOptionRename(schema::DeliveryOptionRenameOperation {
                    delivery_option_handle: o.handle.clone(),
                    title: title.clone(),
                }));
            }
        }
    }

    // Order: the cheapest first, always; the rest by price when the rule says
    // so, else as Shopify listed them. The moves are the ones that, applied in
    // output order, turn Shopify's list into that order; nothing already in
    // place is moved.
    let mut current: Vec<usize> = (0..options.len()).filter(|&i| !hidden[i]).collect();
    let mut order: Vec<usize> = Vec::with_capacity(current.len());
    order.push(cheapest);
    let mut rest: Vec<usize> = current.iter().copied().filter(|&i| i != cheapest).collect();
    if rule.sort_by_price {
        // Stable: equal prices keep Shopify's order.
        rest.sort_by_key(|&i| options[i].cost);
    }
    order.extend(rest);
    let mut moves = Vec::new();
    for (target, &i) in order.iter().enumerate() {
        if current[target] == i {
            continue;
        }
        if let Some(from) = current.iter().position(|&x| x == i) {
            current.remove(from);
            current.insert(target, i);
        }
        moves.push(schema::Operation::DeliveryOptionMove(schema::DeliveryOptionMoveOperation {
            delivery_option_handle: options[i].handle.clone(),
            index: target as i32,
        }));
    }
    // Only the first move can be the cheapest-to-front one (target 0).
    let first_is_cheapest = matches!(moves.first(), Some(schema::Operation::DeliveryOptionMove(m)) if m.index == 0);
    if first_is_cheapest {
        let m = moves.remove(0);
        ops.insert(0, m);
    }
    ops.extend(moves);
    ops
}

/// Pure core: the result plus what was omitted, so tests can assert on both.
pub fn compute(input: &Input) -> (Output, Omissions) {
    let mut omitted = Omissions::default();

    let customer = match input.cart().buyer_identity().and_then(|b| b.customer()) {
        Some(c) => c,
        None => return (empty(), omitted),
    };
    let buyer = match read_buyer(customer.buyer().map(|m| m.json_value())) {
        Parsed::Ok(b) => b,
        Parsed::Absent => return (empty(), omitted),
        Parsed::Malformed(reason) => {
            omitted.add(&format!("buyer_{reason}"), None);
            return (empty(), omitted);
        }
    };
    let doc = match read_shipping_rules(input.delivery_customization().shipping_rules().map(|m| m.json_value())) {
        Parsed::Ok(d) => d,
        Parsed::Absent => return (empty(), omitted),
        Parsed::Malformed(reason) => {
            omitted.add(&format!("rules_{reason}"), None);
            return (empty(), omitted);
        }
    };

    let subtotal_money = input.cart().cost().subtotal_amount();
    let Some(subtotal) = amount_to_units(subtotal_money.amount().0) else {
        omitted.add("subtotal", None);
        return (empty(), omitted);
    };
    let presentment = subtotal_money.currency_code().as_str();
    let rate = input.presentment_currency_rate().0;

    // At the first operation that does not fit, everything after it is
    // dropped: a later move never runs without the cheapest-first move of its
    // own group, which always precedes it.
    let mut operations = Vec::new();
    let mut bytes = 0usize;
    'groups: for group in input.cart().delivery_groups() {
        for op in group_ops(group, &doc, &buyer, subtotal, presentment, rate, &mut omitted) {
            let b = op_bytes(&op);
            if bytes + b > OUTPUT_BUDGET_BYTES {
                omitted.add("output_budget", None);
                break 'groups;
            }
            bytes += b;
            operations.push(op);
        }
    }
    (Output { operations }, omitted)
}

fn group_ops(
    group: &Group,
    doc: &crate::contract::ShippingRules,
    buyer: &crate::contract::Buyer,
    subtotal: i64,
    presentment: &str,
    rate: f64,
    omitted: &mut Omissions,
) -> Vec<schema::Operation> {
    let country = group.delivery_address().and_then(|a| a.country_code()).map(|c| c.as_str());
    let facts = ShippingFacts { subtotal, presentment, rate, country };
    let rule = match resolve_shipping(doc, buyer, &facts) {
        Ok(r) => r.presentation,
        Err(reason) => {
            omitted.add(reason, None);
            return vec![];
        }
    };
    let Some(rule) = rule else { return vec![] };

    let mut options = Vec::new();
    for o in group.delivery_options() {
        if *o.delivery_method_type() != schema::DeliveryMethod::Shipping {
            continue;
        }
        let Some(cost) = amount_to_units(o.cost().amount().0) else {
            omitted.add("option_cost", None);
            return vec![];
        };
        options.push(ShippingOption { handle: o.handle(), title: o.title().map(|t| t.as_str()), cost });
    }
    // Moves index within the delivery group's list. A group that mixes
    // shipping with other methods is renamed and hidden but never reordered:
    // the documented index is over the whole list, and moving a pickup option
    // was never asked for.
    let mixed = options.len() != group.delivery_options().len();
    let mut ops = present(rule, &options, omitted);
    if mixed {
        let before = ops.len();
        ops.retain(|op| !matches!(op, schema::Operation::DeliveryOptionMove(_)));
        if ops.len() != before {
            omitted.add("mixed_group_not_sorted", None);
        }
    }
    ops
}

#[cfg(test)]
mod tests;
