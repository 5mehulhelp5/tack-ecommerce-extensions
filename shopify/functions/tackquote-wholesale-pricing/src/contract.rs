// TackQuote checkout metafield contract, version 2 (function side).
//
// Version 2 ADDS two metafields and changes nothing that version 1 defined:
// every v1 value keeps `"v": 1` and is read exactly as before, so a function
// built against v1 keeps working unchanged. The new values carry `"v": 2`:
//   Product                                 `$app:visibility`
//   DeliveryCustomization / DiscountAutomaticApp `$app:shipping_rules`
//
// CANONICAL COPY. Each function crate carries a byte-identical copy at
// `<extension>/src/contract.rs`, because Shopify CLI builds each function from
// its own directory. `node --test` (shopify/functions/package.json) fails when
// a copy drifts; after an edit here run `node scripts/sync-contract.mjs`.
//
// The human-readable contract is `shopify/functions/METAFIELD_CONTRACT.md`.
//
// READ WHAT YOU CONSULT, VALIDATE WHAT YOU READ.
// The values are read straight from the function's lazy input
// (`shopify_function::wasm_api::Value`) instead of being materialised as a
// `JsonValue` tree, and only the audience / variant keys this cart needs are
// looked up. Materialising every metafield cost ~50,000 instructions per cart
// line, which put a 200-line cart at 14.9M against the 11M limit
// (https://shopify.dev/docs/api/functions/2026-07, "Resource limits").
// The WRITER (contract/reference-writer) validates the whole document before
// it is written; this reader validates the envelope and every entry it uses.
//
// Rule: absent is Absent; present but not matching the contract is Malformed,
// and the caller OMITS it and logs it. Nothing is ever defaulted. A malformed
// price book never becomes a price.

/// The lazy input value a `jsonValue` field is overridden to in `main.rs`.
pub type RawJson = shopify_function::wasm_api::Value;

/// The envelope version of every v1 metafield (price_tiers, order_limits,
/// buyer, cart_limits). Unchanged by contract v2.
pub const CONTRACT_VERSION: f64 = 1.0;

/// The envelope version of the metafields contract v2 introduced
/// (visibility, shipping_rules). A v1 reader never queries them.
pub const CONTRACT_V2: f64 = 2.0;

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
pub enum Parsed<T> {
    Absent,
    Malformed(&'static str),
    Ok(T),
}

// ---- primitive readers ---------------------------------------------------------

fn present(v: &RawJson) -> bool {
    !v.is_null()
}

/// Every key of `o` is in `allowed`: the object has exactly as many keys as
/// there are allowed keys present in it. One host call per allowed key, no
/// string allocation.
fn only_keys(o: &RawJson, allowed: &[&str]) -> bool {
    let Some(len) = o.obj_len() else { return false };
    let seen = allowed.iter().filter(|k| present(&o.get_obj_prop(k))).count();
    seen == len
}

fn pos_int(v: &RawJson) -> Option<i64> {
    match v.as_number() {
        Some(n) if n.is_finite() && n.fract() == 0.0 && (1.0..=MAX_QTY).contains(&n) => Some(n as i64),
        _ => None,
    }
}

pub fn is_currency(s: &str) -> bool {
    s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase())
}

fn currency_of(v: &RawJson) -> Result<Option<String>, ()> {
    if !present(v) {
        return Ok(None);
    }
    match v.as_string() {
        Some(s) if is_currency(&s) => Ok(Some(s)),
        _ => Err(()),
    }
}

fn is_audience_key(k: &str) -> bool {
    !k.is_empty() && k.chars().count() <= MAX_KEY_LENGTH
}

/// "gid://shopify/ProductVariant/123" -> "123".
pub fn variant_key(gid: &str) -> Option<&str> {
    let k = match gid.rfind('/') {
        Some(i) => &gid[i + 1..],
        None => gid,
    };
    if !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()) {
        Some(k)
    } else {
        None
    }
}

/// A contract price as f64: >= 0, at most four decimal places.
pub fn price_f64_to_units(n: f64) -> Option<i64> {
    if !n.is_finite() || n < 0.0 {
        return None;
    }
    let scaled = n * UNIT as f64;
    let units = scaled.round();
    if (scaled - units).abs() > 1e-6 || units > MAX_PRICE_UNITS {
        return None;
    }
    Some(units as i64)
}

fn price_to_units(v: &RawJson) -> Option<i64> {
    price_f64_to_units(v.as_number()?)
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

// ---- entry readers ---------------------------------------------------------------

/// `[[minQty, unitPrice], ...]`, minQty strictly ascending.
pub fn read_tier_list(v: &RawJson) -> Option<Ladder> {
    let len = v.array_len()?;
    if len == 0 || len > MAX_TIERS_PER_LIST {
        return None;
    }
    let mut out = Vec::with_capacity(len);
    let mut prev = 0i64;
    for i in 0..len {
        let pair = v.get_at_index(i);
        if pair.array_len() != Some(2) {
            return None;
        }
        let qty = pos_int(&pair.get_at_index(0))?;
        if qty <= prev {
            return None;
        }
        let units = price_to_units(&pair.get_at_index(1))?;
        out.push((qty, units));
        prev = qty;
    }
    Some(out)
}

/// `{ "min": 12, "max": 480, "step": 12 }`, at least one key.
pub fn read_limit_entry(v: &RawJson) -> Option<LimitEntry> {
    if !v.is_obj() || v.obj_len() == Some(0) || !only_keys(v, &["min", "max", "step"]) {
        return None;
    }
    let field = |k: &str| -> Result<Option<i64>, ()> {
        let x = v.get_obj_prop(k);
        if !present(&x) {
            return Ok(None);
        }
        pos_int(&x).map(Some).ok_or(())
    };
    Some(LimitEntry { min: field("min").ok()?, max: field("max").ok()?, step: field("step").ok()? })
}

pub fn read_cart_limits(v: &RawJson) -> Option<CartLimits> {
    let allowed = ["minTotal", "maxTotal", "minQty", "maxQty", "minUnique", "maxUnique"];
    if !v.is_obj() || v.obj_len() == Some(0) || !only_keys(v, &allowed) {
        return None;
    }
    let money = |k: &str| -> Result<Option<i64>, ()> {
        let x = v.get_obj_prop(k);
        if !present(&x) {
            return Ok(None);
        }
        price_to_units(&x).map(Some).ok_or(())
    };
    let count = |k: &str| -> Result<Option<i64>, ()> {
        let x = v.get_obj_prop(k);
        if !present(&x) {
            return Ok(None);
        }
        pos_int(&x).map(Some).ok_or(())
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

/// A present value that is not an object with `"v": 1` is a version mismatch:
/// either a future contract or not ours.
fn envelope(v: Option<&RawJson>) -> Result<Option<&RawJson>, &'static str> {
    envelope_at(v, CONTRACT_VERSION)
}

/// The same rule for an explicit envelope version. Each metafield has exactly
/// one version it is valid at; there is no "accept either".
fn envelope_at(v: Option<&RawJson>, version: f64) -> Result<Option<&RawJson>, &'static str> {
    match v {
        None => Ok(None),
        Some(v) if !present(v) => Ok(None),
        Some(v) if v.is_obj() && v.get_obj_prop("v").as_number() == Some(version) => Ok(Some(v)),
        Some(_) => Err("version"),
    }
}

/// A non-empty object, kept as a lazy handle for key lookups.
fn keyed(v: &RawJson) -> Option<RawJson> {
    match v.obj_len() {
        Some(n) if n > 0 => Some(*v),
        _ => None,
    }
}

/// Look `key` up in a keyed map and read the entry with `read`.
fn lookup<T>(map: &RawJson, key: &str, read: fn(&RawJson) -> Option<T>) -> Parsed<T> {
    let e = map.get_obj_prop(key);
    if !present(&e) {
        return Parsed::Absent;
    }
    match read(&e) {
        Some(t) => Parsed::Ok(t),
        None => Parsed::Malformed("entry"),
    }
}

// ---- documents ---------------------------------------------------------------------

/// ProductVariant `$app:price_tiers`
/// `{ "v":1, "c":"USD", "t": { "<groupCode>|*": [[minQty, unitPrice], ...] } }`
#[derive(Clone)] // wasm_api::Value is not Debug
pub struct PriceTiers {
    pub currency: String,
    t: RawJson,
}

impl PriceTiers {
    pub fn ladder(&self, audience: &str) -> Parsed<Ladder> {
        lookup(&self.t, audience, read_tier_list)
    }
}

pub fn read_price_tiers(v: Option<&RawJson>) -> Parsed<PriceTiers> {
    let o = match envelope(v) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "c", "t"]) {
        return Parsed::Malformed("unknown_key");
    }
    let currency = match o.get_obj_prop("c").as_string() {
        Some(s) if is_currency(&s) => s,
        _ => return Parsed::Malformed("currency"),
    };
    match keyed(&o.get_obj_prop("t")) {
        Some(t) => Parsed::Ok(PriceTiers { currency, t }),
        None => Parsed::Malformed("tiers"),
    }
}

/// ProductVariant `$app:order_limits`
/// `{ "v":1, "l": { "<groupCode>|*": { "min":12, "max":480, "step":12 } } }`
#[derive(Clone)] // wasm_api::Value is not Debug
pub struct OrderLimits {
    l: RawJson,
}

impl OrderLimits {
    pub fn entry(&self, audience: &str) -> Parsed<LimitEntry> {
        lookup(&self.l, audience, read_limit_entry)
    }
}

pub fn read_order_limits(v: Option<&RawJson>) -> Parsed<OrderLimits> {
    let o = match envelope(v) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "l"]) {
        return Parsed::Malformed("unknown_key");
    }
    match keyed(&o.get_obj_prop("l")) {
        Some(l) => Parsed::Ok(OrderLimits { l }),
        None => Parsed::Malformed("limits"),
    }
}

/// Customer `$app:buyer`. Its presence is what makes a Shopify customer a
/// linked TackQuote buyer. `g`, `c`, `d` and `l` are read in full; `p` and `q`
/// are keyed by numeric variant id and looked up per cart variant.
#[derive(Clone)] // wasm_api::Value is not Debug
pub struct Buyer {
    pub groups: Vec<String>,
    pub currency: Option<String>,
    prices: Option<RawJson>,
    quantities: Option<RawJson>,
    pub defaults: Option<LimitEntry>,
    pub cart: Option<CartLimits>,
}

impl Buyer {
    /// The customer's own ladder for this variant (`p`).
    pub fn price_ladder(&self, vkey: Option<&str>) -> Parsed<Ladder> {
        match (&self.prices, vkey) {
            (Some(p), Some(k)) => lookup(p, k, read_tier_list),
            _ => Parsed::Absent,
        }
    }

    /// The customer's own limit for this variant (`q`).
    pub fn quantity_limit(&self, vkey: Option<&str>) -> Parsed<LimitEntry> {
        match (&self.quantities, vkey) {
            (Some(q), Some(k)) => lookup(q, k, read_limit_entry),
            _ => Parsed::Absent,
        }
    }

    /// The customer's groups in precedence order, then "*".
    pub fn audiences(&self) -> impl Iterator<Item = &str> {
        self.groups.iter().map(|g| g.as_str()).chain(std::iter::once(WILDCARD))
    }
}

fn optional_map(o: &RawJson, key: &str) -> Result<Option<RawJson>, ()> {
    let v = o.get_obj_prop(key);
    if !present(&v) {
        return Ok(None);
    }
    if v.is_obj() {
        Ok(Some(v))
    } else {
        Err(())
    }
}

pub fn read_buyer(v: Option<&RawJson>) -> Parsed<Buyer> {
    let o = match envelope(v) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "g", "c", "p", "q", "d", "l"]) {
        return Parsed::Malformed("unknown_key");
    }

    let g = o.get_obj_prop("g");
    let n = match g.array_len() {
        Some(n) if n <= MAX_GROUPS => n,
        _ => return Parsed::Malformed("groups"),
    };
    let mut groups: Vec<String> = Vec::with_capacity(n);
    for i in 0..n {
        match g.get_at_index(i).as_string() {
            Some(s) if is_audience_key(&s) && s != WILDCARD && !groups.contains(&s) => groups.push(s),
            _ => return Parsed::Malformed("groups"),
        }
    }

    let currency = match currency_of(&o.get_obj_prop("c")) {
        Ok(c) => c,
        Err(()) => return Parsed::Malformed("currency"),
    };
    let Ok(prices) = optional_map(o, "p") else { return Parsed::Malformed("prices") };
    let Ok(quantities) = optional_map(o, "q") else { return Parsed::Malformed("quantities") };

    let d = o.get_obj_prop("d");
    let defaults = if present(&d) {
        match read_limit_entry(&d) {
            Some(d) => Some(d),
            None => return Parsed::Malformed("limit_entry"),
        }
    } else {
        None
    };
    let l = o.get_obj_prop("l");
    let cart = if present(&l) {
        match read_cart_limits(&l) {
            Some(l) => Some(l),
            None => return Parsed::Malformed("cart_limits"),
        }
    } else {
        None
    };

    // Money without a currency cannot be converted, so it is not a price.
    let has_money = prices.is_some() || cart.map(|c| c.has_money()).unwrap_or(false);
    if has_money && currency.is_none() {
        return Parsed::Malformed("currency");
    }

    Parsed::Ok(Buyer { groups, currency, prices, quantities, defaults, cart })
}

/// Validation `$app:cart_limits`: shop-wide rules for every linked buyer.
#[derive(Debug, Clone, PartialEq)]
pub struct ShopLimits {
    pub currency: Option<String>,
    pub cart: Option<CartLimits>,
    pub defaults: Option<LimitEntry>,
}

pub fn read_shop_limits(v: Option<&RawJson>) -> Parsed<ShopLimits> {
    let o = match envelope(v) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "c", "l", "d"]) {
        return Parsed::Malformed("unknown_key");
    }
    let currency = match currency_of(&o.get_obj_prop("c")) {
        Ok(c) => c,
        Err(()) => return Parsed::Malformed("currency"),
    };
    let l = o.get_obj_prop("l");
    let cart = if present(&l) {
        match read_cart_limits(&l) {
            Some(l) => Some(l),
            None => return Parsed::Malformed("cart_limits"),
        }
    } else {
        None
    };
    let d = o.get_obj_prop("d");
    let defaults = if present(&d) {
        match read_limit_entry(&d) {
            Some(d) => Some(d),
            None => return Parsed::Malformed("limit_entry"),
        }
    } else {
        None
    };
    if cart.map(|c| c.has_money()).unwrap_or(false) && currency.is_none() {
        return Parsed::Malformed("currency");
    }
    Parsed::Ok(ShopLimits { currency, cart, defaults })
}

// ---- contract v2 documents -------------------------------------------------------

const MAX_AUDIENCES: usize = 50;
const MAX_RULES: usize = 50;
const MAX_COUNTRIES: usize = 250;
const MAX_TITLE_MATCHES: usize = 20;
const MAX_TITLE_LENGTH: usize = 100;
/// A shipping percentage is TackQuote's `shipping_rules.percentage`,
/// DECIMAL(8,4): 0..100 with four decimals, carried as 1/10,000ths of a percent.
const MAX_PERCENT_UNITS: i64 = 100 * UNIT;

/// `["gold", "*"]`: 1..50 distinct audience keys. `"*"` is allowed here.
fn read_audience_list(v: &RawJson) -> Option<Vec<String>> {
    let n = v.array_len()?;
    if n == 0 || n > MAX_AUDIENCES {
        return None;
    }
    let mut out: Vec<String> = Vec::with_capacity(n);
    for i in 0..n {
        let s = v.get_at_index(i).as_string()?;
        if !is_audience_key(&s) || out.contains(&s) {
            return None;
        }
        out.push(s);
    }
    Some(out)
}

/// Product `$app:visibility`
/// `{ "v":2, "a": ["gold","*"] }` only linked buyers in these audiences may buy;
/// `{ "v":2, "d": ["*"] }`        linked buyers in these audiences may not.
/// At least one of `a` / `d`.
#[derive(Debug, Clone, PartialEq)]
pub struct Visibility {
    pub allow: Option<Vec<String>>,
    pub deny: Option<Vec<String>>,
}

pub fn read_visibility(v: Option<&RawJson>) -> Parsed<Visibility> {
    let o = match envelope_at(v, CONTRACT_V2) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "a", "d"]) {
        return Parsed::Malformed("unknown_key");
    }
    let list = |k: &str| -> Result<Option<Vec<String>>, ()> {
        let x = o.get_obj_prop(k);
        if !present(&x) {
            return Ok(None);
        }
        read_audience_list(&x).map(Some).ok_or(())
    };
    let Ok(allow) = list("a") else { return Parsed::Malformed("allow") };
    let Ok(deny) = list("d") else { return Parsed::Malformed("deny") };
    if allow.is_none() && deny.is_none() {
        return Parsed::Malformed("empty");
    }
    Parsed::Ok(Visibility { allow, deny })
}

/// May this buyer buy the product? `buyer` is None for a guest and for a
/// customer who is not a linked TackQuote buyer.
///   1. deny first: a linked buyer in any `d` audience may not;
///   2. then `a`: only a linked buyer in an `a` audience may. A guest never is.
///   3. only `d`, and not denied: allowed (a retail shopper included).
pub fn is_entitled(vis: &Visibility, buyer: Option<&Buyer>) -> bool {
    if let (Some(deny), Some(b)) = (&vis.deny, buyer) {
        if b.audiences().any(|k| deny.iter().any(|d| d == k)) {
            return false;
        }
    }
    match (&vis.allow, buyer) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(allow), Some(b)) => b.audiences().any(|k| allow.iter().any(|a| a == k)),
    }
}

/// What a shipping rule charges, in the contract's (shop) currency.
#[derive(Debug, Clone, PartialEq)]
pub enum RateKind {
    /// Presentation only: never a rate (TackQuote skips it when pricing).
    None,
    Flat(i64),
    Free,
    /// 1/10,000ths of a percent of the cart subtotal.
    Percent(i64),
    /// `(min, max, amount)` on the cart subtotal, both ends inclusive.
    Tiered(Vec<(i64, Option<i64>, i64)>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShippingRule {
    pub audiences: Vec<String>,
    /// Upper-case ISO 3166-1 alpha-2. None: any destination.
    pub countries: Option<Vec<String>>,
    pub kind: RateKind,
    pub free_above: Option<i64>,
    /// Lower-cased title fragments. None: the cheapest shipping option.
    pub matches: Option<Vec<String>>,
    pub rename: Option<String>,
    /// Lower-cased title fragments of options to hide.
    pub hide: Option<Vec<String>>,
    pub sort_by_price: bool,
}

impl ShippingRule {
    pub fn has_presentation(&self) -> bool {
        self.rename.is_some() || self.hide.is_some() || self.sort_by_price
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShippingRules {
    pub currency: String,
    pub rules: Vec<ShippingRule>,
}

fn is_country(s: &str) -> bool {
    s.len() == 2 && s.bytes().all(|b| b.is_ascii_uppercase())
}

fn read_title_list(v: &RawJson) -> Option<Vec<String>> {
    let n = v.array_len()?;
    if n == 0 || n > MAX_TITLE_MATCHES {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let s = v.get_at_index(i).as_string()?;
        let len = s.chars().count();
        if len == 0 || len > MAX_TITLE_LENGTH || s.trim().is_empty() {
            return None;
        }
        out.push(s.to_lowercase());
    }
    Some(out)
}

fn read_shipping_rule(r: &RawJson) -> Option<ShippingRule> {
    let keys = ["a", "k", "t", "f", "fa", "p", "tr", "m", "n", "h", "s"];
    if !r.is_obj() || !only_keys(r, &keys) {
        return None;
    }
    let audiences = read_audience_list(&r.get_obj_prop("a"))?;

    let k = r.get_obj_prop("k");
    let countries = if present(&k) {
        let n = k.array_len()?;
        if n == 0 || n > MAX_COUNTRIES {
            return None;
        }
        let mut out: Vec<String> = Vec::with_capacity(n);
        for i in 0..n {
            let c = k.get_at_index(i).as_string()?;
            if !is_country(&c) || out.contains(&c) {
                return None;
            }
            out.push(c);
        }
        Some(out)
    } else {
        None
    };

    let money = |key: &str| -> Result<Option<i64>, ()> {
        let x = r.get_obj_prop(key);
        if !present(&x) {
            return Ok(None);
        }
        price_to_units(&x).map(Some).ok_or(())
    };
    let flat = money("f").ok()?;
    let free_above = money("fa").ok()?;
    let pct = r.get_obj_prop("p");
    let tr = r.get_obj_prop("tr");

    // Each type takes exactly its own amount field; any other is malformed.
    let t = r.get_obj_prop("t").as_string()?;
    let kind = match t.as_str() {
        "none" if flat.is_none() && free_above.is_none() && !present(&pct) && !present(&tr) => RateKind::None,
        "free" if flat.is_none() && !present(&pct) && !present(&tr) => RateKind::Free,
        "flat" if !present(&pct) && !present(&tr) => RateKind::Flat(flat?),
        "pct" if flat.is_none() && !present(&tr) => {
            let units = price_to_units(&pct)?;
            if units > MAX_PERCENT_UNITS {
                return None;
            }
            RateKind::Percent(units)
        }
        "tier" if flat.is_none() && !present(&pct) => {
            let n = tr.array_len()?;
            if n == 0 || n > MAX_TIERS_PER_LIST {
                return None;
            }
            let mut tiers = Vec::with_capacity(n);
            for i in 0..n {
                let e = tr.get_at_index(i);
                if e.array_len() != Some(3) {
                    return None;
                }
                let min = price_to_units(&e.get_at_index(0))?;
                let mx = e.get_at_index(1);
                let max = if mx.is_null() {
                    None
                } else {
                    let m = price_to_units(&mx)?;
                    if m < min {
                        return None;
                    }
                    Some(m)
                };
                let amount = price_to_units(&e.get_at_index(2))?;
                tiers.push((min, max, amount));
            }
            RateKind::Tiered(tiers)
        }
        _ => return None,
    };

    let list = |key: &str| -> Result<Option<Vec<String>>, ()> {
        let x = r.get_obj_prop(key);
        if !present(&x) {
            return Ok(None);
        }
        read_title_list(&x).map(Some).ok_or(())
    };
    let matches = list("m").ok()?;
    let hide = list("h").ok()?;

    let n = r.get_obj_prop("n");
    let rename = if present(&n) {
        let s = n.as_string()?;
        let len = s.chars().count();
        if len == 0 || len > MAX_TITLE_LENGTH || s.trim().is_empty() {
            return None;
        }
        Some(s)
    } else {
        None
    };
    let sv = r.get_obj_prop("s");
    let sort_by_price = if present(&sv) {
        match sv.as_string() {
            Some(s) if s == "price" => true,
            _ => return None,
        }
    } else {
        false
    };

    Some(ShippingRule { audiences, countries, kind, free_above, matches, rename, hide, sort_by_price })
}

/// DeliveryCustomization / DiscountAutomaticApp `$app:shipping_rules`
/// `{ "v":2, "c":"USD", "r":[ rule, ... ] }`, rules in TackQuote priority order.
/// The whole document is read: at most 50 rules, read once per run, never per
/// cart line.
pub fn read_shipping_rules(v: Option<&RawJson>) -> Parsed<ShippingRules> {
    let o = match envelope_at(v, CONTRACT_V2) {
        Ok(None) => return Parsed::Absent,
        Ok(Some(o)) => o,
        Err(r) => return Parsed::Malformed(r),
    };
    if !only_keys(o, &["v", "c", "r"]) {
        return Parsed::Malformed("unknown_key");
    }
    let currency = match o.get_obj_prop("c").as_string() {
        Some(s) if is_currency(&s) => s,
        _ => return Parsed::Malformed("currency"),
    };
    let r = o.get_obj_prop("r");
    let n = match r.array_len() {
        Some(n) if (1..=MAX_RULES).contains(&n) => n,
        _ => return Parsed::Malformed("rules"),
    };
    let mut rules = Vec::with_capacity(n);
    for i in 0..n {
        match read_shipping_rule(&r.get_at_index(i)) {
            Some(rule) => rules.push(rule),
            None => return Parsed::Malformed("rule"),
        }
    }
    Parsed::Ok(ShippingRules { currency, rules })
}

/// The cart facts a shipping rule is decided on, in PRESENTMENT currency.
pub struct ShippingFacts<'a> {
    pub subtotal: i64,
    pub presentment: &'a str,
    pub rate: f64,
    /// The delivery group's destination, upper-case ISO alpha-2.
    pub country: Option<&'a str>,
}

/// Which rule sets the rate and which sets the presentation, for one delivery
/// group. `amount` is in presentment units.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedShipping<'a> {
    pub rate: Option<(&'a ShippingRule, i64)>,
    pub presentation: Option<&'a ShippingRule>,
}

/// TackQuote's `evaluateShippingRules` (apps/api/src/modules/shipping-rules/
/// shipping-rule-evaluation.ts), rule for rule, with amounts converted from the
/// shop currency into the presentment currency:
///   * a rule applies to a LINKED buyer in one of its audiences, and, when it
///     names countries, only to a KNOWN destination in the list;
///   * `none` never prices (TackQuote skips it);
///   * `fa` met: free, whatever the type;
///   * `free` with an unmet `fa`: the rule does not apply;
///   * `pct`: that share of the subtotal; `tier`: the first tier whose range
///     holds the subtotal, and no tier means the rule does not apply;
///   * otherwise `flat`.
/// The rate is the first rule that prices; the presentation is the first rule
/// that applies (a `none` rule always applies) and carries rename, hide or
/// sort. Err is a currency mismatch: nothing is applied.
pub fn resolve_shipping<'a>(
    doc: &'a ShippingRules,
    buyer: &Buyer,
    facts: &ShippingFacts,
) -> Result<ResolvedShipping<'a>, &'static str> {
    let conv = |units: i64| to_presentment(units, &doc.currency, facts.presentment, facts.rate);
    if conv(0).is_none() {
        return Err("currency_mismatch");
    }
    let conv = |units: i64| conv(units).unwrap_or(i64::MAX);
    let subtotal = facts.subtotal;

    let mut out = ResolvedShipping { rate: None, presentation: None };
    for rule in &doc.rules {
        if !buyer.audiences().any(|k| rule.audiences.iter().any(|a| a == k)) {
            continue;
        }
        if let Some(list) = &rule.countries {
            match facts.country {
                Some(c) if list.iter().any(|x| x == c) => {}
                _ => continue,
            }
        }
        let amount: Option<Option<i64>> = match &rule.kind {
            RateKind::None => Some(None),
            _ if rule.free_above.map(|fa| subtotal >= conv(fa)).unwrap_or(false) => Some(Some(0)),
            RateKind::Free if rule.free_above.is_some() => None,
            RateKind::Free => Some(Some(0)),
            RateKind::Percent(p) => {
                let s = i128::from(subtotal.max(0));
                Some(Some(((s * i128::from(*p) + 500_000) / 1_000_000) as i64))
            }
            RateKind::Tiered(tiers) => tiers
                .iter()
                .find(|(min, max, _)| subtotal >= conv(*min) && max.map(|m| subtotal <= conv(m)).unwrap_or(true))
                .map(|(_, _, a)| Some(conv(*a))),
            RateKind::Flat(f) => Some(Some(conv(*f))),
        };
        let Some(amount) = amount else { continue };
        if let (None, Some(a)) = (&out.rate, amount) {
            out.rate = Some((rule, a));
        }
        if out.presentation.is_none() && rule.has_presentation() {
            out.presentation = Some(rule);
        }
        if out.rate.is_some() && out.presentation.is_some() {
            break;
        }
    }
    Ok(out)
}

/// Case-insensitive "contains": `needles` are already lower-cased.
pub fn title_matches(title: Option<&str>, needles: &[String]) -> bool {
    match title {
        Some(t) => {
            let t = t.to_lowercase();
            needles.iter().any(|n| t.contains(n.as_str()))
        }
        None => false,
    }
}

/// The option checkout selects by default must be the cheapest (Shopify App
/// Store requirement 1.1.10, and "The cheapest shipping delivery option must
/// always be the first option selected",
/// https://shopify.dev/docs/api/functions/2026-07/delivery-customization).
/// Index of the cheapest; ties keep the earlier option.
pub fn cheapest_index(costs: &[i64]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, c) in costs.iter().enumerate() {
        match best {
            Some(b) if costs[b] <= *c => {}
            _ => best = Some(i),
        }
    }
    best
}

// ---- resolution ----------------------------------------------------------------------

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
/// A level whose ladder has no qualifying tier falls through to the next. A
/// level whose ladder is MALFORMED stops resolution with its reason: falling
/// through would silently price the line from a different book.
pub fn resolve_unit_price<'a>(
    buyer: &'a Buyer,
    vkey: Option<&str>,
    tiers: Option<&'a PriceTiers>,
    qty: i64,
) -> Result<Option<UnitPrice<'a>>, &'static str> {
    match buyer.price_ladder(vkey) {
        Parsed::Malformed(_) => return Err("buyer_tier_list"),
        Parsed::Ok(ladder) => {
            // read_buyer guarantees a currency whenever `p` is present.
            if let (Some(units), Some(cur)) = (select_tier(&ladder, qty), &buyer.currency) {
                return Ok(Some(UnitPrice { units, currency: cur }));
            }
        }
        Parsed::Absent => {}
    }
    if let Some(t) = tiers {
        for key in buyer.audiences() {
            match t.ladder(key) {
                Parsed::Malformed(_) => return Err("tiers_tier_list"),
                Parsed::Ok(ladder) => {
                    if let Some(units) = select_tier(&ladder, qty) {
                        return Ok(Some(UnitPrice { units, currency: &t.currency }));
                    }
                }
                Parsed::Absent => {}
            }
        }
    }
    Ok(None)
}

/// Product dimension: first of the customer's groups with an entry, then "*",
/// then the shop-wide per-variant default. A malformed entry is an error, not
/// a reason to fall back to the default.
pub fn resolve_product_limit(
    buyer: &Buyer,
    variant: Option<&OrderLimits>,
    shop_default: Option<LimitEntry>,
) -> Result<Option<LimitEntry>, &'static str> {
    if let Some(v) = variant {
        for key in buyer.audiences() {
            match v.entry(key) {
                Parsed::Ok(e) => return Ok(Some(e)),
                Parsed::Malformed(_) => return Err("limits_limit_entry"),
                Parsed::Absent => {}
            }
        }
    }
    Ok(shop_default)
}

/// Customer dimension: the customer's own per-variant entry, else the
/// customer's default. Enforced IN ADDITION to the product dimension, which is
/// how TackQuote's order-limits service evaluates rules (every applicable one).
pub fn resolve_customer_limit(buyer: &Buyer, vkey: Option<&str>) -> Result<Option<LimitEntry>, &'static str> {
    match buyer.quantity_limit(vkey) {
        Parsed::Ok(e) => Ok(Some(e)),
        Parsed::Malformed(_) => Err("buyer_limit_entry"),
        Parsed::Absent => Ok(buyer.defaults),
    }
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
