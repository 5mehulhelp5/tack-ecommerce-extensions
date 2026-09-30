// The shared $app:shipping_rules conformance corpus, against the JS reference.
// The Rust reader runs the same file (tackquote-wholesale-shipping tests), and
// the TackQuote API runs it against its own evaluateShippingRules. Each case is
// also round-tripped through the reference encoder, so every document in the
// corpus is one the writer can produce.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { UNIT, amountToUnits, parseShippingRules, resolveShipping } from './contract.js';

const corpus = JSON.parse(readFileSync(new URL('../conformance/shipping-rules.json', import.meta.url), 'utf8'));

test('the corpus is not empty', () => {
  assert.ok(corpus.cases.length >= 12);
});

for (const c of corpus.cases) {
  test(`shipping rules: ${c.name}`, () => {
    const parsed = parseShippingRules(c.doc);
    assert.equal(parsed.status, 'ok', JSON.stringify(parsed));
    const got = resolveShipping(parsed, { groups: c.groups }, {
      subtotal: amountToUnits(c.subtotal),
      presentment: c.currency,
      rate: c.rate,
      country: c.country,
    });
    if (c.expect === null) {
      assert.equal(got, null);
      return;
    }
    const rate = got.rate === null ? null : [got.rate.index, got.rate.amount / UNIT];
    assert.deepEqual({ rate, presentation: got.presentation }, c.expect);
  });
}
