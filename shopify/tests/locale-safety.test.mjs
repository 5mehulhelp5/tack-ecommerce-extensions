// Shopify's `t` filter returns translation text already HTML-escaped (unless the key ends in
// `_html`), and every block then applies `| escape` again when writing it into a
// data-msg-* attribute. A `>` therefore reached shoppers and merchants as a literal "&gt;"
// (seen live in the theme editor on 2026-09-30: "TackQuote &gt; Settings &gt; Wholesale").
// Keeping locale strings free of HTML-special characters makes the double escape a no-op.
//
// This covers EVERY locale file: the theme app extension's storefront translations and each
// Function's name/description translations
// (https://shopify.dev/docs/apps/build/functions/localization-practices-shopify-functions).
// Translations must also match the default locale key for key, and keep its placeholders:
// a translated `{min}` is a broken sentence at runtime, not a translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOPIFY = fileURLToPath(new URL('..', import.meta.url));
const THEME_LOCALES = join(SHOPIFY, 'theme-app-extension', 'locales');
const FUNCTIONS = join(SHOPIFY, 'functions');

// The languages the theme app extension ships, beyond English. They are the ones the
// benchmark B2B apps ship that matter for wholesale buyers.
const REQUIRED = ['fr', 'de', 'es', 'it', 'nl', 'pt-BR', 'ja'];

function localeDirs() {
  const dirs = [THEME_LOCALES];
  for (const f of readdirSync(FUNCTIONS)) {
    const d = join(FUNCTIONS, f, 'locales');
    try {
      if (statSync(d).isDirectory()) dirs.push(d);
    } catch {
      // not a function crate
    }
  }
  return dirs;
}

function load(dir, file) {
  return JSON.parse(readFileSync(join(dir, file), 'utf8'));
}

function* strings(node, path = '') {
  if (typeof node === 'string') yield [path, node];
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) yield* strings(v, path ? `${path}.${k}` : k);
}

const placeholders = (s) => (s.match(/\{[a-z_]+\}/g) || []).sort();

test('no locale string in any locale file contains an HTML-special character', () => {
  const bad = [];
  for (const dir of localeDirs())
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')))
      for (const [k, v] of strings(load(dir, f))) if (/[<>&'"]/.test(v)) bad.push(`${dir}/${f}:${k}`);
  assert.deepEqual(bad, []);
});

test('every locale directory ships the required languages, key for key and placeholder for placeholder', () => {
  const dirs = localeDirs();
  assert.ok(dirs.length >= 5, `found ${dirs.length} locale directories`);
  for (const dir of dirs) {
    const base = new Map(strings(load(dir, 'en.default.json')));
    for (const lang of REQUIRED) {
      const tr = new Map(strings(load(dir, `${lang}.json`)));
      assert.deepEqual([...tr.keys()].sort(), [...base.keys()].sort(), `${dir}/${lang}.json keys`);
      for (const [k, v] of base) {
        assert.deepEqual(placeholders(tr.get(k)), placeholders(v), `${dir}/${lang}.json ${k}`);
        if (v.length > 12) assert.notEqual(tr.get(k), v, `${dir}/${lang}.json ${k} is untranslated`);
      }
    }
  }
});

test('positive control: the walker sees the strings', () => {
  assert.ok([...strings(load(THEME_LOCALES, 'en.default.json'))].length > 20);
  assert.ok([...strings(load(THEME_LOCALES, 'ja.json'))].length > 20);
});

test('positive control: the character check rejects a string it must reject', () => {
  assert.ok(/[<>&'"]/.test('Settings > Wholesale'));
  assert.ok(!/[<>&'"]/.test('Settings → Wholesale, l’ordine, „Menge“'));
});
