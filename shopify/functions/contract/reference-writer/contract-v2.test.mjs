// Contract v2: the two metafields it adds, and that it leaves v1 alone.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CONTRACT_V2,
  CONTRACT_VERSION,
  FUNCTION_METAFIELD_MAX_BYTES,
  isEntitled,
  parseBuyer,
  parseGroups,
  parseOrderLimits,
  parsePriceTiers,
  parseShippingRules,
  parseShopLimits,
  parseVisibility,
} from './contract.js';
import {
  ContractShapeError,
  ContractSizeError,
  encodeBuyer,
  encodeGroups,
  encodePriceTiers,
  encodeShippingRules,
  encodeVisibility,
  utf8Bytes,
} from './encode.js';

describe('v2 is additive: v1 readers and writers are unchanged', () => {
  test('v1 metafields still carry "v": 1', () => {
    assert.equal(CONTRACT_VERSION, 1);
    assert.equal(CONTRACT_V2, 2);
    assert.equal(JSON.parse(encodePriceTiers({ currency: 'USD', tiers: { '*': [[1, 9]] } })).v, 1);
    assert.equal(JSON.parse(encodeBuyer({ groups: ['gold'] })).v, 1);
  });

  test('a v1 reader treats a v2 envelope as malformed, and a v2 reader a v1 one', () => {
    for (const parse of [parsePriceTiers, parseOrderLimits, parseBuyer, parseShopLimits]) {
      assert.deepEqual(parse({ v: 2, g: [] }), { status: 'malformed', reason: 'version' });
    }
    assert.deepEqual(parseVisibility({ v: 1, a: ['gold'] }), { status: 'malformed', reason: 'version' });
    assert.deepEqual(parseShippingRules({ v: 1, c: 'USD', r: [] }), { status: 'malformed', reason: 'version' });
  });
});

describe('Product $app:visibility', () => {
  test('encodes sorted, deduplicated audience sets', () => {
    assert.equal(encodeVisibility({ allow: ['gold', '*', 'gold'] }), '{"v":2,"a":["*","gold"]}');
    assert.equal(encodeVisibility({ deny: ['*'] }), '{"v":2,"d":["*"]}');
  });

  test('an empty rule is refused, never written as "no restriction"', () => {
    assert.throws(() => encodeVisibility({ allow: [], deny: [] }), ContractShapeError);
  });

  test('entitlement: deny first, then allow; a guest never passes an allow-list', () => {
    const vis = (v) => parseVisibility(v).visibility;
    const gold = { groups: ['gold'] };
    assert.equal(isEntitled(vis({ v: 2, a: ['gold'] }), gold), true);
    assert.equal(isEntitled(vis({ v: 2, a: ['silver'] }), gold), false);
    assert.equal(isEntitled(vis({ v: 2, a: ['*'] }), gold), true);
    assert.equal(isEntitled(vis({ v: 2, a: ['*'] }), null), false);
    assert.equal(isEntitled(vis({ v: 2, a: ['*'], d: ['gold'] }), gold), false);
    assert.equal(isEntitled(vis({ v: 2, d: ['*'] }), gold), false);
    assert.equal(isEntitled(vis({ v: 2, d: ['*'] }), null), true);
  });

  test('50 audiences of 100 characters fit under the function limit', () => {
    const allow = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(97)}`);
    const json = encodeVisibility({ allow });
    assert.ok(utf8Bytes(json) < FUNCTION_METAFIELD_MAX_BYTES, String(utf8Bytes(json)));
    assert.equal(parseVisibility(json).status, 'ok');
  });
});

describe('Customer $app:groups', () => {
  test('is a sorted set of codes and carries nothing else', () => {
    const groups = encodeGroups({ groups: ['net30', 'gold', 'net30'] });
    assert.equal(groups, '{"v":2,"g":["gold","net30"]}');
    assert.deepEqual(parseGroups(groups), { status: 'ok', groups: ['gold', 'net30'] });
  });

  test('the wildcard and duplicates are not groups', () => {
    assert.throws(() => encodeGroups({ groups: ['*'] }), ContractShapeError);
    assert.deepEqual(parseGroups({ v: 2, g: ['a'], p: {} }), { status: 'malformed', reason: 'unknown_key' });
  });
});

describe('$app:shipping_rules', () => {
  const rule = (over) => ({ audiences: ['gold'], type: 'free', ...over });

  test('keeps rule order (TackQuote priority) and normalises each rule', () => {
    const json = encodeShippingRules({
      currency: 'USD',
      rules: [
        rule({ type: 'flat', flatAmount: 7.123456, countries: ['ca', 'us', 'CA'], audiences: ['z', 'a'] }),
        rule({ type: 'none', hide: ['Express'], freeAbove: 10 }),
      ],
    });
    assert.equal(
      json,
      '{"v":2,"c":"USD","r":[{"a":["a","z"],"k":["CA","US"],"t":"flat","f":7.1235},{"a":["gold"],"t":"none","h":["Express"]}]}',
    );
  });

  test('every TackQuote rule type round-trips', () => {
    for (const r of [
      rule({ type: 'free', freeAbove: 500 }),
      rule({ type: 'flat', flatAmount: 0 }),
      rule({ type: 'pct', percentage: 2.5 }),
      rule({ type: 'tier', tiers: [{ min: 0, max: 100, amount: 9 }, { min: 100.0001, amount: 0 }] }),
      rule({ type: 'none', rename: 'Wholesale freight', matches: ['freight'], sortByPrice: true }),
    ]) {
      assert.equal(parseShippingRules(encodeShippingRules({ currency: 'EUR', rules: [r] })).status, 'ok', r.type);
    }
  });

  test('a percentage over 100 and a tier with max below min are refused', () => {
    assert.throws(() => encodeShippingRules({ currency: 'USD', rules: [rule({ type: 'pct', percentage: 101 })] }), ContractShapeError);
    assert.throws(
      () => encodeShippingRules({ currency: 'USD', rules: [rule({ type: 'tier', tiers: [{ min: 10, max: 5, amount: 1 }] })] }),
      ContractShapeError,
    );
  });

  // METAFIELD_CONTRACT.md section 3: ~250 bytes per rule of this shape, so
  // 35 such rules fit and 50 do not. The writer refuses, it never trims.
  test('the documented budget fits: 35 rules with 20 countries, 3 tiers and all presentation fields', () => {
    const rules = Array.from({ length: 35 }, (_, i) => ({
      audiences: [`group-${String(i).padStart(3, '0')}`],
      countries: Array.from({ length: 20 }, (_, j) => String.fromCharCode(65 + (j % 26), 65 + ((j * 7 + i) % 26))),
      type: 'tier',
      tiers: [{ min: 0, max: 999.99, amount: 49.99 }, { min: 1000, max: 4999.99, amount: 19.99 }, { min: 5000, amount: 0 }],
      rename: 'Wholesale freight',
      hide: ['express'],
      sortByPrice: true,
    }));
    const json = encodeShippingRules({ currency: 'USD', rules });
    assert.ok(utf8Bytes(json) < FUNCTION_METAFIELD_MAX_BYTES, String(utf8Bytes(json)));
    console.log(`shipping_rules budget case: ${utf8Bytes(json)} bytes`);
  });

  test('over 10,000 bytes is refused with its size, never trimmed', () => {
    const rules = Array.from({ length: 50 }, (_, i) => ({
      audiences: Array.from({ length: 5 }, (_, j) => `g${i}-${j}-${'x'.repeat(30)}`),
      type: 'free',
    }));
    assert.throws(() => encodeShippingRules({ currency: 'USD', rules }), (e) => {
      assert.ok(e instanceof ContractSizeError);
      assert.equal(e.kind, 'shipping_rules');
      assert.ok(e.bytes > FUNCTION_METAFIELD_MAX_BYTES);
      return true;
    });
  });

  test('more than 50 rules is refused', () => {
    const rules = Array.from({ length: 51 }, () => rule({}));
    assert.throws(() => encodeShippingRules({ currency: 'USD', rules }), ContractShapeError);
  });
});
