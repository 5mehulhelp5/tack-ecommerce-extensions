// Unit tests for the order-limits Validation Function. Inputs are built in
// exactly the shape src/cart_validations_generate_run.graphql returns and run
// through shopify_function's own `run_function_with_input`.

use super::*;
use serde_json::{json, Value};
use shopify_function::run_function_with_input;

fn line(variant: u64, qty: i32, limits: Option<Value>) -> Value {
    product_line(variant, variant + 9000, qty, limits, None)
}

/// A line whose product (id `product`) carries `visibility`.
fn product_line(variant: u64, product: u64, qty: i32, limits: Option<Value>, visibility: Option<Value>) -> Value {
    json!({
        "quantity": qty,
        "merchandise": {
            "__typename": "ProductVariant",
            "id": format!("gid://shopify/ProductVariant/{variant}"),
            "title": "Default Title",
            "product": {
                "id": format!("gid://shopify/Product/{product}"),
                "title": format!("P{variant}"),
                "visibility": visibility.map(|v| json!({ "jsonValue": v })),
            },
            "orderLimits": limits.map(|l| json!({ "jsonValue": l })),
        }
    })
}

struct In {
    buyer: Option<Value>,
    shop: Option<Value>,
    lines: Vec<Value>,
    step: Option<&'static str>,
    subtotal: &'static str,
    currency: &'static str,
    rate: &'static str,
    guest: bool,
    lang: &'static str,
}

impl In {
    fn new(buyer: Value, lines: Vec<Value>) -> Self {
        In {
            buyer: Some(buyer),
            shop: None,
            lines,
            step: Some("CHECKOUT_COMPLETION"),
            subtotal: "100.0",
            currency: "USD",
            rate: "1.0",
            guest: false,
            lang: "EN",
        }
    }
    fn json(&self) -> String {
        let identity = if self.guest {
            Value::Null
        } else {
            json!({ "customer": { "buyer": self.buyer.as_ref().map(|b| json!({ "jsonValue": b })) } })
        };
        json!({
            "presentmentCurrencyRate": self.rate,
            "localization": { "language": { "isoCode": self.lang } },
            "buyerJourney": { "step": self.step },
            "validation": { "cartLimits": self.shop.as_ref().map(|s| json!({ "jsonValue": s })) },
            "cart": {
                "cost": { "subtotalAmount": { "amount": self.subtotal, "currencyCode": self.currency } },
                "buyerIdentity": identity,
                "lines": self.lines,
            },
        })
        .to_string()
    }
    fn run(&self) -> (Output, Omissions) {
        run_function_with_input(|i: Input| Ok(compute(&i)), &self.json()).unwrap()
    }
    fn errors(&self) -> Vec<String> {
        messages(&self.run().0)
    }
}

fn messages(out: &Output) -> Vec<String> {
    let mut v = Vec::new();
    for op in &out.operations {
        let schema::Operation::ValidationAdd(add) = op;
        for e in &add.errors {
            assert_eq!(e.target, TARGET);
            v.push(e.message.clone());
        }
    }
    v
}

fn buyer() -> Value {
    json!({ "v": 1, "g": ["GOLD"] })
}

fn case_pack() -> Value {
    json!({ "v": 1, "l": { "GOLD": { "min": 12, "max": 480, "step": 12 } } })
}

fn one_line(qty: i32, limits: Value) -> In {
    In::new(buyer(), vec![line(11, qty, Some(limits))])
}

// ---- min / max / step at their boundaries -----------------------------------

#[test]
fn exactly_at_min_max_and_on_a_step_passes() {
    for q in [12, 24, 480] {
        assert!(one_line(q, case_pack()).errors().is_empty(), "{q}");
    }
}

#[test]
fn one_below_min_fails() {
    assert_eq!(one_line(11, case_pack()).errors(), vec![
        "Quantity for \"P11\" must be at least 12.",
        "Quantity for \"P11\" must be a multiple of 12.",
    ]);
}

#[test]
fn one_above_max_fails() {
    let e = one_line(481, case_pack()).errors();
    assert!(e.contains(&"Quantity for \"P11\" must be at most 480.".to_string()), "{e:?}");
}

#[test]
fn off_step_between_min_and_max_fails_on_step_only() {
    assert_eq!(one_line(13, case_pack()).errors(), vec!["Quantity for \"P11\" must be a multiple of 12."]);
}

#[test]
fn step_alone_is_a_multiple_of_rule() {
    let l = json!({ "v": 1, "l": { "*": { "step": 6 } } });
    assert!(one_line(6, l.clone()).errors().is_empty());
    assert!(one_line(18, l.clone()).errors().is_empty());
    assert_eq!(one_line(7, l).errors(), vec!["Quantity for \"P11\" must be a multiple of 6."]);
}

#[test]
fn quantity_is_the_variant_total_across_lines() {
    let l = case_pack();
    let i = In::new(buyer(), vec![line(11, 6, Some(l.clone())), line(11, 6, Some(l))]);
    assert!(i.errors().is_empty());
}

#[test]
fn a_variant_title_other_than_default_is_named() {
    let mut l = line(11, 1, Some(case_pack()));
    l["merchandise"]["title"] = json!("Large");
    let e = In::new(buyer(), vec![l]).errors();
    assert!(e[0].starts_with("Quantity for \"P11 - Large\""), "{e:?}");
}

// ---- when each rule runs --------------------------------------------------------

#[test]
fn at_cart_interaction_only_maximums_run() {
    let mut i = one_line(1, case_pack());
    i.step = Some("CART_INTERACTION");
    assert!(i.errors().is_empty(), "a minimum must not block building the cart");
    let mut i = one_line(481, case_pack());
    i.step = Some("CART_INTERACTION");
    assert_eq!(i.errors(), vec!["Quantity for \"P11\" must be at most 480."]);
}

#[test]
fn checkout_interaction_and_an_absent_step_run_everything() {
    for step in [Some("CHECKOUT_INTERACTION"), None] {
        let mut i = one_line(1, case_pack());
        i.step = step;
        assert_eq!(i.errors().len(), 2, "{step:?}");
    }
}

// ---- group precedence -------------------------------------------------------------

#[test]
fn the_buyers_first_group_wins_and_wildcard_is_the_fallback() {
    let l = json!({ "v": 1, "l": { "GOLD": { "min": 2 }, "SILVER": { "min": 5 }, "*": { "min": 10 } } });
    let run = |g: Value| In::new(json!({ "v": 1, "g": g }), vec![line(11, 3, Some(l.clone()))]).errors();
    assert!(run(json!(["GOLD", "SILVER"])).is_empty());
    assert_eq!(run(json!(["SILVER", "GOLD"])), vec!["Quantity for \"P11\" must be at least 5."]);
    assert_eq!(run(json!(["BRONZE"])), vec!["Quantity for \"P11\" must be at least 10."]);
}

#[test]
fn the_shop_default_applies_only_when_the_variant_has_no_matching_entry() {
    let mut i = In::new(buyer(), vec![line(11, 3, None)]);
    i.shop = Some(json!({ "v": 1, "d": { "min": 4 } }));
    assert_eq!(i.errors(), vec!["Quantity for \"P11\" must be at least 4."]);
    let mut i = In::new(buyer(), vec![line(11, 3, Some(json!({ "v": 1, "l": { "GOLD": { "max": 9 } } })))]);
    i.shop = Some(json!({ "v": 1, "d": { "min": 4 } }));
    assert!(i.errors().is_empty());
}

#[test]
fn the_customer_dimension_is_enforced_in_addition_to_the_product_dimension() {
    let b = json!({ "v": 1, "g": ["GOLD"], "q": { "11": { "max": 24 } } });
    let e = In::new(b, vec![line(11, 36, Some(case_pack()))]).errors();
    assert_eq!(e, vec!["Quantity for \"P11\" must be at most 24."]);
}

#[test]
fn a_rule_stated_by_both_dimensions_is_reported_once() {
    let b = json!({ "v": 1, "g": ["GOLD"], "d": { "min": 12 } });
    let e = In::new(b, vec![line(11, 1, Some(json!({ "v": 1, "l": { "*": { "min": 12 } } })))]).errors();
    assert_eq!(e, vec!["Quantity for \"P11\" must be at least 12."]);
}

// ---- cart limits and currency ------------------------------------------------------

#[test]
fn cart_minimum_total_is_converted_into_the_presentment_currency() {
    // Shop USD, buyer in CAD at 1.5: a 100 USD minimum is 150 CAD.
    let mut i = In::new(buyer(), vec![line(11, 1, None)]);
    i.shop = Some(json!({ "v": 1, "c": "USD", "l": { "minTotal": 100 } }));
    i.currency = "CAD";
    i.rate = "1.5";
    i.subtotal = "149.99";
    assert_eq!(i.errors(), vec!["Order total must be at least 150.00 CAD."]);
    i.subtotal = "150.0";
    assert!(i.errors().is_empty());
}

#[test]
fn cart_money_in_the_wrong_currency_is_omitted_not_guessed() {
    let mut i = In::new(buyer(), vec![line(11, 1, None)]);
    i.shop = Some(json!({ "v": 1, "c": "EUR", "l": { "minTotal": 1000 } }));
    let (out, omitted) = i.run();
    assert!(messages(&out).is_empty());
    assert!(omitted.render("t").contains("shop_currency_mismatch"));
}

#[test]
fn cart_counts_and_the_buyers_own_cart_limits() {
    let b = json!({ "v": 1, "g": [], "l": { "minUnique": 3, "maxQty": 5 } });
    let e = In::new(b, vec![line(11, 3, None), line(12, 3, None)]).errors();
    assert_eq!(e, vec!["Order may contain at most 5 items.", "Order must include at least 3 unique products."]);
}

// ---- who gets nothing ------------------------------------------------------------

#[test]
fn guests_and_unlinked_customers_get_no_errors_and_no_log() {
    let mut i = one_line(1, case_pack());
    i.guest = true;
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty() && omitted.is_empty());
    let mut i = one_line(1, case_pack());
    i.buyer = None;
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty() && omitted.is_empty());
}

// ---- malformed is omitted, never defaulted -----------------------------------------

#[test]
fn malformed_limits_are_omitted_and_logged_never_defaulted() {
    let cases: Vec<(Value, &str)> = vec![
        (json!({ "v": 2, "l": { "*": { "min": 12 } } }), "limits_version=11"),
        (json!({ "l": { "*": { "min": 12 } } }), "limits_version=11"),
        (json!({ "v": 1, "l": {} }), "limits_limits=11"),
        (json!({ "v": 1, "l": { "*": {} } }), "limits_limit_entry=11"),
        (json!({ "v": 1, "l": { "GOLD": [12] } }), "limits_limit_entry=11"),
        (json!({ "v": 1, "l": { "*": { "min": 0 } } }), "limits_limit_entry=11"),
        (json!({ "v": 1, "l": { "*": { "min": "12" } } }), "limits_limit_entry=11"),
        (json!({ "v": 1, "l": { "*": { "min": 1.5 } } }), "limits_limit_entry=11"),
        (json!({ "v": 1, "l": { "*": { "minimum": 12 } } }), "limits_limit_entry=11"),
        (json!({ "v": 1, "l": { "*": { "min": 12 } }, "x": 1 }), "limits_unknown_key=11"),
    ];
    for (l, expected) in cases {
        let (out, omitted) = one_line(1, l).run();
        assert!(out.operations.is_empty(), "{expected}");
        assert!(omitted.render("t").contains(expected), "{}", omitted.render("t"));
    }
}

#[test]
fn a_malformed_group_entry_does_not_fall_back_to_the_shop_default() {
    let mut i = one_line(1, json!({ "v": 1, "l": { "GOLD": { "min": "12" } } }));
    i.shop = Some(json!({ "v": 1, "d": { "min": 4 } }));
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty());
    assert!(omitted.render("t").contains("limits_limit_entry=11"));
}

#[test]
fn a_malformed_customer_entry_drops_only_the_customer_dimension() {
    let b = json!({ "v": 1, "g": ["GOLD"], "q": { "11": { "max": "x" } } });
    let (out, omitted) = In::new(b, vec![line(11, 1, Some(case_pack()))]).run();
    assert_eq!(messages(&out).len(), 2); // product dimension still enforced
    assert!(omitted.render("t").contains("buyer_limit_entry=11"));
}

#[test]
fn a_malformed_shop_config_is_omitted_but_variant_limits_still_run() {
    let mut i = one_line(1, case_pack());
    i.shop = Some(json!({ "v": 1, "l": { "minTotal": 100 } })); // money without currency
    let (out, omitted) = i.run();
    assert_eq!(messages(&out).len(), 2);
    assert!(omitted.render("t").contains("shop_currency"));
}

#[test]
fn a_malformed_buyer_enforces_nothing_and_is_logged() {
    let mut i = one_line(1, case_pack());
    i.buyer = Some(json!({ "v": 1, "g": "GOLD" }));
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty());
    assert!(omitted.render("t").contains("buyer_groups"));
}

// ---- the 10,000-byte limit --------------------------------------------------------

#[test]
fn a_withheld_limits_metafield_is_indistinguishable_from_absent() {
    // Shopify delivers a value over 10,000 bytes as null
    // (https://shopify.dev/docs/apps/build/metafields/metafield-limits), so
    // the writer must refuse to write one; see the reference writer's tests.
    let (out, omitted) = In::new(buyer(), vec![line(11, 1, None)]).run();
    assert!(out.operations.is_empty() && omitted.is_empty());
}

// ---- the 20 kB output limit ---------------------------------------------------------

#[test]
fn a_cart_breaking_every_rule_lists_at_most_max_errors_and_counts_the_rest() {
    let lines: Vec<Value> = (0..200).map(|n| line(1000 + n, 1, Some(case_pack()))).collect();
    let e = In::new(buyer(), lines).errors();
    assert_eq!(e.len(), MAX_ERRORS);
    // 200 variants x (min + step) = 400 problems; 24 listed, 376 counted.
    assert!(e[MAX_ERRORS - 1].starts_with("376 more order-limit problems."), "{}", e[MAX_ERRORS - 1]);
    let bytes: usize = e.iter().map(|m| m.len() + TARGET.len() + 40).sum();
    assert!(bytes < 20_000, "{bytes}");
}

#[test]
fn exactly_max_errors_are_all_listed_and_one_more_becomes_a_count() {
    let lim = json!({ "v": 1, "l": { "*": { "min": 2 } } });
    let run = |n: u64| In::new(buyer(), (0..n).map(|i| line(1000 + i, 1, Some(lim.clone()))).collect()).errors();
    let e = run(MAX_ERRORS as u64);
    assert_eq!(e.len(), MAX_ERRORS);
    assert!(e.iter().all(|m| m.starts_with("Quantity for")));
    let e = run(MAX_ERRORS as u64 + 1);
    assert_eq!(e.len(), MAX_ERRORS);
    assert!(e[MAX_ERRORS - 1].starts_with("2 more order-limit problems."), "{}", e[MAX_ERRORS - 1]);
}

// ---- catalog visibility (contract v2) --------------------------------------------------

fn allow(groups: &[&str]) -> Value {
    json!({ "v": 2, "a": groups })
}

fn restricted_cart(buyer: Option<Value>, visibility: Value) -> In {
    let mut i = In::new(json!({ "v": 1, "g": [] }), vec![product_line(21, 501, 1, None, Some(visibility))]);
    i.buyer = buyer;
    i
}

#[test]
fn an_entitled_group_buys_a_restricted_product() {
    let i = restricted_cart(Some(json!({ "v": 1, "g": ["SILVER", "GOLD"] })), allow(&["GOLD"]));
    assert!(i.errors().is_empty());
}

#[test]
fn a_linked_buyer_outside_the_allow_list_is_blocked_with_the_product_named() {
    let i = restricted_cart(Some(buyer()), allow(&["platinum"]));
    assert_eq!(i.errors(), vec!["\"P21\" is not available for your account. Remove it from your cart to continue."]);
}

#[test]
fn the_wildcard_allows_any_linked_buyer_and_no_guest() {
    assert!(restricted_cart(Some(buyer()), allow(&["*"])).errors().is_empty());
    let mut guest = restricted_cart(None, allow(&["*"]));
    guest.guest = true;
    assert_eq!(
        guest.errors(),
        vec!["\"P21\" is available to approved wholesale accounts only. Sign in, or remove it from your cart."]
    );
}

#[test]
fn a_signed_in_customer_who_is_not_linked_is_told_about_their_account() {
    let i = restricted_cart(None, allow(&["*"]));
    assert_eq!(i.errors(), vec!["\"P21\" is not available for your account. Remove it from your cart to continue."]);
}

#[test]
fn deny_wins_over_allow_and_a_deny_only_rule_leaves_retail_alone() {
    let both = json!({ "v": 2, "a": ["*"], "d": ["GOLD"] });
    assert_eq!(restricted_cart(Some(buyer()), both).errors().len(), 1);
    // b2c_only: linked buyers may not buy it; guests may.
    let retail = json!({ "v": 2, "d": ["*"] });
    assert_eq!(restricted_cart(Some(buyer()), retail.clone()).errors().len(), 1);
    let mut guest = restricted_cart(None, retail);
    guest.guest = true;
    assert!(guest.errors().is_empty());
}

#[test]
fn visibility_blocks_even_at_cart_interaction() {
    let mut i = restricted_cart(Some(buyer()), allow(&["platinum"]));
    i.step = Some("CART_INTERACTION");
    assert_eq!(i.errors().len(), 1);
}

#[test]
fn two_variants_of_one_restricted_product_are_reported_once() {
    let vis = allow(&["platinum"]);
    let i = In::new(
        buyer(),
        vec![product_line(21, 501, 1, None, Some(vis.clone())), product_line(22, 501, 1, None, Some(vis))],
    );
    assert_eq!(i.errors().len(), 1);
}

#[test]
fn malformed_visibility_is_omitted_and_logged_never_enforced() {
    for (bad, reason) in [
        (json!({ "v": 1, "a": ["gold"] }), "visibility_version=501;"),
        (json!({ "v": 2 }), "visibility_empty=501;"),
        (json!({ "v": 2, "a": [] }), "visibility_allow=501;"),
        (json!({ "v": 2, "d": ["gold", "gold"] }), "visibility_deny=501;"),
        (json!({ "v": 2, "a": ["gold"], "x": 1 }), "visibility_unknown_key=501;"),
    ] {
        let (out, omitted) = restricted_cart(Some(buyer()), bad.clone()).run();
        assert!(out.operations.is_empty(), "{bad}");
        assert!(omitted.render("t").contains(reason), "{bad}: {}", omitted.render("t"));
    }
}

#[test]
fn a_malformed_buyer_is_treated_as_not_linked_for_visibility() {
    let (out, omitted) = restricted_cart(Some(json!({ "v": 1, "g": "gold" })), allow(&["gold"])).run();
    assert_eq!(messages(&out).len(), 1);
    assert!(omitted.render("t").contains("buyer_groups"));
}

#[test]
fn visibility_and_limit_problems_are_listed_together() {
    let i = In::new(
        buyer(),
        vec![product_line(21, 501, 1, None, Some(allow(&["platinum"]))), line(11, 11, Some(case_pack()))],
    );
    assert_eq!(i.errors().len(), 3);
}

// ---- messages in the checkout language ---------------------------------------------------

#[test]
fn every_message_exists_in_every_language_with_its_placeholders() {
    use crate::i18n::{template, LANGUAGES};
    use Msg::*;
    let all = [Max, Min, Step, More, MaxItems, MaxUnique, MinItems, MinUnique, MaxTotal, MinTotal, RestrictedGuest, Restricted];
    for lang in LANGUAGES {
        for m in all {
            let t = template(lang, m);
            let named = matches!(m, Max | Min | Step | RestrictedGuest | Restricted);
            assert_eq!(t.contains("{name}"), named, "{lang} {m:?}");
            assert_eq!(t.contains("{n}"), !matches!(m, RestrictedGuest | Restricted), "{lang} {m:?}");
            if lang != "EN" {
                assert_ne!(t, template("EN", m), "{lang} {m:?} is untranslated");
            }
        }
    }
}

#[test]
fn a_french_checkout_gets_french_messages_with_french_quotes() {
    let mut i = one_line(11, case_pack());
    i.lang = "FR";
    assert_eq!(i.errors(), vec![
        "La quantité de « P11 » doit être d’au moins 12.",
        "La quantité de « P11 » doit être un multiple de 12.",
    ]);
}

#[test]
fn an_unsupported_language_falls_back_to_english() {
    let mut i = one_line(11, case_pack());
    i.lang = "SV";
    assert_eq!(i.errors()[0], "Quantity for \"P11\" must be at least 12.");
}

#[test]
fn a_product_title_containing_a_placeholder_is_not_substituted() {
    let mut l = line(11, 481, Some(case_pack()));
    l["merchandise"]["product"]["title"] = json!("Bolt {n} pack");
    let e = In::new(buyer(), vec![l]).errors();
    assert_eq!(e[0], "Quantity for \"Bolt {n} pack\" must be at most 480.");
}

#[test]
fn money_uses_the_decimal_comma_where_the_language_does() {
    let mut i = In::new(buyer(), vec![line(11, 12, None)]);
    i.shop = Some(json!({ "v": 1, "c": "USD", "l": { "minTotal": 250.5 } }));
    i.lang = "DE";
    assert_eq!(i.errors(), vec!["Der Bestellwert muss mindestens 250,50 USD betragen."]);
    i.lang = "JA";
    assert_eq!(i.errors(), vec!["ご注文の合計金額は250.50 USD以上にしてください。"]);
}
