// Catalog visibility in the theme app extension (metafield contract v2).
//
// Every block that offers a PRICE or a QUOTE control for a product must ask
// snippets/tackquote-visibility.liquid first and render nothing when it says
// `hidden`. Liquid cannot be executed here, so this pins the structure, and the
// snippet's rule is pinned against the Function's (`is_entitled` in
// functions/contract/contract.rs) by name and by the checks it makes.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const EXT = new URL('../theme-app-extension/', import.meta.url);
const read = (p) => readFileSync(new URL(p, EXT), 'utf8');

const PRODUCT_BLOCKS = ['wholesale-price', 'quantity-breaks', 'add-to-quote', 'request-a-quote', 'order-limits'];
// Not about one product: nothing to restrict.
const OTHER_BLOCKS = ['buyer-group-badge', 'wholesale-signup', 'credit-application'];

test('the block list is complete', () => {
  const all = readdirSync(new URL('blocks/', EXT)).map((f) => f.replace(/\.liquid$/, '')).sort();
  assert.deepEqual(all, [...PRODUCT_BLOCKS, ...OTHER_BLOCKS].sort());
});

for (const b of PRODUCT_BLOCKS) {
  test(`${b}: asks the visibility snippet and renders nothing for a hidden product`, () => {
    const src = read(`blocks/${b}.liquid`);
    const render = src.indexOf("{% render 'tackquote-visibility', product: product %}");
    const guard = src.indexOf("{%- unless tackquote_access == 'hidden' -%}");
    const end = src.lastIndexOf('{%- endunless -%}');
    const schema = src.indexOf('{% schema %}');
    assert.ok(render > 0, 'renders the snippet');
    assert.ok(guard > render, 'guards after capturing');
    // Everything the block outputs (the proxy setup note and the block itself)
    // sits inside the guard.
    const firstOutput = src.indexOf('{%- if proxy_path == blank -%}');
    assert.ok(firstOutput > guard && end > firstOutput && end < schema, 'the whole block is inside the guard');
    assert.equal(src.slice(end + 1).includes('<div'), false, 'no markup after the guard');
  });
}

for (const b of OTHER_BLOCKS) {
  test(`${b}: is not product-scoped and does not consult visibility`, () => {
    assert.equal(read(`blocks/${b}.liquid`).includes('tackquote-visibility'), false);
  });
}

test('the snippet implements the Function rule: v2 only, deny first, then allow, guests never allowed', () => {
  const s = read('snippets/tackquote-visibility.liquid');
  assert.match(s, /product\.metafields\['\$app'\]\.visibility\.value/);
  assert.match(s, /customer\.metafields\['\$app'\]\.groups\.value/);
  assert.equal(/metafields\['\$app'\]\.buyer/.test(s), false, 'never reads the confidential $app:buyer');
  assert.match(s, /vis\.v == 2/, 'a non-v2 value is not a restriction');
  assert.match(s, /membership\.v == 2/, 'only a v2 $app:groups makes a linked buyer');
  const deny = s.indexOf('for k in vis.d');
  const allow = s.indexOf('for k in vis.a');
  assert.ok(deny > 0 && allow > deny, 'deny is checked before allow');
  assert.match(s, /if entitled and vis\.a != blank\s+assign entitled = false\s+if linked/, 'an allow-list starts closed; only a linked buyer can open it');
  assert.match(s, /k == '\*' or groups contains k/);
  assert.match(s, /request\.design_mode/, 'the merchant sees a note in the editor instead of an empty space');
  assert.match(s, /is_entitled/, 'names the Function rule it mirrors');
});

test('the editor note exists in every storefront locale', () => {
  for (const f of readdirSync(new URL('locales/', EXT)).filter((x) => x.endsWith('.json'))) {
    const l = JSON.parse(read(`locales/${f}`));
    assert.equal(typeof l.tackquote.visibility.editor_note, 'string', f);
  }
});
