// Unit tests for the wholesale-shipping Delivery Customization. Inputs are
// built in exactly the shape src/cart_delivery_options_transform_run.graphql
// returns and run through shopify_function's own `run_function_with_input`.

use super::*;
use serde_json::{json, Value};
use shopify_function::run_function_with_input;

fn opt(handle: &str, title: &str, cost: &str) -> Value {
    json!({ "handle": handle, "title": title, "deliveryMethodType": "SHIPPING", "cost": { "amount": cost } })
}

fn pickup(handle: &str) -> Value {
    json!({ "handle": handle, "title": "Pick up in store", "deliveryMethodType": "PICK_UP", "cost": { "amount": "0.0" } })
}

struct In {
    buyer: Option<Value>,
    rules: Option<Value>,
    groups: Vec<Value>,
    subtotal: &'static str,
    currency: &'static str,
    rate: &'static str,
    guest: bool,
}

impl In {
    fn new(rules: Value, options: Vec<Value>) -> Self {
        In {
            buyer: Some(json!({ "v": 1, "g": ["gold"] })),
            rules: Some(rules),
            groups: vec![json!({ "deliveryAddress": { "countryCode": "US" }, "deliveryOptions": options })],
            subtotal: "250.0",
            currency: "USD",
            rate: "1.0",
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
            "deliveryCustomization": { "shippingRules": self.rules.as_ref().map(|r| json!({ "jsonValue": r })) },
            "cart": {
                "cost": { "subtotalAmount": { "amount": self.subtotal, "currencyCode": self.currency } },
                "buyerIdentity": identity,
                "deliveryGroups": self.groups,
            },
        })
        .to_string()
    }
    fn run(&self) -> (Output, Omissions) {
        run_function_with_input(|i: Input| Ok(compute(&i)), &self.json()).unwrap()
    }
    fn ops(&self) -> Vec<String> {
        describe(&self.run().0)
    }
}

/// Operations as short strings, in output order: "hide:x", "rename:x=T", "move:x@0".
fn describe(out: &Output) -> Vec<String> {
    out.operations
        .iter()
        .map(|op| match op {
            schema::Operation::DeliveryOptionHide(h) => format!("hide:{}", h.delivery_option_handle),
            schema::Operation::DeliveryOptionRename(r) => format!("rename:{}={}", r.delivery_option_handle, r.title),
            schema::Operation::DeliveryOptionMove(m) => format!("move:{}@{}", m.delivery_option_handle, m.index),
        })
        .collect()
}

fn rules(rule: Value) -> Value {
    json!({ "v": 2, "c": "USD", "r": [rule] })
}

fn three() -> Vec<Value> {
    vec![opt("std", "Standard", "10.0"), opt("exp", "Express", "25.0"), opt("frt", "LTL Freight", "60.0")]
}

// ---- the cheapest option stays first and selected -------------------------------

#[test]
fn hiding_the_cheapest_option_is_refused_and_logged() {
    let (out, omitted) = In::new(rules(json!({ "a": ["gold"], "t": "none", "h": ["standard", "express"] })), three()).run();
    assert_eq!(describe(&out), vec!["hide:exp"]);
    assert!(omitted.render("x").contains("hide_cheapest_kept"), "{}", omitted.render("x"));
}

#[test]
fn a_cheapest_option_listed_last_is_moved_to_the_front() {
    let options = vec![opt("frt", "LTL Freight", "60.0"), opt("exp", "Express", "25.0"), opt("std", "Standard", "10.0")];
    let ops = In::new(rules(json!({ "a": ["gold"], "t": "none", "n": "Wholesale ground" })), options).ops();
    assert_eq!(ops, vec!["move:std@0", "rename:std=Wholesale ground"]);
}

#[test]
fn sorting_by_price_is_ascending_and_keeps_ties_in_shopify_order() {
    let options = vec![
        opt("frt", "LTL Freight", "60.0"),
        opt("exp", "Express", "25.0"),
        opt("std", "Standard", "10.0"),
        opt("eco", "Economy", "25.0"),
    ];
    let ops = In::new(rules(json!({ "a": ["gold"], "t": "none", "s": "price" })), options).ops();
    assert_eq!(ops, vec!["move:std@0", "move:exp@1", "move:eco@2"]);
}

#[test]
fn equal_cheapest_prices_keep_the_first_listed_as_default() {
    let options = vec![opt("a", "Ground A", "10.0"), opt("b", "Ground B", "10.0"), opt("c", "Express", "20.0")];
    let ops = In::new(rules(json!({ "a": ["gold"], "t": "none", "h": ["ground b"], "s": "price" })), options).ops();
    assert_eq!(ops, vec!["hide:b"]);
}

/// Applies the operations to Shopify's list the way they read: hides remove,
/// moves are applied in output order. Returns the visible handles.
fn apply(handles: &[&str], ops: &[String]) -> Vec<String> {
    let mut list: Vec<String> = handles.iter().map(|h| h.to_string()).collect();
    for op in ops {
        if let Some(h) = op.strip_prefix("hide:") {
            list.retain(|x| x != h);
        } else if let Some(m) = op.strip_prefix("move:") {
            let (h, idx) = m.split_once('@').unwrap();
            let from = list.iter().position(|x| x == h).unwrap();
            let item = list.remove(from);
            list.insert(idx.parse().unwrap(), item);
        }
    }
    list
}

#[test]
fn every_rule_shape_leaves_the_cheapest_visible_and_first() {
    // Exhaustive over hide/rename/sort combinations and every input order of
    // three prices: after the operations, the cheapest option is visible and
    // first, so it is the one checkout selects.
    let perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let base = [("std", "Standard", "10.0"), ("exp", "Express", "25.0"), ("frt", "LTL Freight", "60.0")];
    let hides: [Option<Value>; 4] = [None, Some(json!(["standard"])), Some(json!(["express", "freight"])), Some(json!(["a"]))];
    let mut checked = 0;
    for p in perms {
        for h in &hides {
            for sort in [false, true] {
                let options: Vec<Value> = p.iter().map(|&i| opt(base[i].0, base[i].1, base[i].2)).collect();
                let handles: Vec<&str> = p.iter().map(|&i| base[i].0).collect();
                let mut rule = json!({ "a": ["gold"], "t": "none", "n": "Wholesale" });
                if let Some(h) = h {
                    rule["h"] = h.clone();
                }
                if sort {
                    rule["s"] = json!("price");
                }
                let ops = In::new(rules(rule), options).ops();
                let visible = apply(&handles, &ops);
                assert_eq!(visible.first().map(|s| s.as_str()), Some("std"), "{p:?} {h:?} {ops:?}");
                if sort {
                    let cost = |h: &str| base.iter().find(|b| b.0 == h).unwrap().2.parse::<f64>().unwrap();
                    assert!(visible.windows(2).all(|w| cost(&w[0]) <= cost(&w[1])), "{visible:?}");
                }
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 48);
}

// ---- who it applies to --------------------------------------------------------------

#[test]
fn a_guest_gets_nothing() {
    let mut i = In::new(rules(json!({ "a": ["*"], "t": "none", "h": ["express"] })), three());
    i.guest = true;
    assert!(i.ops().is_empty());
}

#[test]
fn an_unlinked_customer_gets_nothing() {
    let mut i = In::new(rules(json!({ "a": ["*"], "t": "none", "h": ["express"] })), three());
    i.buyer = None;
    assert!(i.ops().is_empty());
}

#[test]
fn a_buyer_outside_the_rule_audience_gets_nothing() {
    let i = In::new(rules(json!({ "a": ["silver"], "t": "none", "h": ["express"] })), three());
    assert!(i.ops().is_empty());
}

#[test]
fn the_wildcard_audience_is_any_linked_buyer() {
    let i = In::new(rules(json!({ "a": ["*"], "t": "none", "h": ["express"] })), three());
    assert_eq!(i.ops(), vec!["hide:exp"]);
}

#[test]
fn a_country_restricted_rule_needs_a_known_listed_destination() {
    let rule = rules(json!({ "a": ["gold"], "k": ["CA"], "t": "none", "h": ["express"] }));
    assert!(In::new(rule.clone(), three()).ops().is_empty());
    let mut ca = In::new(rule.clone(), three());
    ca.groups[0]["deliveryAddress"] = json!({ "countryCode": "CA" });
    assert_eq!(ca.ops(), vec!["hide:exp"]);
    let mut unknown = In::new(rule, three());
    unknown.groups[0]["deliveryAddress"] = Value::Null;
    assert!(unknown.ops().is_empty());
}

#[test]
fn free_above_unmet_skips_a_free_rule_and_the_next_rule_decides() {
    let doc = json!({ "v": 2, "c": "USD", "r": [
        { "a": ["gold"], "t": "free", "fa": 500, "n": "Free wholesale shipping" },
        { "a": ["gold"], "t": "flat", "f": 12, "n": "Wholesale ground" },
    ]});
    assert_eq!(In::new(doc.clone(), three()).ops(), vec!["rename:std=Wholesale ground"]);
    let mut big = In::new(doc, three());
    big.subtotal = "500.0";
    assert_eq!(big.ops(), vec!["rename:std=Free wholesale shipping"]);
}

#[test]
fn a_rule_with_matches_renames_the_matching_options() {
    let rule = rules(json!({ "a": ["gold"], "t": "none", "m": ["freight"], "n": "Pallet freight" }));
    assert_eq!(In::new(rule, three()).ops(), vec!["rename:frt=Pallet freight"]);
}

#[test]
fn pickup_and_local_options_are_never_touched() {
    let options = vec![opt("exp", "Express", "25.0"), pickup("pk"), opt("std", "Standard", "10.0")];
    let (out, omitted) =
        In::new(rules(json!({ "a": ["gold"], "t": "none", "h": ["pick up"], "n": "Wholesale" })), options).run();
    // "Pick up in store" matches "pick up" but is not a SHIPPING option, so it
    // is not hidden. The cheapest shipping option is not first, but the group
    // is mixed, so it is not reordered, and that is logged.
    assert_eq!(describe(&out), vec!["rename:std=Wholesale"]);
    assert!(omitted.render("x").contains("mixed_group_not_sorted"), "{}", omitted.render("x"));
}

// ---- malformed is omitted and logged -------------------------------------------------

#[test]
fn a_v1_envelope_on_shipping_rules_is_a_version_error() {
    let (out, omitted) = In::new(json!({ "v": 1, "c": "USD", "r": [{ "a": ["gold"], "t": "none", "h": ["x"] }] }), three()).run();
    assert!(out.operations.is_empty());
    assert_eq!(omitted.render("x"), "x omitted: rules_version;");
}

#[test]
fn an_unknown_rule_key_is_malformed() {
    let (out, omitted) = In::new(rules(json!({ "a": ["gold"], "t": "none", "h": ["x"], "z": 1 })), three()).run();
    assert!(out.operations.is_empty());
    assert_eq!(omitted.render("x"), "x omitted: rules_rule;");
}

#[test]
fn a_currency_mismatch_applies_nothing() {
    let mut i = In::new(rules(json!({ "a": ["gold"], "t": "none", "h": ["express"] })), three());
    i.currency = "CAD";
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty());
    assert!(omitted.render("x").contains("currency_mismatch"));
}

#[test]
fn a_malformed_buyer_is_logged_and_gets_nothing() {
    let mut i = In::new(rules(json!({ "a": ["*"], "t": "none", "h": ["express"] })), three());
    i.buyer = Some(json!({ "v": 1, "g": ["*"] }));
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty());
    assert_eq!(omitted.render("x"), "x omitted: buyer_groups;");
}

#[test]
fn rule_type_amount_fields_are_exclusive() {
    for bad in [
        json!({ "a": ["gold"], "t": "none", "f": 1 }),
        json!({ "a": ["gold"], "t": "none", "fa": 1 }),
        json!({ "a": ["gold"], "t": "flat" }),
        json!({ "a": ["gold"], "t": "flat", "f": 1, "p": 5 }),
        json!({ "a": ["gold"], "t": "pct", "p": 100.0001 }),
        json!({ "a": ["gold"], "t": "tier", "tr": [[10, 5, 1]] }),
        json!({ "a": ["gold"], "t": "tier", "tr": [[0, null]] }),
        json!({ "a": ["gold"], "t": "express" }),
        json!({ "a": [], "t": "free" }),
        json!({ "a": ["gold"], "t": "free", "k": ["us"] }),
        json!({ "a": ["gold"], "t": "free", "s": "name" }),
        json!({ "a": ["gold"], "t": "free", "n": "  " }),
    ] {
        let (_, omitted) = In::new(rules(bad.clone()), three()).run();
        assert_eq!(omitted.render("x"), "x omitted: rules_rule;", "{bad}");
    }
}

// ---- conformance with TackQuote's evaluation and the currency rules ---------------

#[test]
fn presentment_conversion_applies_to_the_free_above_threshold() {
    // 500 USD free-above at 1.35 CAD/USD is 675 CAD.
    let doc = rules(json!({ "a": ["gold"], "t": "free", "fa": 500, "n": "Free" }));
    let mut under = In::new(doc.clone(), three());
    under.currency = "CAD";
    under.rate = "1.35";
    under.subtotal = "674.99";
    assert!(under.ops().is_empty());
    let mut at = In::new(doc, three());
    at.currency = "CAD";
    at.rate = "1.35";
    at.subtotal = "675.0";
    assert_eq!(at.ops(), vec!["rename:std=Free"]);
}

// ---- the shared conformance corpus -------------------------------------------------------

#[test]
fn the_shared_shipping_rules_corpus_resolves_as_the_js_reference_and_tackquote_do() {
    use crate::contract::{amount_to_units, read_shipping_rules, resolve_shipping, Buyer, ShippingFacts, UNIT};
    let corpus: Value = serde_json::from_str(include_str!("../../../contract/conformance/shipping-rules.json")).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 12);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        // Parse through the real lazy reader: run a function whose only job is
        // to read the document and resolve it.
        let input = json!({
            "presentmentCurrencyRate": "1.0",
            "deliveryCustomization": { "shippingRules": { "jsonValue": c["doc"] } },
            "cart": {
                "cost": { "subtotalAmount": { "amount": "0.0", "currencyCode": "USD" } },
                "buyerIdentity": { "customer": { "buyer": { "jsonValue": { "v": 1, "g": c["groups"] } } } },
                "deliveryGroups": [],
            },
        });
        let got = run_function_with_input(
            |i: Input| {
                let doc = match read_shipping_rules(i.delivery_customization().shipping_rules().map(|m| m.json_value())) {
                    Parsed::Ok(d) => d,
                    other => panic!("{name}: {:?}", matches!(other, Parsed::Absent)),
                };
                let buyer: Buyer = match crate::contract::read_buyer(
                    i.cart().buyer_identity().and_then(|b| b.customer()).and_then(|c| c.buyer()).map(|m| m.json_value()),
                ) {
                    Parsed::Ok(b) => b,
                    _ => panic!("{name}: buyer"),
                };
                let facts = ShippingFacts {
                    subtotal: amount_to_units(c["subtotal"].as_f64().unwrap()).unwrap(),
                    presentment: c["currency"].as_str().unwrap(),
                    rate: c["rate"].as_f64().unwrap(),
                    country: c["country"].as_str(),
                };
                Ok(match resolve_shipping(&doc, &buyer, &facts) {
                    Err(_) => Value::Null,
                    Ok(r) => {
                        let index = |rule: &crate::contract::ShippingRule| doc.rules.iter().position(|x| x == rule).unwrap();
                        json!({
                            "rate": r.rate.map(|(rule, a)| json!([index(rule), a as f64 / UNIT as f64])),
                            "presentation": r.presentation.map(index),
                        })
                    }
                })
            },
            &input.to_string(),
        )
        .unwrap();
        // JSON 0 and 0.0 are different serde values; compare amounts as numbers.
        let mut want = c["expect"].clone();
        if let Some(a) = want.pointer_mut("/rate/1") {
            *a = json!(a.as_f64().unwrap());
        }
        assert_eq!(got, want, "{name}");
    }
}

// ---- the 20 kB output limit ---------------------------------------------------------------

#[test]
fn a_huge_cart_stays_under_the_output_limit_and_keeps_every_emitted_group_cheapest_first() {
    // 12 groups x 25 options with realistic 65-character handles, reversed so
    // every group needs a full price sort, plus hides and renames.
    let handle = |g: usize, i: usize| format!("{:032x}-{:032x}", g, i);
    let groups: Vec<Value> = (0..12)
        .map(|g| {
            let options: Vec<Value> = (0..25)
                .rev()
                .map(|i| opt(&handle(g, i), if i % 4 == 3 { "Express" } else { "Ground" }, &format!("{}.0", 10 + i)))
                .collect();
            json!({ "deliveryAddress": { "countryCode": "US" }, "deliveryOptions": options })
        })
        .collect();
    let mut i = In::new(rules(json!({ "a": ["gold"], "t": "none", "h": ["express"], "n": "Wholesale ground", "m": ["ground"], "s": "price" })), vec![]);
    i.groups = groups;
    let (out, omitted) = i.run();
    let json_bytes = serde_json::to_string(&describe(&out)).unwrap().len() + out.operations.len() * 60;
    assert!(json_bytes < 20_000, "{json_bytes}");
    assert!(omitted.render("x").contains("output_budget"));
    // Group by handle prefix and replay: any group that got operations has its
    // cheapest option (index 0 in handle numbering) first.
    for g in 0..12 {
        let prefix = format!("{:032x}-", g);
        let ops: Vec<String> = describe(&out).into_iter().filter(|o| o.contains(&prefix)).collect();
        if ops.is_empty() {
            continue;
        }
        let handles: Vec<String> = (0..25).rev().map(|i| handle(g, i)).collect();
        let refs: Vec<&str> = handles.iter().map(|h| h.as_str()).collect();
        let visible = apply(&refs, &ops);
        assert_eq!(visible[0], handle(g, 0), "group {g}: {ops:?}");
    }
}

// ---- App Store 1.1.10, per delivery group ------------------------------------------
//
// "Shipping must default to the lowest-priced option"
// (https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices), and
// DeliveryOptionMoveOperation: "The cheapest shipping delivery option must
// always be the first option selected"
// (https://shopify.dev/docs/api/functions/2026-07/delivery-customization).
// Checked per group, across several groups in one cart, with pickup in the mix.

#[test]
fn no_group_ever_gets_a_pricier_option_first_or_loses_every_option() {
    let perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let base = [("std", "Standard", "10.0"), ("exp", "Express", "25.0"), ("frt", "LTL Freight", "60.0")];
    let cost = |h: &str| -> Option<f64> {
        base.iter().find(|b| h.ends_with(b.0)).map(|b| b.2.parse::<f64>().unwrap())
    };
    // Every hide list, including one that matches EVERY shipping title.
    let hides: [Option<Value>; 5] = [
        None,
        Some(json!(["standard"])),
        Some(json!(["express", "freight"])),
        Some(json!(["standard", "express", "freight"])),
        Some(json!(["pick up"])),
    ];
    // Where a pickup option sits in each of the three groups: none, first, middle.
    let layouts: [Option<usize>; 3] = [None, Some(0), Some(1)];
    let mut checked = 0;
    for p in perms {
        for h in &hides {
            for sort in [false, true] {
                // One cart, three groups, same rule: a group's operations must
                // hold on their own, whatever the others need.
                let mut groups = Vec::new();
                let mut lists: Vec<Vec<String>> = Vec::new();
                for (g, layout) in layouts.iter().enumerate() {
                    let mut options: Vec<Value> = Vec::new();
                    let mut handles: Vec<String> = Vec::new();
                    for &i in &p {
                        let handle = format!("g{g}-{}", base[i].0);
                        options.push(opt(&handle, base[i].1, base[i].2));
                        handles.push(handle);
                    }
                    if let Some(at) = layout {
                        let handle = format!("g{g}-pk");
                        options.insert(*at, pickup(&handle));
                        handles.insert(*at, handle);
                    }
                    groups.push(json!({ "deliveryAddress": { "countryCode": "US" }, "deliveryOptions": options }));
                    lists.push(handles);
                }
                let mut rule = json!({ "a": ["gold"], "t": "none", "n": "Wholesale" });
                if let Some(h) = h {
                    rule["h"] = h.clone();
                }
                if sort {
                    rule["s"] = json!("price");
                }
                let mut input = In::new(rules(rule), vec![]);
                input.groups = groups;
                let all_ops = input.ops();

                for (g, handles) in lists.iter().enumerate() {
                    let prefix = format!("g{g}-");
                    let ops: Vec<String> = all_ops.iter().filter(|o| o.contains(&prefix)).cloned().collect();
                    let refs: Vec<&str> = handles.iter().map(|s| s.as_str()).collect();
                    let visible = apply(&refs, &ops);
                    let ctx = format!("group {g} {p:?} {h:?} sort={sort} {ops:?}");
                    let cheapest = format!("g{g}-std");
                    // Never every option hidden, and never the cheapest shipping option.
                    assert!(!visible.is_empty(), "{ctx}");
                    assert!(visible.contains(&cheapest), "{ctx}");
                    // Pickup is never hidden or moved.
                    assert!(!ops.iter().any(|o| o.contains("-pk")), "{ctx}");
                    // Whatever is first after the operations: if the operations
                    // changed it, it costs no more than the cheapest shipping
                    // option (it is that option, or the free pickup that a hide
                    // uncovered).
                    if visible[0] != handles[0] {
                        let first_cost = if visible[0].ends_with("-pk") { Some(0.0) } else { cost(&visible[0]) };
                        assert!(first_cost <= cost(&cheapest), "{ctx}");
                    }
                    // Only the cheapest is ever moved to the front.
                    for o in &ops {
                        if let Some(m) = o.strip_prefix("move:") {
                            if m.ends_with("@0") {
                                assert_eq!(m, format!("{cheapest}@0"), "{ctx}");
                            }
                        }
                    }
                    // A group of shipping options only: the cheapest IS first.
                    if layouts[g].is_none() {
                        assert_eq!(visible[0], cheapest, "{ctx}");
                    }
                    // No visible SHIPPING option ahead of the cheapest is one the
                    // operations moved there.
                    let first_shipping = visible.iter().find(|x| !x.ends_with("-pk")).unwrap();
                    if first_shipping != &cheapest {
                        let moved_ahead = ops.iter().any(|o| o.starts_with(&format!("move:{first_shipping}@")));
                        assert!(!moved_ahead, "{ctx}");
                        assert!(cost(first_shipping) > cost(&cheapest), "{ctx}");
                    }
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 6 * 5 * 2 * 3);
}
