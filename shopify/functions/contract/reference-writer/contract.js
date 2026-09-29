// TackQuote checkout-pricing metafield contract, version 1.
//
// CANONICAL COPY. Each function extension carries a byte-identical copy at
// `<extension>/src/contract.js`, because Shopify CLI bundles a function from its
// own directory and resolving imports outside it is UNVERIFIED. The copies are
// gated by `shared/contract-copies.test.mjs`: edit this file, then run
// `node shopify/functions/scripts/sync-contract.mjs`.
//
// The human-readable contract is `shopify/functions/METAFIELD_CONTRACT.md`.
// This file is the executable one; where they disagree, fix the doc.
//
// Runtime constraints: this code runs inside Javy (ECMAScript 2020, no event
// loop, no Node globals, no Intl guarantee). It must stay pure and synchronous.
//
// Rule for every parser below: a value that is absent is "absent"; a value
// that is present but does not match the contract is "malformed" and the
// caller OMITS it and logs it. Nothing is ever defaulted. A malformed price
// book must never turn into a price.

export const CONTRACT_VERSION = 1;

// Shopify Functions receive null for any metafield value over 10,000 bytes.
// https://shopify.dev/docs/apps/build/metafields/metafield-limits
export const FUNCTION_METAFIELD_MAX_BYTES = 10000;

// The blanket audience key: "any linked TackQuote buyer". It never applies to
// guests or to Shopify customers who are not linked (no $app:buyer metafield).
export const WILDCARD = '*';

// Money is carried internally as integer 1/10,000ths of a currency unit, so
// retail - tier never picks up binary floating-point error. The contract caps
// prices at four decimal places, which is what TackQuote stores
// (DECIMAL(14,4)).
export const UNIT = 10000;

const MAX_TIERS_PER_LIST = 50;
const MAX_GROUPS = 50;
const MAX_KEY_LENGTH = 100; // buyer_groups.code is VARCHAR(100)
const MAX_QTY = 1000000000;
const MAX_PRICE_UNITS = 1e14; // DECIMAL(14,4) ceiling, in units

const CURRENCY_RE = /^[A-Z]{3}$/;
const VARIANT_KEY_RE = /^[0-9]+$/;

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function onlyKeys(obj, allowed) {
  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && allowed.indexOf(k) === -1) {
      return false;
    }
  }
  return true;
}

function isPosInt(v, max) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;
}

export function isCurrency(v) {
  return typeof v === 'string' && CURRENCY_RE.test(v);
}

// "gid://shopify/ProductVariant/123" -> "123". The contract keys per-variant
// customer overrides by this numeric id to keep the JSON compact.
export function variantKey(gid) {
  if (typeof gid !== 'string') return null;
  const i = gid.lastIndexOf('/');
  const k = i >= 0 ? gid.slice(i + 1) : gid;
  return VARIANT_KEY_RE.test(k) ? k : null;
}

// A contract price: a JSON number, >= 0, at most four decimal places.
export function priceToUnits(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const scaled = v * UNIT;
  const units = Math.round(scaled);
  if (Math.abs(scaled - units) > 1e-6) return null; // more than 4 dp
  if (units > MAX_PRICE_UNITS) return null;
  return units;
}

// A Shopify Decimal from function input, e.g. "10.0". Shopify decides the
// precision here, so this rounds rather than rejects.
export function amountToUnits(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * UNIT);
}

export function unitsToDecimalString(units) {
  const whole = Math.floor(units / UNIT);
  let frac = String(units % UNIT);
  while (frac.length < 4) frac = `0${frac}`;
  frac = frac.replace(/0+$/, '');
  return `${whole}.${frac === '' ? '0' : frac}`;
}

export function parseRate(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// [[minQty, unitPrice], ...], minQty strictly ascending.
export function parseTierList(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TIERS_PER_LIST) return null;
  const out = [];
  let prevQty = 0;
  for (const tier of list) {
    if (!Array.isArray(tier) || tier.length !== 2) return null;
    const qty = tier[0];
    if (!isPosInt(qty, MAX_QTY) || qty <= prevQty) return null;
    const units = priceToUnits(tier[1]);
    if (units === null) return null;
    out.push([qty, units]);
    prevQty = qty;
  }
  return out;
}

// { min?, max?, step? } — positive integers, at least one present.
export function parseLimitEntry(e) {
  if (!isPlainObject(e) || !onlyKeys(e, ['min', 'max', 'step'])) return null;
  const out = {};
  let any = false;
  for (const k of ['min', 'max', 'step']) {
    if (e[k] === undefined) continue;
    if (!isPosInt(e[k], MAX_QTY)) return null;
    out[k] = e[k];
    any = true;
  }
  return any ? out : null;
}

const CART_MONEY_KEYS = ['minTotal', 'maxTotal'];
const CART_COUNT_KEYS = ['minQty', 'maxQty', 'minUnique', 'maxUnique'];

// Cart-level limits: order total (money) and item / distinct-product counts.
export function parseCartLimits(l) {
  if (!isPlainObject(l) || !onlyKeys(l, CART_MONEY_KEYS.concat(CART_COUNT_KEYS))) return null;
  const out = {};
  let any = false;
  for (const k of CART_MONEY_KEYS) {
    if (l[k] === undefined) continue;
    const units = priceToUnits(l[k]);
    if (units === null) return null;
    out[k] = units;
    any = true;
  }
  for (const k of CART_COUNT_KEYS) {
    if (l[k] === undefined) continue;
    if (!isPosInt(l[k], MAX_QTY)) return null;
    out[k] = l[k];
    any = true;
  }
  return any ? out : null;
}

function hasMoney(cart) {
  return cart !== null && (cart.minTotal !== undefined || cart.maxTotal !== undefined);
}

function isAudienceKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY_LENGTH;
}

const ABSENT = { status: 'absent' };

function malformed(reason) {
  return { status: 'malformed', reason };
}

function versionOk(jv) {
  return isPlainObject(jv) && jv.v === CONTRACT_VERSION;
}

// Some callers may receive the raw string (a `value` selection instead of
// `jsonValue`). Accept both so the parser, not the query, owns the contract.
function coerce(jv) {
  if (typeof jv !== 'string') return jv;
  try {
    return JSON.parse(jv);
  } catch (_e) {
    return undefined;
  }
}

// ProductVariant $app:price_tiers
//   { "v":1, "c":"USD", "t": { "<groupCode>|*": [[minQty, unitPrice], ...] } }
export function parsePriceTiers(raw) {
  if (raw === null || raw === undefined) return ABSENT;
  const jv = coerce(raw);
  if (jv === undefined) return malformed('not_json');
  if (!versionOk(jv)) return malformed('version');
  if (!onlyKeys(jv, ['v', 'c', 't'])) return malformed('unknown_key');
  if (!isCurrency(jv.c)) return malformed('currency');
  if (!isPlainObject(jv.t)) return malformed('tiers');
  const tiers = {};
  let count = 0;
  for (const key in jv.t) {
    if (!Object.prototype.hasOwnProperty.call(jv.t, key)) continue;
    if (!isAudienceKey(key)) return malformed('audience_key');
    const list = parseTierList(jv.t[key]);
    if (list === null) return malformed('tier_list');
    tiers[key] = list;
    count++;
  }
  if (count === 0) return malformed('tiers');
  return { status: 'ok', currency: jv.c, tiers };
}

// ProductVariant $app:order_limits
//   { "v":1, "l": { "<groupCode>|*": { "min":12, "max":480, "step":12 } } }
export function parseOrderLimits(raw) {
  if (raw === null || raw === undefined) return ABSENT;
  const jv = coerce(raw);
  if (jv === undefined) return malformed('not_json');
  if (!versionOk(jv)) return malformed('version');
  if (!onlyKeys(jv, ['v', 'l'])) return malformed('unknown_key');
  if (!isPlainObject(jv.l)) return malformed('limits');
  const limits = {};
  let count = 0;
  for (const key in jv.l) {
    if (!Object.prototype.hasOwnProperty.call(jv.l, key)) continue;
    if (!isAudienceKey(key)) return malformed('audience_key');
    const entry = parseLimitEntry(jv.l[key]);
    if (entry === null) return malformed('limit_entry');
    limits[key] = entry;
    count++;
  }
  if (count === 0) return malformed('limits');
  return { status: 'ok', limits };
}

// Customer $app:buyer — its presence is what makes a Shopify customer a
// linked TackQuote buyer.
//   { "v":1, "g":["GOLD"], "c":"USD",
//     "p": { "<variantNumericId>": [[minQty, unitPrice], ...] },
//     "q": { "<variantNumericId>": { "min", "max", "step" } },
//     "d": { "min", "max", "step" },
//     "l": { "minTotal", "maxTotal", "minQty", "maxQty", "minUnique", "maxUnique" } }
export function parseBuyer(raw) {
  if (raw === null || raw === undefined) return ABSENT;
  const jv = coerce(raw);
  if (jv === undefined) return malformed('not_json');
  if (!versionOk(jv)) return malformed('version');
  if (!onlyKeys(jv, ['v', 'g', 'c', 'p', 'q', 'd', 'l'])) return malformed('unknown_key');

  if (!Array.isArray(jv.g) || jv.g.length > MAX_GROUPS) return malformed('groups');
  const groups = [];
  for (const g of jv.g) {
    if (!isAudienceKey(g) || g === WILDCARD || groups.indexOf(g) !== -1) return malformed('groups');
    groups.push(g);
  }

  if (jv.c !== undefined && !isCurrency(jv.c)) return malformed('currency');

  let prices = null;
  if (jv.p !== undefined) {
    if (!isPlainObject(jv.p)) return malformed('prices');
    prices = {};
    for (const k in jv.p) {
      if (!Object.prototype.hasOwnProperty.call(jv.p, k)) continue;
      if (!VARIANT_KEY_RE.test(k)) return malformed('variant_key');
      const list = parseTierList(jv.p[k]);
      if (list === null) return malformed('tier_list');
      prices[k] = list;
    }
  }

  let quantities = null;
  if (jv.q !== undefined) {
    if (!isPlainObject(jv.q)) return malformed('quantities');
    quantities = {};
    for (const k in jv.q) {
      if (!Object.prototype.hasOwnProperty.call(jv.q, k)) continue;
      if (!VARIANT_KEY_RE.test(k)) return malformed('variant_key');
      const entry = parseLimitEntry(jv.q[k]);
      if (entry === null) return malformed('limit_entry');
      quantities[k] = entry;
    }
  }

  let defaults = null;
  if (jv.d !== undefined) {
    defaults = parseLimitEntry(jv.d);
    if (defaults === null) return malformed('limit_entry');
  }

  let cart = null;
  if (jv.l !== undefined) {
    cart = parseCartLimits(jv.l);
    if (cart === null) return malformed('cart_limits');
  }

  // Money without a currency cannot be converted, so it is not a price.
  if ((prices !== null || hasMoney(cart)) && jv.c === undefined) return malformed('currency');

  return {
    status: 'ok',
    buyer: { groups, currency: jv.c || null, prices, quantities, defaults, cart },
  };
}

// Validation $app:cart_limits — shop-wide rules for every linked buyer.
//   { "v":1, "c":"USD", "l": { ...cart limits }, "d": { "min", "max", "step" } }
export function parseShopLimits(raw) {
  if (raw === null || raw === undefined) return ABSENT;
  const jv = coerce(raw);
  if (jv === undefined) return malformed('not_json');
  if (!versionOk(jv)) return malformed('version');
  if (!onlyKeys(jv, ['v', 'c', 'l', 'd'])) return malformed('unknown_key');
  if (jv.c !== undefined && !isCurrency(jv.c)) return malformed('currency');
  let cart = null;
  if (jv.l !== undefined) {
    cart = parseCartLimits(jv.l);
    if (cart === null) return malformed('cart_limits');
  }
  let defaults = null;
  if (jv.d !== undefined) {
    defaults = parseLimitEntry(jv.d);
    if (defaults === null) return malformed('limit_entry');
  }
  if (hasMoney(cart) && jv.c === undefined) return malformed('currency');
  return { status: 'ok', currency: jv.c || null, cart, defaults };
}

// Highest tier whose minQty <= qty, or null when the quantity is below the
// first break.
export function selectTier(list, qty) {
  let best = null;
  for (const tier of list) {
    if (tier[0] <= qty) best = tier[1];
    else break;
  }
  return best;
}

// Precedence for a unit price (first match wins):
//   1. the customer's own override (`p`, from buyer/company price books)
//   2. each of the customer's groups, in the order TackQuote wrote them (`g`)
//   3. the "*" blanket list
// A level whose ladder has no qualifying tier falls through to the next.
export function resolveUnitPrice(buyer, vKey, tiers, qty) {
  if (buyer.prices !== null && vKey !== null && buyer.prices[vKey] !== undefined) {
    const units = selectTier(buyer.prices[vKey], qty);
    if (units !== null) return { units, currency: buyer.currency, source: 'customer' };
  }
  if (tiers !== null) {
    const keys = buyer.groups.concat([WILDCARD]);
    for (const key of keys) {
      const list = tiers.tiers[key];
      if (list === undefined) continue;
      const units = selectTier(list, qty);
      if (units !== null) return { units, currency: tiers.currency, source: key };
    }
  }
  return null;
}

// Product-dimension limit for a variant: the first of the customer's groups
// with an entry, then "*", then the shop-wide per-variant default.
export function resolveProductLimit(buyer, variantLimits, shopDefaults) {
  if (variantLimits !== null) {
    const keys = buyer.groups.concat([WILDCARD]);
    for (const key of keys) {
      if (variantLimits.limits[key] !== undefined) return variantLimits.limits[key];
    }
  }
  return shopDefaults;
}

// Customer-dimension limit for a variant: the customer's per-variant entry,
// then the customer's default. Enforced IN ADDITION to the product dimension,
// which is how TackQuote evaluates order-limit rules (every applicable rule).
export function resolveCustomerLimit(buyer, vKey) {
  if (buyer.quantities !== null && vKey !== null && buyer.quantities[vKey] !== undefined) {
    return buyer.quantities[vKey];
  }
  return buyer.defaults;
}

// Convert store-currency units to the buyer's presentment currency.
//
// Function input money is already in the presentment currency, and
// `presentmentCurrencyRate` converts shop currency to it
// (https://shopify.dev/docs/apps/build/functions/localization-practices-shopify-functions).
// The contract requires prices in the SHOP currency and names that currency
// in `c`, which lets this catch a pipeline that wrote the wrong one:
//   rate == 1  means presentment == shop, so `c` must equal presentment;
//   rate != 1  means presentment != shop, so `c` must NOT equal presentment.
// Returns null on a mismatch; the caller omits and logs.
export function toPresentment(units, sourceCurrency, presentmentCurrency, rate) {
  if (!isCurrency(sourceCurrency) || !isCurrency(presentmentCurrency)) return null;
  if (rate === 1) return sourceCurrency === presentmentCurrency ? units : null;
  if (sourceCurrency === presentmentCurrency) return null;
  return Math.round(units * rate);
}

// Collects omissions and renders one bounded log line. Function logs are
// truncated at 1 kB (https://shopify.dev/docs/apps/build/functions/test-debug-functions),
// so this caps itself well below that. It never logs customer data: only
// reason codes and numeric variant ids.
export function createOmissionLog() {
  const byReason = {};
  const order = [];
  return {
    add(reason, id) {
      if (byReason[reason] === undefined) {
        byReason[reason] = [];
        order.push(reason);
      }
      if (id !== undefined && id !== null && byReason[reason].indexOf(id) === -1) {
        byReason[reason].push(id);
      }
    },
    isEmpty() {
      return order.length === 0;
    },
    render(prefix) {
      let line = `${prefix} omitted:`;
      for (const reason of order) {
        const ids = byReason[reason];
        line += ids.length ? ` ${reason}=${ids.join(',')};` : ` ${reason};`;
      }
      return line.length > 900 ? `${line.slice(0, 897)}...` : line;
    },
  };
}
