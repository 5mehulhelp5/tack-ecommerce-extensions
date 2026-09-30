// Runtime theme discovery (assets/tackquote-theme.js), against computed-style
// fixtures from three structurally different Online Store 2.0 themes.
//
// Zero dependencies: `node --test shopify/tests/theme-detect.test.mjs`.
// The fixtures are what getComputedStyle reports on each theme's own elements:
//   Dawn     r,g,b-triplet tokens; add-to-cart turns SECONDARY (transparent,
//            border drawn by an ::after box-shadow) when dynamic checkout is on;
//   Horizon  full-colour tokens, space-separated rgb() with alpha, pill buttons,
//            uppercase button text;
//   a classic `.btn` theme (Debut-style markup, no Dawn or Horizon tokens) with a
//            gradient, bordered button; and a DARK colour-scheme section whose
//            button fails contrast.
// `T.derive` is the pure core; `T.gather` only collects these same fields from
// the live page, so the decisions tested here are the ones the storefront makes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-app-extension', 'assets');

function load() {
  const document = { readyState: 'complete', querySelectorAll: () => [], addEventListener: () => {} };
  const window = { addEventListener: () => {} };
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout });
  for (const f of ['tackquote-shared.js', 'tackquote-theme.js']) {
    vm.runInContext(readFileSync(join(ASSETS, f), 'utf8'), ctx, { filename: f });
  }
  return window.TackQuote.theme;
}
const T = load();

const btn = (o) => ({
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  color: 'rgb(0, 0, 0)',
  borderTopWidth: '0px',
  borderTopStyle: 'none',
  borderTopColor: 'rgb(0, 0, 0)',
  borderTopLeftRadius: '0px',
  fontFamily: 'serif',
  fontSize: '15px',
  fontWeight: '400',
  letterSpacing: 'normal',
  textTransform: 'none',
  afterShadow: 'none',
  height: '46px',
  ...o,
});

const DAWN = {
  bgs: ['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'],
  fg: 'rgba(18, 18, 18, 0.75)',
  bodySize: '16px',
  heading: { fontFamily: 'Assistant, sans-serif', fontWeight: '400', letterSpacing: '0.6px', textTransform: 'none' },
  buttons: [
    // Add to cart beside dynamic checkout: secondary, ring drawn by ::after.
    btn({
      color: 'rgb(18, 18, 18)',
      fontFamily: 'Assistant, sans-serif',
      letterSpacing: '1px',
      afterShadow: 'rgb(18, 18, 18) 0px 0px 0px 1px, rgba(18, 18, 18, 0) 0px 0px 0px 0px',
    }),
    btn({ backgroundColor: 'rgb(18, 18, 18)', color: 'rgb(255, 255, 255)', fontFamily: 'Assistant, sans-serif' }),
    null,
  ],
  input: { borderTopWidth: '0px', borderTopStyle: 'none', borderTopColor: 'rgb(18, 18, 18)', borderTopLeftRadius: '0px' },
  theme: { accent: 'rgb(18,18,18)', text: 'rgb(255,255,255)' },
};

const HORIZON = {
  bgs: ['rgb(255 255 255 / 1)'],
  fg: 'rgb(0 0 0 / 0.81)',
  bodySize: '16px',
  heading: { fontFamily: 'Inter, sans-serif', fontWeight: '700', letterSpacing: 'normal', textTransform: 'none' },
  buttons: [
    btn({
      backgroundColor: 'rgb(0 0 0 / 1)',
      color: 'rgb(255 255 255 / 1)',
      borderTopLeftRadius: '100px',
      height: '44px',
      fontFamily: 'Inter, sans-serif',
      fontWeight: '600',
      textTransform: 'uppercase',
    }),
    null,
    null,
  ],
  input: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgb(0 0 0 / 0.2)', borderTopLeftRadius: '8px' },
  theme: { accent: 'rgb(0 0 0 / 1)', text: 'rgb(255 255 255 / 1)' },
};

const CLASSIC = {
  bgs: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgb(250, 247, 240)'],
  fg: 'rgb(60, 60, 60)',
  bodySize: '17px',
  heading: { fontFamily: 'Lora, serif', fontWeight: '600', letterSpacing: '1.5px', textTransform: 'uppercase' },
  buttons: [
    btn({
      backgroundColor: 'rgb(122, 36, 36)',
      backgroundImage: 'linear-gradient(rgb(140, 40, 40), rgb(110, 30, 30))',
      color: 'rgb(255, 255, 255)',
      borderTopWidth: '2px',
      borderTopStyle: 'solid',
      borderTopColor: 'rgb(90, 20, 20)',
      borderTopLeftRadius: '4px',
      fontFamily: 'Lato, sans-serif',
      fontWeight: '700',
      letterSpacing: '2px',
      textTransform: 'uppercase',
    }),
    null,
    null,
  ],
  input: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgb(200, 200, 200)', borderTopLeftRadius: '2px' },
  theme: { accent: '', text: '' },
};

const DARK = {
  bgs: ['rgb(20, 20, 20)'],
  fg: 'rgb(240, 240, 240)',
  bodySize: '16px',
  heading: null,
  buttons: [btn({ backgroundColor: 'rgb(200, 200, 0)', color: 'rgb(255, 255, 255)' }), null, null],
  input: null,
  theme: { accent: 'rgb(200,200,0)', text: 'rgb(255,255,255)' },
};

test('contrast is the WCAG 2.1 ratio', () => {
  assert.equal(Math.round(T.contrast([0, 0, 0], [255, 255, 255])), 21);
  assert.equal(T.contrast([255, 255, 255], [255, 255, 255]), 1);
});

test('parse reads both rgb() syntaxes and rejects what it cannot read', () => {
  assert.deepEqual([...T.parse('rgba(18, 18, 18, 0.75)')], [18, 18, 18, 0.75]);
  assert.deepEqual([...T.parse('rgb(0 0 0 / 81%)')], [0, 0, 0, 0.81]);
  assert.equal(T.parse('var(--x)'), null);
});

test('Dawn: the opaque candidate wins over an outline add-to-cart', () => {
  const v = T.derive(DAWN);
  assert.equal(v['--tqd-accent'], 'rgb(18 18 18)');
  assert.equal(v['--tqd-accent-text'], 'rgb(255 255 255)');
  assert.equal(v['--tqd-bg'], 'rgb(255 255 255)');
  assert.equal(v['--tqd-hfont'], 'Assistant, sans-serif');
  assert.equal(v['--tqd-body'], '16px');
  // Dawn draws input borders with a pseudo-element: nothing to copy, so the CSS
  // falls back to its own tokens instead of painting a borderless field.
  assert.equal(v['--tqd-in-border'], undefined);
});

test('Dawn with only the outline add-to-cart: accent from its ::after ring', () => {
  const v = T.derive({ ...DAWN, buttons: [DAWN.buttons[0], null, null] });
  assert.equal(v['--tqd-accent'], 'rgb(18 18 18)');
  assert.equal(v['--tqd-accent-text'], 'rgb(255 255 255)');
  assert.equal(v['--tqd-btn-ls'], '1px');
});

test('Horizon: full-colour tokens, a pill button and uppercase text', () => {
  const v = T.derive(HORIZON);
  assert.equal(v['--tqd-accent'], 'rgb(0 0 0)');
  assert.equal(v['--tqd-btn-radius'], '999px', 'radius at least half the height is a pill');
  assert.equal(v['--tqd-btn-tt'], 'uppercase');
  assert.equal(v['--tqd-in-radius'], '8px');
  assert.equal(v['--tqd-in-border'], '1px solid rgb(0 0 0 / 0.2)');
  assert.equal(v['--tqd-hweight'], '700');
});

test('a classic .btn theme: gradient, border and type are copied, height is not', () => {
  const v = T.derive(CLASSIC);
  assert.equal(v['--tqd-accent'], 'rgb(122 36 36)');
  assert.match(v['--tqd-accent-image'], /^linear-gradient/);
  assert.equal(v['--tqd-accent-border'], '2px solid rgb(90, 20, 20)');
  assert.equal(v['--tqd-btn-radius'], '4px');
  assert.equal(v['--tqd-btn-font'], 'Lato, sans-serif');
  assert.equal(v['--tqd-htt'], 'uppercase');
  assert.equal(v['--tqd-bg'], 'rgb(250 247 240)', 'walks out to the first opaque background');
  assert.equal(
    Object.keys(v).some((k) => /height/.test(k)),
    false,
  );
});

test('a dark section whose button fails AA: the inverted section pair is used', () => {
  const v = T.derive(DARK);
  assert.equal(v['--tqd-accent'], 'rgb(240 240 240)');
  assert.equal(v['--tqd-accent-text'], 'rgb(20 20 20)');
  assert.ok(T.contrast([240, 240, 240], [20, 20, 20]) >= 4.5);
});

test('a failing detected pair defers to passing theme tokens (nothing written)', () => {
  const v = T.derive({ ...DARK, theme: { accent: 'rgb(255,255,255)', text: 'rgb(0,0,0)' } });
  assert.equal(v['--tqd-accent'], undefined);
  assert.equal(v['--tqd-accent-text'], undefined);
});

test('every detected button pair passes WCAG AA', () => {
  for (const [name, fx] of Object.entries({ DAWN, HORIZON, CLASSIC, DARK })) {
    const v = T.derive(fx);
    const a = T.parse(v['--tqd-accent'].replace(/rgb\((\d+) (\d+) (\d+)\)/, 'rgb($1, $2, $3)'));
    const t = T.parse(v['--tqd-accent-text'].replace(/rgb\((\d+) (\d+) (\d+)\)/, 'rgb($1, $2, $3)'));
    assert.ok(T.contrast(a, t) >= 4.5, `${name}: ${T.contrast(a, t).toFixed(2)}`);
  }
});

test('a low-contrast body colour is replaced by black or white', () => {
  const v = T.derive({ ...DARK, fg: 'rgb(40, 40, 40)', buttons: [] });
  assert.equal(v['--tqd-fg'], 'rgb(255 255 255)');
});
