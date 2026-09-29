// The writer side of the contract, and the 10,000-byte assumption.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FUNCTION_METAFIELD_MAX_BYTES,
  parseBuyer,
  parsePriceTiers,
  selectTier,
  unitsToDecimalString,
} from './contract.js';
import {
  ContractShapeError,
  ContractSizeError,
  encodeBuyer,
  encodeOrderLimits,
  encodePriceTiers,
  encodeShopLimits,
  utf8Bytes,
} from './encode.js';

describe('the 10,000-byte function metafield limit', () => {
  test('the constant is the documented limit', () => {
    // "Shopify Functions input queries don't return metafield values larger
    // than 10,000 bytes." https://shopify.dev/docs/apps/build/metafields/metafield-limits
    assert.equal(FUNCTION_METAFIELD_MAX_BYTES, 10000);
  });

  // Many groups of three breaks, each adding ~37 bytes.
  function growTiers(untilBytes) {
    const tiers = { '*': [[1, 9.5]] };
    let i = 0;
    let json = encodePriceTiers({ currency: 'USD', tiers });
    while (utf8Bytes(json) < untilBytes) {
      tiers[`G${String(i++).padStart(6, '0')}`] = [[1, 9], [10, 8], [100, 7]];
      json = encodePriceTiers({ currency: 'USD', tiers });
    }
    return { tiers, json };
  }

  test('exactly 10,000 bytes is written and read', () => {
    const { tiers, json } = growTiers(FUNCTION_METAFIELD_MAX_BYTES - 60);
    // Top up with one padded code; `,"<pad>":[[1,1]]` costs 11 bytes + pad.
    // Codes sort after the G-series because "P" > "G".
    const pad = 'P'.repeat(FUNCTION_METAFIELD_MAX_BYTES - utf8Bytes(json) - 11);
    tiers[pad] = [[1, 1]];
    const exact = encodePriceTiers({ currency: 'USD', tiers });
    assert.equal(utf8Bytes(exact), FUNCTION_METAFIELD_MAX_BYTES);
    assert.equal(parsePriceTiers(exact).status, 'ok');
    // ...and one byte more is refused.
    delete tiers[pad];
    tiers[`${pad}P`] = [[1, 1]];
    assert.throws(() => encodePriceTiers({ currency: 'USD', tiers }), (e) => {
      assert.ok(e instanceof ContractSizeError);
      assert.equal(e.bytes, FUNCTION_METAFIELD_MAX_BYTES + 1);
      return true;
    });
  });

  test('over the limit is refused, naming the metafield and its size', () => {
    assert.throws(() => growTiers(FUNCTION_METAFIELD_MAX_BYTES + 1000), (e) => {
      assert.ok(e instanceof ContractSizeError);
      assert.equal(e.kind, 'price_tiers');
      assert.ok(e.bytes > FUNCTION_METAFIELD_MAX_BYTES);
      assert.match(e.message, /10000 bytes/);
      return true;
    });
  });

  test('size is counted in UTF-8 bytes, not characters', () => {
    // 3,400 characters of a 3-byte code point is ~10.2 kB.
    const code = '€'.repeat(34);
    const tiers = {};
    for (let i = 0; i < 100; i++) tiers[`${code}${i}`] = [[1, 1]];
    const chars = JSON.stringify({ v: 1, c: 'USD', t: tiers }).length;
    assert.ok(chars < FUNCTION_METAFIELD_MAX_BYTES, `chars=${chars}`);
    assert.throws(() => encodePriceTiers({ currency: 'USD', tiers }), ContractSizeError);
  });

  test('the per-variant budget: a realistic price book is far below the limit', () => {
    // 10 group ladders of 5 breaks each, plus "*", with 4-dp prices.
    const tiers = { '*': [[1, 19.99], [10, 18.5], [50, 17.25], [100, 16], [500, 15.1234]] };
    for (let g = 0; g < 10; g++) tiers[`GROUP_${g}`] = tiers['*'].map(([q, p]) => [q, p - g * 0.5]);
    const bytes = utf8Bytes(encodePriceTiers({ currency: 'USD', tiers }));
    assert.ok(bytes < 1000, `bytes=${bytes}`);
  });

  test('the customer metafield refuses to grow past the limit with overrides', () => {
    const prices = {};
    for (let i = 0; i < 1000; i++) prices[String(40000000000 + i)] = [[1, 9.99], [12, 8.99]];
    assert.throws(() => encodeBuyer({ groups: ['GOLD'], currency: 'USD', prices }), (e) => {
      assert.ok(e instanceof ContractSizeError);
      assert.equal(e.kind, 'buyer');
      return true;
    });
  });
});

describe('encoders round-trip through the function-side parsers', () => {
  test('price_tiers: sorted audiences and breaks, shortest numbers', () => {
    const json = encodePriceTiers({ currency: 'USD', tiers: { GOLD: [[10, 8], [1, 9.1]], '*': [[1, 9.5]] } });
    assert.equal(json, '{"v":1,"c":"USD","t":{"*":[[1,9.5]],"GOLD":[[1,9.1],[10,8]]}}');
  });
  test('buyer: group order is precedence and is preserved', () => {
    const json = encodeBuyer({ groups: ['SILVER', 'GOLD'] });
    assert.deepEqual(parseBuyer(json).buyer.groups, ['SILVER', 'GOLD']);
  });
  test('order_limits and cart_limits', () => {
    assert.equal(
      encodeOrderLimits({ limits: { '*': { min: 12, step: 12 } } }),
      '{"v":1,"l":{"*":{"min":12,"step":12}}}',
    );
    assert.equal(
      encodeShopLimits({ currency: 'USD', cart: { minTotal: 250 }, defaults: { step: 1 } }),
      '{"v":1,"c":"USD","l":{"minTotal":250},"d":{"step":1}}',
    );
  });
  test('a writer cannot emit what the reader would reject', () => {
    assert.throws(() => encodePriceTiers({ currency: 'usd', tiers: { '*': [[1, 1]] } }), ContractShapeError);
    assert.throws(() => encodeBuyer({ groups: ['*'] }), ContractShapeError);
    assert.throws(() => encodeBuyer({ groups: [], prices: { 1: [[1, 1]] } }), ContractShapeError);
    assert.throws(() => encodeOrderLimits({ limits: { '*': { min: 0 } } }), ContractShapeError);
  });
});

describe('contract primitives', () => {
  test('selectTier boundaries', () => {
    const ladder = [[1, 900], [10, 800], [50, 700]];
    assert.equal(selectTier(ladder, 0), null);
    assert.equal(selectTier(ladder, 1), 900);
    assert.equal(selectTier(ladder, 9), 900);
    assert.equal(selectTier(ladder, 10), 800);
    assert.equal(selectTier(ladder, 50), 700);
  });
  test('decimal strings', () => {
    assert.equal(unitsToDecimalString(0), '0.0');
    assert.equal(unitsToDecimalString(20000), '2.0');
    assert.equal(unitsToDecimalString(16667), '1.6667');
    assert.equal(unitsToDecimalString(10500), '1.05');
  });
});
