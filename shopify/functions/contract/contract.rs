// TackQuote checkout-pricing metafield contract, version 1 (function side).
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
    match v {
        None => Ok(None),
        Some(v) if !present(v) => Ok(None),
        Some(v) if v.is_obj() && v.get_obj_prop("v").as_number() == Some(CONTRACT_VERSION) => Ok(Some(v)),
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
