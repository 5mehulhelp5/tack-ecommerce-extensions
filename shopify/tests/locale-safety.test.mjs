// Shopify's `t` filter returns translation text already HTML-escaped (unless the key ends in
// `_html`), and every block then applies `| escape` again when writing it into a
// data-msg-* attribute. A `>` therefore reached shoppers and merchants as a literal "&gt;"
// (seen live in the theme editor on 2026-09-30: "TackQuote &gt; Settings &gt; Wholesale").
// Keeping locale strings free of HTML-special characters makes the double escape a no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const locale = JSON.parse(
  readFileSync(new URL('../theme-app-extension/locales/en.default.json', import.meta.url), 'utf8'),
);

function* strings(node, path = '') {
  if (typeof node === 'string') yield [path, node];
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) yield* strings(v, path ? `${path}.${k}` : k);
}

test('no locale string contains an HTML-special character', () => {
  const bad = [...strings(locale)].filter(([, v]) => /[<>&'"]/.test(v));
  assert.deepEqual(bad, []);
});

test('positive control: the walker sees the strings', () => {
  assert.ok([...strings(locale)].length > 20);
});
