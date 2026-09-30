// Unit tests for the wholesale pricing Discount Function. Inputs are built in
// exactly the shape src/cart_lines_discounts_generate_run.graphql returns and
// run through shopify_function's own `run_function_with_input`.

use super::*;
use serde_json::{json, Value};
use shopify_function::run_function_with_input;

fn line(n: u32, variant: u64, qty: i32, retail: &str, currency: &str, tiers: Option<Value>) -> Value {
    json!({
        "id": format!("gid://shopify/CartLine/{n}"),
        "quantity": qty,
        "cost": { "amountPerQuantity": { "amount": retail, "currencyCode": currency } },
        "merchandise": {
            "__typename": "ProductVariant",
            "id": format!("gid://shopify/ProductVariant/{variant}"),
            "priceTiers": tiers.map(|t| json!({ "jsonValue": t })),
        }
    })
}

fn usd(n: u32, variant: u64, qty: i32, retail: &str, tiers: &Value) -> Value {
    line(n, variant, qty, retail, "USD", Some(tiers.clone()))
}

struct In {
    buyer: Option<Value>,
    lines: Vec<Value>,
    rate: &'static str,
    classes: Vec<&'static str>,
    guest: bool,
}

impl In {
    fn new(buyer: Value, lines: Vec<Value>) -> Self {
        In { buyer: Some(buyer), lines, rate: "1.0", classes: vec!["PRODUCT"], guest: false }
    }
    fn json(&self) -> String {
        let identity = if self.guest {
            Value::Null
        } else {
            json!({ "customer": { "buyer": self.buyer.as_ref().map(|b| json!({ "jsonValue": b })) } })
        };
        json!({
            "presentmentCurrencyRate": self.rate,
            "discount": { "discountClasses": self.classes },
            "cart": { "buyerIdentity": identity, "lines": self.lines },
        })
        .to_string()
    }
    fn run(&self) -> (Output, Omissions) {
        run_function_with_input(|i: Input| Ok(compute(&i)), &self.json()).unwrap()
    }
}

/// (cart line number, per-unit amount off) for every targeted line, in line
/// order.
fn amounts(out: &Output) -> Vec<(String, f64)> {
    let mut v = Vec::new();
    for op in &out.operations {
        let schema::CartOperation::ProductDiscountsAdd(add) = op else { panic!("unexpected operation") };
        assert_eq!(add.selection_strategy, schema::ProductDiscountSelectionStrategy::All);
        for c in &add.candidates {
            assert_eq!(c.message, None);
            let schema::ProductDiscountCandidateValue::FixedAmount(f) = &c.value else { panic!("unexpected value") };
            assert_eq!(f.applies_to_each_item, Some(true));
            // CartLine is the only variant of this oneOf in 2026-07.
            for schema::ProductDiscountCandidateTarget::CartLine(t) in &c.targets {
                v.push((t.id.trim_start_matches("gid://shopify/CartLine/").to_string(), f.amount.0));
            }
        }
    }
    v.sort_by_key(|(id, _)| id.parse::<u64>().unwrap_or(u64::MAX));
    v
}

fn one(id: &str, amount: f64) -> Vec<(String, f64)> {
    vec![(id.to_string(), amount)]
}

fn gold_ladder() -> Value {
    json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, 9], [10, 8], [50, 7]] } })
}

fn gold_buyer() -> Value {
    json!({ "v": 1, "g": ["GOLD"] })
}

fn single(qty: i32, tiers: Value, buyer: Value) -> (Output, Omissions) {
    In::new(buyer, vec![usd(1, 11, qty, "10.0", &tiers)]).run()
}

fn log(o: &Omissions) -> String {
    o.render("t")
}

// ---- tier selection at boundaries ----------------------------------------

#[test]
fn one_below_a_break_stays_on_the_lower_tier() {
    assert_eq!(amounts(&single(9, gold_ladder(), gold_buyer()).0), one("1", 1.0));
}

#[test]
fn exactly_at_a_break_takes_that_break() {
    assert_eq!(amounts(&single(10, gold_ladder(), gold_buyer()).0), one("1", 2.0));
}

#[test]
fn one_below_the_next_break_keeps_the_current_tier() {
    assert_eq!(amounts(&single(49, gold_ladder(), gold_buyer()).0), one("1", 2.0));
}

#[test]
fn the_top_break_applies_from_its_minimum_upward() {
    assert_eq!(amounts(&single(50, gold_ladder(), gold_buyer()).0), one("1", 3.0));
    assert_eq!(amounts(&single(5000, gold_ladder(), gold_buyer()).0), one("1", 3.0));
}

#[test]
fn below_the_first_break_of_the_only_ladder_gives_nothing() {
    let t = json!({ "v": 1, "c": "USD", "t": { "GOLD": [[10, 8]] } });
    assert!(single(9, t, gold_buyer()).0.operations.is_empty());
}

#[test]
fn quantity_is_the_variant_total_across_lines_and_every_line_is_discounted() {
    let t = gold_ladder();
    let (out, _) = In::new(gold_buyer(), vec![usd(1, 11, 6, "10.0", &t), usd(2, 11, 6, "10.0", &t)]).run();
    assert_eq!(amounts(&out), vec![("1".into(), 2.0), ("2".into(), 2.0)]);
}

#[test]
fn four_decimal_prices_subtract_exactly() {
    let t = json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, 8.3333]] } });
    assert_eq!(amounts(&single(1, t, gold_buyer()).0), one("1", 1.6667));
}

// ---- never raises a price --------------------------------------------------

#[test]
fn a_tier_equal_to_or_above_retail_is_skipped() {
    for p in [10.0, 12.0] {
        let t = json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, p]] } });
        assert!(single(1, t, gold_buyer()).0.operations.is_empty());
    }
}

// ---- multi-group precedence ------------------------------------------------

fn multi() -> Value {
    json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, 8]], "SILVER": [[1, 9]], "*": [[1, 9.5]] } })
}

#[test]
fn the_customers_first_group_wins_over_a_later_one() {
    let b = json!({ "v": 1, "g": ["SILVER", "GOLD"] });
    assert_eq!(amounts(&single(1, multi(), b).0), one("1", 1.0));
}

#[test]
fn order_in_g_is_the_precedence_not_the_lowest_price() {
    let b = json!({ "v": 1, "g": ["GOLD", "SILVER"] });
    assert_eq!(amounts(&single(1, multi(), b).0), one("1", 2.0));
}

#[test]
fn a_group_with_no_ladder_for_this_variant_falls_to_wildcard() {
    let b = json!({ "v": 1, "g": ["BRONZE"] });
    assert_eq!(amounts(&single(1, multi(), b).0), one("1", 0.5));
}

#[test]
fn a_linked_buyer_with_no_groups_gets_wildcard() {
    let b = json!({ "v": 1, "g": [] });
    assert_eq!(amounts(&single(1, multi(), b).0), one("1", 0.5));
}

#[test]
fn a_group_ladder_with_no_qualifying_tier_falls_through_to_wildcard() {
    let t = json!({ "v": 1, "c": "USD", "t": { "GOLD": [[10, 8]], "*": [[1, 9.5]] } });
    assert_eq!(amounts(&single(5, t.clone(), gold_buyer()).0), one("1", 0.5));
    assert_eq!(amounts(&single(10, t, gold_buyer()).0), one("1", 2.0));
}

#[test]
fn the_customers_own_price_beats_every_group() {
    let b = json!({ "v": 1, "g": ["GOLD"], "c": "USD", "p": { "11": [[1, 7.25]] } });
    assert_eq!(amounts(&single(1, multi(), b).0), one("1", 2.75));
}

#[test]
fn a_customer_price_for_another_variant_does_not_leak() {
    let b = json!({ "v": 1, "g": ["GOLD"], "c": "USD", "p": { "99": [[1, 1]] } });
    assert_eq!(amounts(&single(1, multi(), b).0), one("1", 2.0));
}

#[test]
fn no_group_match_and_no_wildcard_gives_nothing() {
    let t = json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, 8]] } });
    assert!(single(1, t, json!({ "v": 1, "g": ["SILVER"] })).0.operations.is_empty());
}

// ---- who gets nothing --------------------------------------------------------

#[test]
fn guests_get_nothing_and_nothing_is_logged() {
    let mut i = In::new(gold_buyer(), vec![usd(1, 11, 10, "10.0", &gold_ladder())]);
    i.guest = true;
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty());
    assert!(omitted.is_empty());
}

#[test]
fn signed_in_customers_who_are_not_linked_get_nothing() {
    let mut i = In::new(gold_buyer(), vec![usd(1, 11, 10, "10.0", &gold_ladder())]);
    i.buyer = None;
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty());
    assert!(omitted.is_empty());
}

#[test]
fn a_discount_without_the_product_class_does_nothing() {
    let mut i = In::new(gold_buyer(), vec![usd(1, 11, 10, "10.0", &gold_ladder())]);
    i.classes = vec!["ORDER"];
    assert!(i.run().0.operations.is_empty());
}

// ---- currency ------------------------------------------------------------------

#[test]
fn converts_the_tier_price_into_the_presentment_currency_before_subtracting() {
    // Shop in USD, buyer sees CAD at 1.5: retail 15.00 CAD, tier 8.00 USD = 12.00 CAD.
    let mut i = In::new(gold_buyer(), vec![line(1, 11, 10, "15.0", "CAD", Some(gold_ladder()))]);
    i.rate = "1.5";
    assert_eq!(amounts(&i.run().0), one("1", 3.0));
}

#[test]
fn rate_conversion_rounds_to_ten_thousandths_without_float_residue() {
    let t = json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, 0.1]] } });
    let mut i = In::new(gold_buyer(), vec![line(1, 11, 1, "1.0", "EUR", Some(t))]);
    i.rate = "3.0";
    assert_eq!(amounts(&i.run().0), one("1", 0.7));
}

#[test]
fn rate_one_with_prices_in_another_currency_is_omitted_and_logged() {
    let t = json!({ "v": 1, "c": "EUR", "t": { "GOLD": [[1, 8]] } });
    let (out, omitted) = In::new(gold_buyer(), vec![usd(1, 11, 1, "10.0", &t)]).run();
    assert!(out.operations.is_empty());
    assert!(log(&omitted).contains("currency_mismatch=11"));
}

#[test]
fn rate_not_one_with_prices_already_in_presentment_currency_is_omitted() {
    // The pipeline wrote a EUR price book although the shop currency is USD.
    let t = json!({ "v": 1, "c": "EUR", "t": { "GOLD": [[1, 8]] } });
    let mut i = In::new(gold_buyer(), vec![line(1, 11, 1, "9.0", "EUR", Some(t))]);
    i.rate = "0.9";
    let (out, omitted) = i.run();
    assert!(out.operations.is_empty());
    assert!(log(&omitted).contains("currency_mismatch=11"));
}

// ---- malformed metafields ---------------------------------------------------------

#[test]
fn malformed_price_tiers_are_omitted_and_logged_never_defaulted() {
    let cases: Vec<(&str, Value, &str)> = vec![
        ("wrong version", json!({ "v": 2, "c": "USD", "t": { "GOLD": [[1, 8]] } }), "tiers_version=11"),
        ("no version", json!({ "c": "USD", "t": { "GOLD": [[1, 8]] } }), "tiers_version=11"),
        ("a JSON string", json!("{\"v\":1}"), "tiers_version=11"),
        ("an array", json!([[1, 8]]), "tiers_version=11"),
        ("missing currency", json!({ "v": 1, "t": { "GOLD": [[1, 8]] } }), "tiers_currency=11"),
        ("lower-case currency", json!({ "v": 1, "c": "usd", "t": { "GOLD": [[1, 8]] } }), "tiers_currency=11"),
        ("unknown key", json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, 8]] }, "x": 1 }), "tiers_unknown_key=11"),
        ("breaks descending", json!({ "v": 1, "c": "USD", "t": { "GOLD": [[10, 8], [5, 9]] } }), "tiers_tier_list=11"),
        ("duplicate break", json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, 9], [1, 8]] } }), "tiers_tier_list=11"),
        ("price as a string", json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, "8.00"]] } }), "tiers_tier_list=11"),
        ("negative price", json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, -1]] } }), "tiers_tier_list=11"),
        ("five decimals", json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, 8.00001]] } }), "tiers_tier_list=11"),
        ("zero-quantity break", json!({ "v": 1, "c": "USD", "t": { "GOLD": [[0, 8]] } }), "tiers_tier_list=11"),
        ("fractional quantity", json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1.5, 8]] } }), "tiers_tier_list=11"),
        ("empty ladder", json!({ "v": 1, "c": "USD", "t": { "GOLD": [] } }), "tiers_tier_list=11"),
        ("no audiences", json!({ "v": 1, "c": "USD", "t": {} }), "tiers_tiers=11"),
    ];
    for (name, t, expected) in cases {
        let (out, omitted) = single(10, t, gold_buyer());
        assert!(out.operations.is_empty(), "{name}");
        assert!(log(&omitted).contains(expected), "{name}: {}", log(&omitted));
    }
}

#[test]
fn one_bad_variant_does_not_cost_the_others_their_price() {
    let bad = json!({ "v": 1, "c": "USD", "t": { "GOLD": "x" } });
    let (out, omitted) =
        In::new(gold_buyer(), vec![usd(1, 11, 10, "10.0", &bad), usd(2, 12, 10, "10.0", &gold_ladder())]).run();
    assert_eq!(amounts(&out), one("2", 2.0));
    assert!(log(&omitted).contains("tiers_tier_list=11"));
}

#[test]
fn a_malformed_buyer_is_treated_as_unpriced_and_logged() {
    let cases: Vec<(Value, &str)> = vec![
        (json!({ "v": 9, "g": [] }), "buyer_version"),
        (json!({ "v": 1, "g": "GOLD" }), "buyer_groups"),
        (json!({ "v": 1, "g": ["*"] }), "buyer_groups"),
        (json!({ "v": 1, "g": ["GOLD", "GOLD"] }), "buyer_groups"),
        (json!({ "v": 1, "g": [], "p": { "11": [[1, 5]] } }), "buyer_currency"),
        (json!({ "v": 1, "g": [], "c": "USD", "p": [[1, 5]] }), "buyer_prices"),
        (json!({ "v": 1, "g": [], "d": { "min": 0 } }), "buyer_limit_entry"),
        (json!({ "v": 1, "g": [], "z": true }), "buyer_unknown_key"),
    ];
    for (b, expected) in cases {
        let (out, omitted) = single(10, gold_ladder(), b);
        assert!(out.operations.is_empty());
        assert!(log(&omitted).contains(expected), "{}", log(&omitted));
    }
}

#[test]
fn a_malformed_override_for_this_variant_prices_nothing_rather_than_falling_to_a_group() {
    let b = json!({ "v": 1, "g": ["GOLD"], "c": "USD", "p": { "11": [[1, "7"]] } });
    let (out, omitted) = single(10, gold_ladder(), b);
    assert!(out.operations.is_empty());
    assert!(log(&omitted).contains("buyer_tier_list=11"), "{}", log(&omitted));
}

#[test]
fn a_malformed_group_ladder_prices_nothing_rather_than_falling_to_wildcard() {
    let t = json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, "8"]], "*": [[1, 9.5]] } });
    let (out, omitted) = single(1, t, gold_buyer());
    assert!(out.operations.is_empty());
    assert!(log(&omitted).contains("tiers_tier_list=11"));
}

#[test]
fn the_reader_consults_only_the_buyers_audiences() {
    // A broken ladder under an audience this buyer is not in is never read:
    // the WRITER validates whole documents (encode.js), the reader what it uses.
    let t = json!({ "v": 1, "c": "USD", "t": { "GOLD": [[1, 8]], "OTHER": "x" } });
    let (out, omitted) = single(1, t, gold_buyer());
    assert_eq!(amounts(&out), one("1", 2.0));
    assert!(omitted.is_empty());
}

#[test]
fn an_override_keyed_by_gid_is_not_a_match() {
    let b = json!({ "v": 1, "g": ["GOLD"], "c": "USD", "p": { "gid://shopify/ProductVariant/11": [[1, 5]] } });
    assert_eq!(amounts(&single(1, multi(), b).0), one("1", 2.0));
}

#[test]
fn lines_with_the_same_amount_share_one_candidate() {
    let t = gold_ladder();
    let (out, _) = In::new(
        gold_buyer(),
        vec![usd(1, 11, 10, "10.0", &t), usd(2, 12, 10, "10.0", &t), usd(3, 13, 1, "10.0", &t)],
    )
    .run();
    let schema::CartOperation::ProductDiscountsAdd(add) = &out.operations[0] else { panic!() };
    assert_eq!(add.candidates.len(), 2);
    assert_eq!(amounts(&out), vec![("1".into(), 2.0), ("2".into(), 2.0), ("3".into(), 1.0)]);
}

// ---- the 10,000-byte limit -----------------------------------------------------------

#[test]
fn a_withheld_variant_metafield_prices_nothing_and_is_not_logged_as_malformed() {
    // Shopify delivers a value over 10,000 bytes as null
    // (https://shopify.dev/docs/apps/build/metafields/metafield-limits). The
    // reader cannot tell it from absent; the writer must refuse (see the
    // reference writer's size tests).
    let (out, omitted) = In::new(gold_buyer(), vec![line(1, 11, 10, "10.0", "USD", None)]).run();
    assert!(out.operations.is_empty());
    assert!(omitted.is_empty());
}

#[test]
fn a_withheld_customer_metafield_makes_the_buyer_unlinked_so_retail_applies() {
    let mut i = In::new(gold_buyer(), vec![usd(1, 11, 10, "10.0", &gold_ladder())]);
    i.buyer = None;
    assert!(i.run().0.operations.is_empty());
}

// ---- the omission log stays under the 1 kB function log cap ------------------------

#[test]
fn the_log_line_is_bounded() {
    let bad = json!({ "v": 1, "c": "USD", "t": { "GOLD": "x" } });
    let lines: Vec<Value> = (0..200).map(|n| usd(n, 10_000_000_000 + u64::from(n), 1, "10.0", &bad)).collect();
    let (_, omitted) = In::new(gold_buyer(), lines).run();
    let line = omitted.render("tackquote-wholesale-pricing");
    assert!(line.len() <= 900, "{}", line.len());
    assert!(line.ends_with("..."));
}

// ---- the size assumption ------------------------------------------------------------

/// The budget METAFIELD_CONTRACT.md promises the push pipeline: 20 audiences
/// (19 group codes of 12 characters plus "*"), 20 breaks each, quantities up
/// to 7 digits and prices with 4 decimals up to 99,999.9999.
fn documented_budget_price_tiers() -> Value {
    let mut t = serde_json::Map::new();
    for g in 0..20 {
        let key = if g == 19 { "*".to_string() } else { format!("GROUPCODE{g:03}") };
        let ladder: Vec<Value> = (0..20)
            .map(|i| json!([1_000_000 + i * 100_000, 99_999.9999 - f64::from(i as u32)]))
            .collect();
        t.insert(key, Value::Array(ladder));
    }
    json!({ "v": 1, "c": "USD", "t": t })
}

#[test]
fn the_documented_worst_case_fits_under_10000_bytes_and_still_prices() {
    let t = documented_budget_price_tiers();
    let bytes = t.to_string().len();
    assert!(bytes <= crate::contract::FUNCTION_METAFIELD_MAX_BYTES, "{bytes} bytes");
    let b = json!({ "v": 1, "g": ["GROUPCODE000"] });
    let (out, omitted) = In::new(b, vec![usd(1, 11, 1_000_000, "100000.0", &t)]).run();
    assert!(omitted.is_empty(), "{}", log(&omitted));
    assert_eq!(amounts(&out), one("1", 0.0001));
}

#[test]
fn the_parser_caps_alone_do_not_keep_a_value_under_the_limit() {
    // 50 audiences x 50 breaks parses, but is far over 10,000 bytes, so
    // Shopify would hand the function null. Only the writer's refusal
    // (encode.js, ContractSizeError) prevents that silent retail fallback.
    let mut t = serde_json::Map::new();
    for g in 0..50 {
        let ladder: Vec<Value> = (1..=50).map(|q| json!([q, 1.5])).collect();
        t.insert(format!("G{g}"), Value::Array(ladder));
    }
    let v = json!({ "v": 1, "c": "USD", "t": t });
    assert!(v.to_string().len() > crate::contract::FUNCTION_METAFIELD_MAX_BYTES);
    assert!(matches!(crate::contract::read_price_tiers(None), crate::contract::Parsed::Absent));
}
