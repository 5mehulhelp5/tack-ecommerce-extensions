// Unit tests for the wholesale shipping-rate discount. Inputs are built in
// exactly the shape src/cart_delivery_options_discounts_generate_run.graphql
// returns and run through shopify_function's own `run_function_with_input`.

use super::*;
use serde_json::{json, Value};
use shopify_function::run_function_with_input;

fn opt(handle: &str, title: &str, cost: &str) -> Value {
    json!({ "handle": handle, "title": title, "deliveryMethodType": "SHIPPING", "cost": { "amount": cost } })
}

struct In {
    buyer: Option<Value>,
    rules: Option<Value>,
    options: Vec<Value>,
    country: Option<&'static str>,
    subtotal: &'static str,
    currency: &'static str,
    rate: &'static str,
    classes: Vec<&'static str>,
    lang: &'static str,
    guest: bool,
}

impl In {
    fn new(rules: Value) -> Self {
        In {
            buyer: Some(json!({ "v": 1, "g": ["gold"] })),
            rules: Some(rules),
            options: vec![opt("std", "Standard", "10.0"), opt("exp", "Express", "25.0"), opt("frt", "LTL Freight", "60.0")],
            country: Some("US"),
            subtotal: "250.0",
            currency: "USD",
            rate: "1.0",
            classes: vec!["SHIPPING"],
            lang: "EN",
            guest: false,
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
            "discount": {
                "discountClasses": self.classes,
                "shippingRules": self.rules.as_ref().map(|r| json!({ "jsonValue": r })),
            },
            "cart": {
                "cost": { "subtotalAmount": { "amount": self.subtotal, "currencyCode": self.currency } },
                "buyerIdentity": identity,
                "deliveryGroups": [{
                    "deliveryAddress": self.country.map(|c| json!({ "countryCode": c })),
                    "deliveryOptions": self.options,
                }],
            },
        })
        .to_string()
    }
    fn run(&self) -> (Output, Omissions) {
        run_function_with_input(|i: Input| Ok(compute(&i)), &self.json()).unwrap()
    }
    /// "handle-amount" per candidate, amounts in currency units.
    fn cuts(&self) -> Vec<String> {
        let mut v = Vec::new();
        for op in &self.run().0.operations {
            let add = match op {
                schema::DeliveryOperation::DeliveryDiscountsAdd(add) => add,
                _ => panic!("unexpected operation"),
            };
            assert!(matches!(add.selection_strategy, schema::DeliveryDiscountSelectionStrategy::All));
            for c in &add.candidates {
                let schema::DeliveryDiscountCandidateTarget::DeliveryOption(t) = &c.targets[0] else {
                    panic!("group target")
                };
                let schema::DeliveryDiscountCandidateValue::FixedAmount(f) = &c.value else { panic!("percentage") };
                v.push(format!("{}-{}", t.handle, f.amount.0));
            }
        }
        v
    }
}

fn rules(rule: Value) -> Value {
    json!({ "v": 2, "c": "USD", "r": [rule] })
}

// ---- TackQuote's rate types -------------------------------------------------------

#[test]
fn flat_rate_lowers_the_default_option_to_the_rate() {
    assert_eq!(In::new(rules(json!({ "a": ["gold"], "t": "flat", "f": 4.5 }))).cuts(), vec!["std-5.5"]);
}

#[test]
fn free_makes_the_default_option_free() {
    assert_eq!(In::new(rules(json!({ "a": ["gold"], "t": "free" }))).cuts(), vec!["std-10"]);
}

#[test]
fn free_above_met_is_free_whatever_the_type() {
    let doc = rules(json!({ "a": ["gold"], "t": "flat", "f": 8, "fa": 250 }));
    assert_eq!(In::new(doc.clone()).cuts(), vec!["std-10"]);
    let mut under = In::new(doc);
    under.subtotal = "249.99";
    assert_eq!(under.cuts(), vec!["std-2"]);
}

#[test]
fn free_with_an_unmet_threshold_does_not_apply_and_the_next_rule_does() {
    let doc = json!({ "v": 2, "c": "USD", "r": [
        { "a": ["gold"], "t": "free", "fa": 500 },
        { "a": ["gold"], "t": "flat", "f": 7 },
    ]});
    assert_eq!(In::new(doc).cuts(), vec!["std-3"]);
}

#[test]
fn percentage_is_that_share_of_the_subtotal() {
    // 2% of 250 = 5.
    assert_eq!(In::new(rules(json!({ "a": ["gold"], "t": "pct", "p": 2 }))).cuts(), vec!["std-5"]);
    // 1.2345% of 250 = 3.08625 -> 3.0863 (TackQuote round4).
    assert_eq!(In::new(rules(json!({ "a": ["gold"], "t": "pct", "p": 1.2345 }))).cuts(), vec!["std-6.9137"]);
}

#[test]
fn tiered_uses_the_first_tier_holding_the_subtotal_inclusive() {
    let doc = rules(json!({ "a": ["gold"], "t": "tier", "tr": [[0, 250, 6], [250.0001, null, 2]] }));
    assert_eq!(In::new(doc.clone()).cuts(), vec!["std-4"]);
    let mut more = In::new(doc);
    more.subtotal = "250.01";
    assert_eq!(more.cuts(), vec!["std-8"]);
}

#[test]
fn a_tiered_rule_with_no_holding_tier_does_not_apply() {
    let doc = json!({ "v": 2, "c": "USD", "r": [
        { "a": ["gold"], "t": "tier", "tr": [[1000, null, 0]] },
        { "a": ["gold"], "t": "flat", "f": 9 },
    ]});
    assert_eq!(In::new(doc).cuts(), vec!["std-1"]);
}

#[test]
fn a_rate_above_the_price_is_not_a_surcharge() {
    assert!(In::new(rules(json!({ "a": ["gold"], "t": "flat", "f": 12 }))).cuts().is_empty());
}

#[test]
fn a_none_rule_never_prices_and_is_skipped() {
    let doc = json!({ "v": 2, "c": "USD", "r": [
        { "a": ["gold"], "t": "none", "h": ["express"] },
        { "a": ["gold"], "t": "free" },
    ]});
    assert_eq!(In::new(doc).cuts(), vec!["std-10"]);
}

// ---- which options, and the cheapest-stays-default guarantee ----------------------

#[test]
fn matched_options_get_the_rate_but_never_undercut_the_default() {
    // Freight at a 5.00 wholesale rate would undercut Standard (10.00, the
    // default). It is lowered only to 10.00.
    let doc = rules(json!({ "a": ["gold"], "t": "flat", "f": 5, "m": ["freight"] }));
    assert_eq!(In::new(doc).cuts(), vec!["frt-50"]);
}

#[test]
fn matching_the_default_too_lets_every_matched_option_reach_the_rate() {
    let doc = rules(json!({ "a": ["gold"], "t": "flat", "f": 5, "m": ["standard", "freight"] }));
    assert_eq!(In::new(doc).cuts(), vec!["std-5", "frt-55"]);
}

#[test]
fn the_cheapest_option_ends_cheapest_for_every_rate_and_match() {
    let costs = [("std", 10.0), ("exp", 25.0), ("frt", 60.0)];
    let mut checked = 0;
    for f in [0.0, 4.0, 10.0, 15.0, 30.0, 70.0] {
        for m in [None, Some(json!(["express"])), Some(json!(["freight", "express"])), Some(json!(["standard"]))] {
            let mut rule = json!({ "a": ["gold"], "t": "flat", "f": f });
            if let Some(m) = &m {
                rule["m"] = m.clone();
            }
            let cuts = In::new(rules(rule)).cuts();
            let finals: Vec<f64> = costs
                .iter()
                .map(|(h, c)| {
                    let off = cuts
                        .iter()
                        .find_map(|x| x.strip_prefix(&format!("{h}-")).map(|a| a.parse::<f64>().unwrap()))
                        .unwrap_or(0.0);
                    assert!(off >= 0.0 && off <= *c, "{cuts:?}");
                    c - off
                })
                .collect();
            assert!(finals[0] <= finals[1] && finals[0] <= finals[2], "f={f} m={m:?} {finals:?}");
            checked += 1;
        }
    }
    assert_eq!(checked, 24);
}

// ---- who it applies to ------------------------------------------------------------------

#[test]
fn guests_unlinked_and_other_groups_get_nothing() {
    let doc = rules(json!({ "a": ["gold"], "t": "free" }));
    let mut guest = In::new(doc.clone());
    guest.guest = true;
    assert!(guest.cuts().is_empty());
    let mut unlinked = In::new(doc.clone());
    unlinked.buyer = None;
    assert!(unlinked.cuts().is_empty());
    let mut silver = In::new(doc);
    silver.buyer = Some(json!({ "v": 1, "g": ["silver"] }));
    assert!(silver.cuts().is_empty());
}

#[test]
fn without_the_shipping_class_nothing_is_discounted() {
    let mut i = In::new(rules(json!({ "a": ["gold"], "t": "free" })));
    i.classes = vec!["PRODUCT"];
    assert!(i.cuts().is_empty());
}

#[test]
fn country_rules_need_a_known_listed_destination() {
    let doc = rules(json!({ "a": ["*"], "k": ["US", "CA"], "t": "free" }));
    assert_eq!(In::new(doc.clone()).cuts(), vec!["std-10"]);
    let mut gb = In::new(doc.clone());
    gb.country = Some("GB");
    assert!(gb.cuts().is_empty());
    let mut unknown = In::new(doc);
    unknown.country = None;
    assert!(unknown.cuts().is_empty());
}

// ---- currency ---------------------------------------------------------------------------

#[test]
fn shop_currency_amounts_are_converted_to_presentment() {
    // 4 USD at 1.35 = 5.40 CAD; the option costs 10 CAD.
    let mut i = In::new(rules(json!({ "a": ["gold"], "t": "flat", "f": 4 })));
    i.currency = "CAD";
    i.rate = "1.35";
    assert_eq!(i.cuts(), vec!["std-4.6"]);
}

#[test]
fn a_currency_mismatch_is_logged_and_prices_nothing() {
    let mut i = In::new(rules(json!({ "a": ["gold"], "t": "free" })));
    i.currency = "CAD";
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty());
    assert_eq!(omitted.render("x"), "x omitted: currency_mismatch;");
}

// ---- messages ---------------------------------------------------------------------------

#[test]
fn the_message_follows_the_buyer_language_and_falls_back_to_english() {
    for (lang, want) in [
        ("EN", "Wholesale shipping"),
        ("FR", "Tarif de livraison professionnel"),
        ("DE", "Großhandelsversand"),
        ("ES", "Envío mayorista"),
        ("IT", "Spedizione all’ingrosso"),
        ("NL", "Groothandelsverzending"),
        ("PT_BR", "Frete de atacado"),
        ("JA", "卸売向け配送"),
        ("SV", "Wholesale shipping"),
    ] {
        let mut i = In::new(rules(json!({ "a": ["gold"], "t": "free" })));
        i.lang = lang;
        let (out, _) = i.run();
        let schema::DeliveryOperation::DeliveryDiscountsAdd(add) = &out.operations[0] else {
            panic!("unexpected operation")
        };
        assert_eq!(add.candidates[0].message.as_deref(), Some(want), "{lang}");
    }
}

#[test]
fn a_malformed_document_is_logged_and_prices_nothing() {
    let (out, omitted) = In::new(json!({ "v": 2, "c": "USD", "r": [] })).run();
    assert!(out.operations.is_empty());
    assert_eq!(omitted.render("x"), "x omitted: rules_rules;");
}

// ---- the 20 kB output limit ---------------------------------------------------------------

#[test]
fn a_huge_cart_drops_whole_groups_to_stay_under_the_output_limit() {
    let handle = |g: usize, i: usize| format!("{:032x}-{:032x}", g, i);
    let mut i = In::new(rules(json!({ "a": ["gold"], "t": "flat", "f": 1, "m": ["ground"] })));
    let groups: Vec<Value> = (0..12)
        .map(|g| {
            let options: Vec<Value> = (0..25).map(|n| opt(&handle(g, n), "Ground", &format!("{}.0", 10 + n))).collect();
            json!({ "deliveryAddress": { "countryCode": "US" }, "deliveryOptions": options })
        })
        .collect();
    let input: Value = serde_json::from_str(&i.json()).unwrap();
    let mut input = input;
    input["cart"]["deliveryGroups"] = json!(groups);
    i.options = vec![];
    let (out, omitted) = run_function_with_input(|x: Input| Ok(compute(&x)), &input.to_string()).unwrap();
    assert!(omitted.render("x").contains("output_budget"));
    let schema::DeliveryOperation::DeliveryDiscountsAdd(add) = &out.operations[0] else { panic!() };
    // Every group is all-or-nothing: 25 candidates per included group.
    assert_eq!(add.candidates.len() % 25, 0, "{}", add.candidates.len());
    assert!(!add.candidates.is_empty());
    let approx: usize = add.candidates.len() * (65 + 18 + 150);
    assert!(approx < 20_000, "{approx}");
}
