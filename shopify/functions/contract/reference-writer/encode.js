// Reference ENCODERS for the TackQuote checkout-pricing metafield contract.
//
// These are what the TackQuote API's push pipeline must be equivalent to. They
// are not shipped inside a function. They exist so the contract has a writer
// under test next to its reader, and so the size rule is executable:
//
//   A value over 10,000 bytes is delivered to a Shopify Function as null
//   (https://shopify.dev/docs/apps/build/metafields/metafield-limits). A buyer
//   whose price book silently became null would pay retail with nothing
//   reported. So the writer REFUSES an oversize value and says which one, and
//   the caller surfaces it as truncated. It never trims tiers to fit.
//
// Every encoder round-trips its own output through the function-side parser,
// so a writer can never emit something the functions would reject.

import {
  CONTRACT_VERSION,
  FUNCTION_METAFIELD_MAX_BYTES,
  UNIT,
  parseBuyer,
  parseOrderLimits,
  parsePriceTiers,
  parseShopLimits,
} from './contract.js';

export class ContractSizeError extends Error {
  constructor(kind, bytes) {
    super(`${kind} is ${bytes} bytes; Shopify Functions read no metafield value over ${FUNCTION_METAFIELD_MAX_BYTES} bytes`);
    this.name = 'ContractSizeError';
    this.kind = kind;
    this.bytes = bytes;
  }
}

export class ContractShapeError extends Error {
  constructor(kind, reason) {
    super(`${kind} does not match the contract: ${reason}`);
    this.name = 'ContractShapeError';
    this.kind = kind;
    this.reason = reason;
  }
}

export function utf8Bytes(s) {
  return new TextEncoder().encode(s).length;
}

// Prices go out as the shortest JSON number for a value with <= 4 decimals.
function price(v) {
  return Number((Math.round(v * UNIT) / UNIT).toFixed(4));
}

function sortedObject(obj, mapValue) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = mapValue(obj[k]);
  return out;
}

function tiers(list) {
  return list
    .map((t) => [t[0], price(t[1])])
    .sort((a, b) => a[0] - b[0]);
}

function limitEntry(e) {
  const out = {};
  for (const k of ['min', 'max', 'step']) if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  return out;
}

function cartLimits(l) {
  const out = {};
  for (const k of ['minTotal', 'maxTotal']) if (l[k] !== undefined && l[k] !== null) out[k] = price(l[k]);
  for (const k of ['minQty', 'maxQty', 'minUnique', 'maxUnique']) if (l[k] !== undefined && l[k] !== null) out[k] = l[k];
  return out;
}

function finish(kind, obj, parse) {
  const json = JSON.stringify(obj);
  const bytes = utf8Bytes(json);
  if (bytes > FUNCTION_METAFIELD_MAX_BYTES) throw new ContractSizeError(kind, bytes);
  const parsed = parse(json);
  if (parsed.status !== 'ok') throw new ContractShapeError(kind, parsed.reason || parsed.status);
  return json;
}

/** @param {{currency: string, tiers: Record<string, Array<[number, number]>>}} input */
export function encodePriceTiers(input) {
  return finish(
    'price_tiers',
    { v: CONTRACT_VERSION, c: input.currency, t: sortedObject(input.tiers, tiers) },
    parsePriceTiers,
  );
}

/** @param {{limits: Record<string, {min?: number, max?: number, step?: number}>}} input */
export function encodeOrderLimits(input) {
  return finish('order_limits', { v: CONTRACT_VERSION, l: sortedObject(input.limits, limitEntry) }, parseOrderLimits);
}

/**
 * @param {{groups: string[], currency?: string, prices?: Record<string, Array<[number, number]>>,
 *          quantities?: Record<string, object>, defaults?: object, cart?: object}} input
 */
export function encodeBuyer(input) {
  // `g` keeps TackQuote's precedence order; it is NOT sorted.
  const obj = { v: CONTRACT_VERSION, g: input.groups.slice() };
  if (input.currency) obj.c = input.currency;
  if (input.prices && Object.keys(input.prices).length) obj.p = sortedObject(input.prices, tiers);
  if (input.quantities && Object.keys(input.quantities).length) obj.q = sortedObject(input.quantities, limitEntry);
  if (input.defaults) obj.d = limitEntry(input.defaults);
  if (input.cart) obj.l = cartLimits(input.cart);
  return finish('buyer', obj, parseBuyer);
}

/** @param {{currency?: string, cart?: object, defaults?: object}} input */
export function encodeShopLimits(input) {
  const obj = { v: CONTRACT_VERSION };
  if (input.currency) obj.c = input.currency;
  if (input.cart) obj.l = cartLimits(input.cart);
  if (input.defaults) obj.d = limitEntry(input.defaults);
  return finish('cart_limits', obj, parseShopLimits);
}
