// TackQuote checkout-pricing metafield contract, version 1 (function side).
//
// CANONICAL COPY. Each function crate carries a byte-identical copy at
// `<extension>/src/contract.rs`, because Shopify CLI builds each function from
// its own directory (and the main repo reaches these directories through
// symlinks, which a relative `path =` dependency would not survive). The copies
// are gated by `contract/reference-writer/contract-copies.test.mjs`; after an
// edit here run `node shopify/functions/scripts/sync-contract.mjs`.
//
// The human-readable contract is `shopify/functions/METAFIELD_CONTRACT.md`,
// and `contract/conformance/cases.json` is the cross-language test corpus that
// both this parser and the reference writer must agree on.
//
// Rule for every parser: absent is Absent; present but not matching the
// contract is Malformed and the caller OMITS it and logs it. Nothing is ever
// defaulted. A malformed price book never becomes a price.

use shopify_function::prelude::*;
use std::collections::BTreeMap;

pub const CONTRACT_VERSION: f64 = 1.0;

/// Shopify Functions receive null for any metafield value over 10,000 bytes.
/// https://shopify.dev/docs/apps/build/metafields/metafield-limits
pub const FUNCTION_METAFIELD_MAX_BYTES: usize = 10_000;

/// The blanket audience key: any LINKED TackQuote buyer. Never guests, never
/// Shopify customers without a `$app:buyer` metafield.
pub const WILDCARD: &str = "*";

/// Money is carried as integer 1/10,000ths of a currency unit, matching
/// TackQuote's DECIMAL(14,4), so retail - tier picks up no float error.
pub const UNIT: i64 = 10_000;

const MAX_TIERS_PER_LIST: usize = 50;
const MAX_GROUPS: usize = 50;
const MAX_KEY_LENGTH: usize = 100; // buyer_groups.code is VARCHAR(100)
const MAX_QTY: f64 = 1_000_000_000.0;
const MAX_PRICE_UNITS: f64 = 1e14;

pub type Ladder = Vec<(i64, i64)>;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LimitEntry {
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub step: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CartLimits {
    pub min_total: Option<i64>,
    pub max_total: Option<i64>,
    pub min_qty: Option<i64>,
    pub max_qty: Option<i64>,
    pub min_unique: Option<i64>,
    pub max_unique: Option<i64>,
}

impl CartLimits {
    pub fn has_money(&self) -> bool {
        self.min_total.is_some() || self.max_total.is_some()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PriceTiers {
    pub currency: String,
    pub tiers: BTreeMap<String, Ladder>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderLimits {
    pub limits: BTreeMap<String, LimitEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Buyer {
    pub groups: Vec<String>,
    pub currency: Option<String>,
    pub prices: Option<BTreeMap<String, Ladder>>,
    pub quantities: Option<BTreeMap<String, LimitEntry>>,
    pub defaults: Option<LimitEntry>,
    pub cart: Option<CartLimits>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShopLimits {
    pub currency: Option<String>,
    pub cart: Option<CartLimits>,
    pub defaults: Option<LimitEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Parsed<T> {
    Absent,
    Malformed(&'static str),
    Ok(T),
}

type Obj = BTreeMap<String, JsonValue>;

fn as_object(v: &JsonValue) -> Option<&Obj> {
    match v {
        JsonValue::Object(o) => Some(o),
        _ => None,
    }
}

fn only_keys(o: &Obj, allowed: &[&str]) -> bool {
    o.keys().all(|k| allowed.contains(&k.as_str()))
}

fn pos_int(v: &JsonValue) -> Option<i64> {
    match v {
        JsonValue::Number(n) if n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= MAX_QTY => {
            Some(*n as i64)
        }
        _ => None,
    }
}

pub fn is_currency(s: &str) -> bool {
    s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase())
}

fn currency_of(v: Option<&JsonValue>) -> Result<Option<String>, ()> {
    match v {
        None => Ok(None),
        Some(JsonValue::String(s)) if is_currency(s) => Ok(Some(s.clone())),
        Some(_) => Err(()),
    }
}

fn is_audience_key(k: &str) -> bool {
    !k.is_empty() && k.chars().count() <= MAX_KEY_LENGTH
}

fn is_variant_key(k: &str) -> bool {
    !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit())
}

/// "gid://shopify/ProductVariant/123" -> "123".
pub fn variant_key(gid: &str) -> Option<&str> {
    let k = match gid.rfind('/') {
        Some(i) => &gid[i + 1..],
        None => gid,
    };
    if is_variant_key(k) {
        Some(k)
    } else {
        None
    }
}

/// A contract price: a JSON number, >= 0, at most four decimal places.
pub fn price_to_units(v: &JsonValue) -> Option<i64> {
    let n = match v {
        JsonValue::Number(n) if n.is_finite() && *n >= 0.0 => *n,
        _ => return None,
    };
    let scaled = n * UNIT as f64;
    let units = scaled.round();
    if (scaled - units).abs() > 1e-6 || units > MAX_PRICE_UNITS {
        return None;
    }
    Some(units as i64)
}

/// A Shopify Decimal from function input. Shopify owns its precision, so this
/// rounds rather than rejects.
pub fn amount_to_units(n: f64) -> Option<i64> {
    if n.is_finite() && n >= 0.0 {
        Some((n * UNIT as f64).round() as i64)
    } else {
        None
    }
}

/// Units back to a decimal f64 for a Decimal output. Exact for <= 4 dp values
/// in the range TackQuote stores.
pub fn units_to_f64(units: i64) -> f64 {
    units as f64 / UNIT as f64
}

pub fn parse_tier_list(v: &JsonValue) -> Option<Ladder> {
    let list = match v {
        JsonValue::Array(a) if !a.is_empty() && a.len() <= MAX_TIERS_PER_LIST => a,
        _ => return None,
    };
    let mut out = Vec::with_capacity(list.len());
    let mut prev = 0i64;
    for tier in list {
        let pair = match tier {
            JsonValue::Array(p) if p.len() == 2 => p,
            _ => return None,
        };
        let qty = pos_int(&pair[0])?;
        if qty <= prev {
            return None;
        }
        let units = price_to_units(&pair[1])?;
        out.push((qty, units));
        prev = qty;
    }
    Some(out)
}

pub fn parse_limit_entry(v: &JsonValue) -> Option<LimitEntry> {
    let o = as_object(v)?;
    if o.is_empty() || !only_keys(o, &["min", "max", "step"]) {
        return None;
    }
    let field = |k: &str| -> Result<Option<i64>, ()> {
        match o.get(k) {
            None => Ok(None),
            Some(x) => pos_int(x).map(Some).ok_or(()),
        }
    };
    Some(LimitEntry {
        min: field("min").ok()?,
        max: field("max").ok()?,
        step: field("step").ok()?,
    })
}

pub fn parse_cart_limits(v: &JsonValue) -> Option<CartLimits> {
    let o = as_object(v)?;
    let allowed = ["minTotal", "maxTotal", "minQty", "maxQty", "minUnique", "maxUnique"];
    if o.is_empty() || !only_keys(o, &allowed) {
        return None;
    }
    let money = |k: &str| -> Result<Option<i64>, ()> {
        match o.get(k) {
            None => Ok(None),
            Some(x) => price_to_units(x).map(Some).ok_or(()),
        }
    };
    let count = |k: &str| -> Result<Option<i64>, ()> {
        match o.get(k) {
            None => Ok(None),
            Some(x) => pos_int(x).map(Some).ok_or(()),
        }
    };
    Some(CartLimits {
        min_total: money("minTotal").ok()?,
        max_total: money("maxTotal").ok()?,
        min_qty: count("minQty").ok()?,
        max_qty: count("maxQty").ok()?,
        min_unique: count("minUnique").ok()?,
        max_unique: count("maxUnique").ok()?,
    })
}

/// A present JSON value that is not an object with `"v": 1` is a version
/// mismatch: either a future contract or not ours.
fn versioned(v: Option<&JsonValue>) -> Result<Option<&Obj>, &'static str> {
    match v {
        None | Some(JsonValue::Null) => Ok(None),
        Some(v) => match as_object(v) {
            Some(o) if o.get("v") == Some(&JsonValue::Number(CONTRACT_VERSION)) => Ok(Some(o)),
            _ => Err("version"),
        },
    }
}

/// ProductVariant `$app:price_tiers`
/// `{ "v":1, "c":"USD", "t": { "<groupCode>|*": [[minQty, unitPrice], ...] } }`
pub fn parse_price_tiers(v: Option<&JsonValue>) -> Parsed<PriceTiers> {
    let o = match versioned(v) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "c", "t"]) {
        return Parsed::Malformed("unknown_key");
    }
    let currency = match o.get("c") {
        Some(JsonValue::String(s)) if is_currency(s) => s.clone(),
        _ => return Parsed::Malformed("currency"),
    };
    let t = match o.get("t").and_then(as_object) {
        Some(t) if !t.is_empty() => t,
        _ => return Parsed::Malformed("tiers"),
    };
    let mut tiers = BTreeMap::new();
    for (k, list) in t {
        if !is_audience_key(k) {
            return Parsed::Malformed("audience_key");
        }
        match parse_tier_list(list) {
            Some(l) => {
                tiers.insert(k.clone(), l);
            }
            None => return Parsed::Malformed("tier_list"),
        }
    }
    Parsed::Ok(PriceTiers { currency, tiers })
}

/// ProductVariant `$app:order_limits`
/// `{ "v":1, "l": { "<groupCode>|*": { "min":12, "max":480, "step":12 } } }`
pub fn parse_order_limits(v: Option<&JsonValue>) -> Parsed<OrderLimits> {
    let o = match versioned(v) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "l"]) {
        return Parsed::Malformed("unknown_key");
    }
    let l = match o.get("l").and_then(as_object) {
        Some(l) if !l.is_empty() => l,
        _ => return Parsed::Malformed("limits"),
    };
    let mut limits = BTreeMap::new();
    for (k, e) in l {
        if !is_audience_key(k) {
            return Parsed::Malformed("audience_key");
        }
        match parse_limit_entry(e) {
            Some(e) => {
                limits.insert(k.clone(), e);
            }
            None => return Parsed::Malformed("limit_entry"),
        }
    }
    Parsed::Ok(OrderLimits { limits })
}

/// Customer `$app:buyer`. Its presence is what makes a Shopify customer a
/// linked TackQuote buyer.
pub fn parse_buyer(v: Option<&JsonValue>) -> Parsed<Buyer> {
    let o = match versioned(v) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "g", "c", "p", "q", "d", "l"]) {
        return Parsed::Malformed("unknown_key");
    }

    let mut groups: Vec<String> = Vec::new();
    match o.get("g") {
        Some(JsonValue::Array(a)) if a.len() <= MAX_GROUPS => {
            for g in a {
                match g {
                    JsonValue::String(s)
                        if is_audience_key(s) && s != WILDCARD && !groups.contains(s) =>
                    {
                        groups.push(s.clone())
                    }
                    _ => return Parsed::Malformed("groups"),
                }
            }
        }
        _ => return Parsed::Malformed("groups"),
    }

    let currency = match currency_of(o.get("c")) {
        Ok(c) => c,
        Err(()) => return Parsed::Malformed("currency"),
    };

    let prices = match o.get("p") {
        None => None,
        Some(p) => {
            let p = match as_object(p) {
                Some(p) => p,
                None => return Parsed::Malformed("prices"),
            };
            let mut out = BTreeMap::new();
            for (k, list) in p {
                if !is_variant_key(k) {
                    return Parsed::Malformed("variant_key");
                }
                match parse_tier_list(list) {
                    Some(l) => {
                        out.insert(k.clone(), l);
                    }
                    None => return Parsed::Malformed("tier_list"),
                }
            }
            Some(out)
        }
    };

    let quantities = match o.get("q") {
        None => None,
        Some(q) => {
            let q = match as_object(q) {
                Some(q) => q,
                None => return Parsed::Malformed("quantities"),
            };
            let mut out = BTreeMap::new();
            for (k, e) in q {
                if !is_variant_key(k) {
                    return Parsed::Malformed("variant_key");
                }
                match parse_limit_entry(e) {
                    Some(e) => {
                        out.insert(k.clone(), e);
                    }
                    None => return Parsed::Malformed("limit_entry"),
                }
            }
            Some(out)
        }
    };

    let defaults = match o.get("d") {
        None => None,
        Some(d) => match parse_limit_entry(d) {
            Some(d) => Some(d),
            None => return Parsed::Malformed("limit_entry"),
        },
    };

    let cart = match o.get("l") {
        None => None,
        Some(l) => match parse_cart_limits(l) {
            Some(l) => Some(l),
            None => return Parsed::Malformed("cart_limits"),
        },
    };

    // Money without a currency cannot be converted, so it is not a price.
    let has_money = prices.is_some() || cart.map(|c| c.has_money()).unwrap_or(false);
    if has_money && currency.is_none() {
        return Parsed::Malformed("currency");
    }

    Parsed::Ok(Buyer {
        groups,
        currency,
        prices,
        quantities,
        defaults,
        cart,
    })
}

/// Validation `$app:cart_limits`: shop-wide rules for every linked buyer.
pub fn parse_shop_limits(v: Option<&JsonValue>) -> Parsed<ShopLimits> {
    let o = match versioned(v) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "c", "l", "d"]) {
        return Parsed::Malformed("unknown_key");
    }
    let currency = match currency_of(o.get("c")) {
        Ok(c) => c,
        Err(()) => return Parsed::Malformed("currency"),
    };
    let cart = match o.get("l") {
        None => None,
        Some(l) => match parse_cart_limits(l) {
            Some(l) => Some(l),
            None => return Parsed::Malformed("cart_limits"),
        },
    };
    let defaults = match o.get("d") {
        None => None,
        Some(d) => match parse_limit_entry(d) {
            Some(d) => Some(d),
            None => return Parsed::Malformed("limit_entry"),
        },
    };
    if cart.map(|c| c.has_money()).unwrap_or(false) && currency.is_none() {
        return Parsed::Malformed("currency");
    }
    Parsed::Ok(ShopLimits {
        currency,
        cart,
        defaults,
    })
}

/// Highest tier whose minQty <= qty; None below the first break.
pub fn select_tier(ladder: &Ladder, qty: i64) -> Option<i64> {
    let mut best = None;
    for &(min_qty, units) in ladder {
        if min_qty <= qty {
            best = Some(units);
        } else {
            break;
        }
    }
    best
}

#[derive(Debug, Clone, PartialEq)]
pub struct UnitPrice<'a> {
    pub units: i64,
    pub currency: &'a str,
}

/// Unit-price precedence (first match wins):
///   1. the customer's own override `p` (buyer / company price books)
///   2. each of the customer's groups `g`, in the order TackQuote wrote them
///   3. the "*" blanket ladder
/// A level whose ladder has no qualifying tier falls through to the next.
pub fn resolve_unit_price<'a>(
    buyer: &'a Buyer,
    vkey: Option<&str>,
    tiers: Option<&'a PriceTiers>,
    qty: i64,
) -> Option<UnitPrice<'a>> {
    if let (Some(prices), Some(k), Some(cur)) = (&buyer.prices, vkey, &buyer.currency) {
        if let Some(ladder) = prices.get(k) {
            if let Some(units) = select_tier(ladder, qty) {
                return Some(UnitPrice { units, currency: cur });
            }
        }
    }
    if let Some(t) = tiers {
        for key in buyer.groups.iter().map(|g| g.as_str()).chain(std::iter::once(WILDCARD)) {
            if let Some(ladder) = t.tiers.get(key) {
                if let Some(units) = select_tier(ladder, qty) {
                    return Some(UnitPrice { units, currency: &t.currency });
                }
            }
        }
    }
    None
}

/// Product dimension: first of the customer's groups with an entry, then "*",
/// then the shop-wide per-variant default.
pub fn resolve_product_limit(
    buyer: &Buyer,
    variant: Option<&OrderLimits>,
    shop_default: Option<LimitEntry>,
) -> Option<LimitEntry> {
    if let Some(v) = variant {
        for key in buyer.groups.iter().map(|g| g.as_str()).chain(std::iter::once(WILDCARD)) {
            if let Some(e) = v.limits.get(key) {
                return Some(*e);
            }
        }
    }
    shop_default
}

/// Customer dimension: the customer's own per-variant entry, else the
/// customer's default. Enforced IN ADDITION to the product dimension, which is
/// how TackQuote's order-limits service evaluates rules (every applicable one).
pub fn resolve_customer_limit(buyer: &Buyer, vkey: Option<&str>) -> Option<LimitEntry> {
    if let (Some(q), Some(k)) = (&buyer.quantities, vkey) {
        if let Some(e) = q.get(k) {
            return Some(*e);
        }
    }
    buyer.defaults
}

/// Shop-currency units into the presentment currency.
///
/// Function input money is already in the presentment currency and
/// `presentmentCurrencyRate` converts shop currency into it
/// (https://shopify.dev/docs/apps/build/functions/localization-practices-shopify-functions).
/// The contract states prices in the SHOP currency and names it in `c`, which
/// catches a pipeline that wrote the wrong one:
///   rate == 1: presentment is the shop currency, so `c` must equal it;
///   rate != 1: presentment is not the shop currency, so `c` must differ.
pub fn to_presentment(units: i64, source: &str, presentment: &str, rate: f64) -> Option<i64> {
    if !is_currency(source) || !is_currency(presentment) || !rate.is_finite() || rate <= 0.0 {
        return None;
    }
    if rate == 1.0 {
        return if source == presentment { Some(units) } else { None };
    }
    if source == presentment {
        return None;
    }
    Some((units as f64 * rate).round() as i64)
}

/// Collects omissions and renders ONE bounded log line. Function logs are
/// truncated at 1 kB (https://shopify.dev/docs/apps/build/functions/test-debug-functions).
/// Only reason codes and numeric variant ids: never customer data.
#[derive(Debug, Default)]
pub struct Omissions {
    entries: Vec<(String, Vec<String>)>,
}

impl Omissions {
    pub fn add(&mut self, reason: &str, id: Option<&str>) {
        let idx = match self.entries.iter().position(|(r, _)| r == reason) {
            Some(i) => i,
            None => {
                self.entries.push((reason.to_string(), Vec::new()));
                self.entries.len() - 1
            }
        };
        if let Some(id) = id {
            let ids = &mut self.entries[idx].1;
            if !ids.iter().any(|x| x == id) {
                ids.push(id.to_string());
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn render(&self, prefix: &str) -> String {
        let mut line = format!("{prefix} omitted:");
        for (reason, ids) in &self.entries {
            if ids.is_empty() {
                line.push_str(&format!(" {reason};"));
            } else {
                line.push_str(&format!(" {reason}={};", ids.join(",")));
            }
        }
        if line.len() > 900 {
            let mut cut = 897;
            while !line.is_char_boundary(cut) {
                cut -= 1;
            }
            line.truncate(cut);
            line.push_str("...");
        }
        line
    }
}
