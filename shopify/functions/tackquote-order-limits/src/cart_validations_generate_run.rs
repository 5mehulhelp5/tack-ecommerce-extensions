// TackQuote order limits: Cart and Checkout Validation Function, target
// cart.validations.generate.run.
//
// Enforces, for a LINKED TackQuote buyer (a customer with a `$app:buyer`
// metafield):
//   per variant  min / max / step (a multiple of), from two dimensions, both
//                enforced, the way TackQuote's order-limits service evaluates
//                every applicable rule:
//                  product  = variant `$app:order_limits` (first of the buyer's
//                             groups, then "*"), else the shop default `d`
//                  customer = the buyer's own `q[variant]`, else the buyer's `d`
//   per cart     minTotal / maxTotal / minQty / maxQty / minUnique / maxUnique,
//                from the shop-wide validation `$app:cart_limits` AND the
//                buyer's own `l`.
//
// When each rule runs. At CART_INTERACTION a returned error makes the cart
// mutation itself fail (cartLinesAdd returns `cart: null` with
// VALIDATION_CUSTOM,
// https://shopify.dev/docs/apps/build/checkout/cart-checkout-validation/create-admin-ui-validation).
// A minimum enforced there would stop a buyer from ever building up to it, so:
//   CART_INTERACTION                          maximums only
//   CHECKOUT_INTERACTION, CHECKOUT_COMPLETION everything
//   step absent                               everything (fail closed)
// Shopify: validations "run on Shopify's servers and are enforced throughout
// checkout, so they can't be bypassed by the client"
// (https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/validationCreate).
// That express/accelerated wallets reach the CHECKOUT_COMPLETION run is the
// reading of that sentence; a live wallet test is still UNVERIFIED.
//
// Every error targets `$.cart`, the only cart-level target in the documented
// list (https://shopify.dev/docs/api/functions/2026-07/cart-and-checkout-validation).
//
// Guests and unlinked customers get no errors. Anything malformed is omitted
// and logged, never defaulted: a broken limit is not a limit.

use super::schema;
use crate::contract::{
    amount_to_units, read_buyer, read_order_limits, read_shop_limits, resolve_customer_limit,
    resolve_product_limit, to_presentment, units_to_f64, variant_key, CartLimits, LimitEntry,
    Omissions, OrderLimits, Parsed,
};
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::{BTreeMap, BTreeSet};

pub const TARGET: &str = "$.cart";

/// Function output is capped at 20 kB for carts up to 200 lines
/// (https://shopify.dev/docs/api/functions/2026-07). A 200-line cart where
/// every line breaks three rules would need ~60 kB of messages, and an
/// over-limit result is a function ERROR rather than a validation result, and
/// a function error blocks checkout only when the validation was installed
/// with blockOnFailure = true (validationCreate,
/// https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/validationCreate;
/// TackQuote installs with the default, false). So the
/// list is capped and the last message counts what was not listed: checkout
/// stays blocked and nothing is hidden.
pub const MAX_ERRORS: usize = 25;

type Input = schema::cart_validations_generate_run::Input;
type Output = schema::CartValidationsGenerateRunResult;
type Merchandise = schema::cart_validations_generate_run::input::cart::lines::Merchandise;

#[shopify_function]
fn cart_validations_generate_run(input: Input) -> Result<Output> {
    let (output, omitted) = compute(&input);
    if !omitted.is_empty() {
        log!("{}", omitted.render("tackquote-order-limits"));
    }
    Ok(output)
}

fn empty() -> Output {
    Output { operations: vec![] }
}

/// Which rules run at this step of the buyer journey.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Enforce {
    MaximumsOnly,
    All,
}

pub fn enforcement(step: Option<&schema::BuyerJourneyStep>) -> Enforce {
    match step {
        Some(schema::BuyerJourneyStep::CartInteraction) => Enforce::MaximumsOnly,
        _ => Enforce::All,
    }
}

type Variant = schema::cart_validations_generate_run::input::cart::lines::merchandise::ProductVariant;

struct VariantLine<'a> {
    vkey: Option<&'a str>,
    // Titles are read only when a message needs them.
    variant: &'a Variant,
    qty: i64,
    limits: Option<OrderLimits>,
}

fn label(product: &str, variant: Option<&String>) -> String {
    match variant {
        Some(v) if !v.is_empty() && v != "Default Title" => format!("{product} - {v}"),
        _ => product.to_string(),
    }
}

fn money(units: i64, currency: &str) -> String {
    let v = units_to_f64(units);
    format!("{v:.2} {currency}")
}

/// Deduplicated, capped problem list. A problem is keyed by (variant, rule,
/// limit), so the same rule stated by two dimensions is reported once, and a
/// message is only formatted while it will be listed: formatting 600 messages
/// on a 200-line cart cost ~14M instructions before this cap existed.
#[derive(Default)]
struct Problems {
    seen: BTreeSet<(u64, u8, i64)>,
    listed: Vec<String>,
    unlisted: usize,
}

const CART: u64 = 0;

impl Problems {
    fn add(&mut self, key: (u64, u8, i64), message: impl FnOnce() -> String) {
        if !self.seen.insert(key) {
            return;
        }
        if self.listed.len() < MAX_ERRORS {
            self.listed.push(message());
        } else {
            self.unlisted += 1;
        }
    }

    fn finish(mut self) -> Vec<String> {
        if self.unlisted > 0 {
            self.listed.pop();
            let more = self.unlisted + 1;
            self.listed.push(format!(
                "{more} more order-limit problems. Adjust the quantities above, then review your cart again."
            ));
        }
        self.listed
    }
}

fn check_entry(p: &mut Problems, e: &LimitEntry, num: u64, v: &Variant, qty: i64, enforce: Enforce) {
    let name = || label(v.product().title(), v.title());
    if let Some(max) = e.max {
        if qty > max {
            p.add((num, 1, max), || format!("Quantity for \"{}\" must be at most {max}.", name()));
        }
    }
    if enforce == Enforce::MaximumsOnly {
        return;
    }
    if let Some(min) = e.min {
        if qty < min {
            p.add((num, 2, min), || format!("Quantity for \"{}\" must be at least {min}.", name()));
        }
    }
    if let Some(step) = e.step {
        if qty % step != 0 {
            p.add((num, 3, step), || format!("Quantity for \"{}\" must be a multiple of {step}.", name()));
        }
    }
}

struct CartFacts<'a> {
    subtotal: Option<i64>,
    currency: &'a str,
    rate: f64,
    qty: i64,
    unique: i64,
}

fn check_cart(
    p: &mut Problems,
    omitted: &mut Omissions,
    l: &CartLimits,
    source_currency: Option<&str>,
    facts: &CartFacts,
    enforce: Enforce,
    who: &str,
) {
    let counts = [
        (10u8, l.max_qty, true, facts.qty, "Order may contain at most {} items."),
        (11, l.max_unique, true, facts.unique, "Order may include at most {} unique products."),
        (12, l.min_qty, false, facts.qty, "Order must contain at least {} items."),
        (13, l.min_unique, false, facts.unique, "Order must include at least {} unique products."),
    ];
    for (rule, limit, is_max, actual, template) in counts {
        let Some(limit) = limit else { continue };
        if !is_max && enforce == Enforce::MaximumsOnly {
            continue;
        }
        if (is_max && actual > limit) || (!is_max && actual < limit) {
            p.add((CART, rule, limit), || template.replace("{}", &limit.to_string()));
        }
    }

    if !l.has_money() {
        return;
    }
    // parse_* guarantees a currency whenever money is present.
    let (Some(source), Some(subtotal)) = (source_currency, facts.subtotal) else {
        omitted.add(&format!("{who}_subtotal"), None);
        return;
    };
    let convert = |units: i64| to_presentment(units, source, facts.currency, facts.rate);
    if let Some(max) = l.max_total {
        match convert(max) {
            Some(max) if subtotal > max => p.add((CART, 14, max), || {
                format!("Order total must be at most {}.", money(max, facts.currency))
            }),
            Some(_) => {}
            None => omitted.add(&format!("{who}_currency_mismatch"), None),
        }
    }
    if enforce == Enforce::MaximumsOnly {
        return;
    }
    if let Some(min) = l.min_total {
        match convert(min) {
            Some(min) if subtotal < min => p.add((CART, 15, min), || {
                format!("Order total must be at least {}.", money(min, facts.currency))
            }),
            Some(_) => {}
            None => omitted.add(&format!("{who}_currency_mismatch"), None),
        }
    }
}

/// Pure core: the result plus what was omitted, so tests can assert on both.
pub fn compute(input: &Input) -> (Output, Omissions) {
    let mut omitted = Omissions::default();

    // Guest: no buyer identity or no customer. Normal, not logged.
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

    let shop = match read_shop_limits(input.validation().cart_limits().map(|m| m.json_value())) {
        Parsed::Ok(s) => Some(s),
        Parsed::Absent => None,
        Parsed::Malformed(reason) => {
            omitted.add(&format!("shop_{reason}"), None);
            None
        }
    };

    let enforce = enforcement(input.buyer_journey().step());

    // Quantities are per VARIANT, summed across lines: one variant can sit on
    // two lines (different line attributes), and 6 + 6 is an order of 12.
    let mut variants: BTreeMap<u64, VariantLine> = BTreeMap::new();
    let mut total_qty = 0i64;
    for line in input.cart().lines() {
        let v = match line.merchandise() {
            Merchandise::ProductVariant(v) => v,
            _ => continue,
        };
        let qty = i64::from(*line.quantity());
        total_qty += qty;
        // Keyed by the numeric id: every gid shares a 29-byte prefix, and
        // comparing it was measurable on large carts.
        let vkey = variant_key(v.id().as_str());
        let Some(num) = vkey.and_then(|k| k.parse::<u64>().ok()) else {
            omitted.add("variant_id", None);
            continue;
        };
        if let Some(existing) = variants.get_mut(&num) {
            existing.qty += qty;
            continue;
        }
        let limits = match read_order_limits(v.order_limits().map(|m| m.json_value())) {
            Parsed::Ok(l) => Some(l),
            Parsed::Absent => None,
            Parsed::Malformed(reason) => {
                omitted.add(&format!("limits_{reason}"), vkey);
                None
            }
        };
        variants.insert(
            num,
            VariantLine { vkey, variant: v, qty, limits },
        );
    }

    let mut problems = Problems::default();

    let shop_default = shop.as_ref().and_then(|s| s.defaults);
    for (&num, line) in &variants {
        // A malformed entry drops that dimension for this variant. It never
        // falls back to a default: a broken limit is not a limit.
        let product = resolve_product_limit(&buyer, line.limits.as_ref(), shop_default)
            .unwrap_or_else(|reason| {
                omitted.add(reason, line.vkey);
                None
            });
        let customer = resolve_customer_limit(&buyer, line.vkey).unwrap_or_else(|reason| {
            omitted.add(reason, line.vkey);
            None
        });
        for e in [product, customer].iter().flatten() {
            check_entry(&mut problems, e, num, line.variant, line.qty, enforce);
        }
    }

    let rate = input.presentment_currency_rate().0;
    let subtotal_money = input.cart().cost().subtotal_amount();
    let facts = CartFacts {
        subtotal: amount_to_units(subtotal_money.amount().0),
        currency: subtotal_money.currency_code().as_str(),
        rate,
        qty: total_qty,
        unique: variants.len() as i64,
    };
    if let Some(s) = &shop {
        if let Some(l) = &s.cart {
            check_cart(&mut problems, &mut omitted, l, s.currency.as_deref(), &facts, enforce, "shop");
        }
    }
    if let Some(l) = &buyer.cart {
        check_cart(&mut problems, &mut omitted, l, buyer.currency.as_deref(), &facts, enforce, "buyer");
    }

    let errors = problems.finish();
    if errors.is_empty() {
        return (empty(), omitted);
    }
    (
        Output {
            operations: vec![schema::Operation::ValidationAdd(schema::ValidationAddOperation {
                errors: errors
                    .into_iter()
                    .map(|message| schema::ValidationError { message, target: TARGET.to_string() })
                    .collect(),
            })],
        },
        omitted,
    )
}

#[cfg(test)]
mod tests;
