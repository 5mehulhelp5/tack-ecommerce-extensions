/*
 * Theme discovery for any OS 2.0 theme: what renders around each TackQuote root
 * becomes --tqd-* on THAT root (never :root, never a theme token), sampled per
 * section. Contrast-checked (AA). Design notes: shopify/README.md.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  if (ns.theme) return;
  const T = {};
  ns.theme = T;
  const ROOTS = '.tackquote-block,.tackquote-drawer,.tackquote-qcart,.tackquote-fab,.tackquote-hicon';
  const BUTTONS = [
    'form[action*="/cart/add"] [type="submit"]',
    '.shopify-payment-button__button--unbranded',
    '.button:not(.button--secondary, .button-secondary)',
  ];

  T.parse = (c) => {
    const m = String(c || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)/);
    if (!m) return null;
    let a = m[4] === undefined ? 1 : Number(m[4]);
    if (m[5]) a /= 100;
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  };
  const f = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  T.contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const over = (a, b) => (a[3] >= 1 ? a : [0, 1, 2].map((i) => Math.round(a[i] * a[3] + b[i] * (1 - a[3]))).concat(1));
  const rgb = (c) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
  const px = (v) => Number.parseFloat(v) || 0;
  const opaque = (c) => {
    const p = T.parse(c);
    return Boolean(p && p[3] > 0);
  };

  // Pure core over what the page rendered (see T.gather).
  T.derive = (s) => {
    const out = {};
    const put = (k, v, ok) => {
      if (v && ok !== false && v !== 'normal' && v !== 'none') out[`--tqd-${k}`] = v;
    };
    const firstBg = (s.bgs || []).map(T.parse).find((p) => p && p[3] > 0);
    const bg = over(firstBg || [255, 255, 255, 1], [255, 255, 255, 1]);
    let fg = over(T.parse(s.fg) || [0, 0, 0, 1], bg);
    if (T.contrast(fg, bg) < 4.5) fg = lum(bg) > 0.18 ? [0, 0, 0, 1] : [255, 255, 255, 1];
    put('bg', rgb(bg));
    put('fg', rgb(fg));
    put('body', s.bodySize);

    const h = s.heading;
    if (h && h.fontFamily) {
      put('hfont', h.fontFamily);
      put('hweight', h.fontWeight);
      put('hls', h.letterSpacing);
      put('htt', h.textTransform);
    }

    // Prefer an opaque candidate (Dawn's ATC is secondary beside dynamic checkout).
    const cands = (s.buttons || []).filter(Boolean);
    const b = cands.find((c) => opaque(c.backgroundColor) || /gradient/.test(c.backgroundImage || '')) || cands[0];
    if (b) {
      const solid = opaque(b.backgroundColor);
      const bordered = px(b.borderTopWidth) > 0 && b.borderTopStyle !== 'none';
      let accent;
      let text;
      if (solid) {
        accent = over(T.parse(b.backgroundColor), bg);
        text = over(T.parse(b.color) || fg, accent);
      } else {
        // Outline: accent from the border, or Dawn's ::after ring.
        const ring = String(b.afterShadow || '').match(/rgba?\([^)]*\)/);
        accent = over(T.parse(bordered ? b.borderTopColor : ring && ring[0]) || T.parse(b.color) || fg, bg);
        text = bg;
      }
      const size = px(b.fontSize);
      const need = size >= 24 || (size >= 18.66 && Number(b.fontWeight) >= 700) ? 3 : 4.5;
      if (T.contrast(text, accent) >= need) {
        put('accent', rgb(accent));
        put('accent-text', rgb(text));
        put('accent-image', b.backgroundImage, solid && /gradient/.test(b.backgroundImage || ''));
        put('accent-border', `${b.borderTopWidth} ${b.borderTopStyle} ${b.borderTopColor}`, solid && bordered);
      } else {
        const t = s.theme;
        const ta = t && T.parse(t.accent);
        const tt = t && T.parse(t.text);
        if (!(ta && tt && T.contrast(over(tt, ta), over(ta, bg)) >= need)) {
          put('accent', rgb(fg));
          put('accent-text', rgb(bg));
        }
      }
      const r = px(b.borderTopLeftRadius);
      const hgt = px(b.height);
      put('btn-radius', hgt && r >= hgt / 2 ? '999px' : b.borderTopLeftRadius);
      put('btn-font', b.fontFamily);
      put('btn-weight', b.fontWeight);
      put('btn-ls', b.letterSpacing);
      put('btn-tt', b.textTransform);
    }

    const i = s.input;
    if (i) {
      put('in-border', `${i.borderTopWidth} ${i.borderTopStyle} ${i.borderTopColor}`, px(i.borderTopWidth) > 0 && i.borderTopStyle !== 'none');
      put('in-radius', i.borderTopLeftRadius);
    }
    return out;
  };

  const cs = (el, pseudo) => window.getComputedStyle(el, pseudo);
  const KEYS = 'backgroundColor backgroundImage color borderTopWidth borderTopStyle borderTopColor borderTopLeftRadius fontFamily fontSize fontWeight letterSpacing textTransform'.split(' ');
  const pick = (el) => {
    const c = cs(el);
    const o = {};
    for (const k of KEYS) o[k] = c[k];
    return o;
  };
  // First visible match that is not ours: in the section, else anywhere.
  const first = (sel, scope) =>
    [scope, document]
      .map((w) => Array.from(w.querySelectorAll(sel)).find((el) => !el.closest('[class*="tackquote"]') && el.getClientRects().length))
      .find(Boolean) || null;

  T.gather = (root) => {
    const scope = root.closest('.shopify-section') || document.body;
    const bgs = [];
    for (let n = root.parentElement; n; n = n.parentElement) {
      const c = cs(n).backgroundColor;
      bgs.push(c);
      if (opaque(c)) break;
    }
    const buttons = BUTTONS.map((sel) => {
      const el = first(sel, scope);
      if (!el) return null;
      return Object.assign(pick(el), { afterShadow: cs(el, '::after').boxShadow, height: `${el.getBoundingClientRect().height}px` });
    });
    const h = first('h2, h3', scope) || first('h1, h2, .h1, .h2', document);
    const inp = first('input[type="text"], input[type="email"], .field__input', scope);
    const rs = cs(root);
    const v = (n) => rs.getPropertyValue(n).trim();
    const tok = (a, b) => v(a) || (v(b) && `rgb(${v(b)})`);
    return {
      bgs,
      fg: cs(root.parentElement || document.body).color,
      bodySize: cs(document.body).fontSize,
      heading: h && pick(h),
      buttons,
      input: inp && pick(inp),
      theme: { accent: tok('--color-primary-button-background', '--color-button'), text: tok('--color-primary-button-text', '--color-button-text') },
    };
  };

  const cache = new Map();
  const valuesFor = (root) => {
    const key = root.closest('.shopify-section') || document.body;
    if (!cache.has(key)) {
      let v = {};
      try {
        v = T.derive(T.gather(root));
      } catch (_err) {} // CSS defaults paint
      cache.set(key, v);
    }
    return cache.get(key);
  };

  T.apply = (root, from) => {
    const v = valuesFor(from || root);
    for (const k of Object.keys(v)) root.style.setProperty(k, v[k]);
    const custom = Boolean(cs(root).getPropertyValue('--tqm-accent').trim());
    root.querySelectorAll('.tackquote-button:not(.tackquote-button--outline)').forEach((b) => {
      b.classList.toggle('tackquote-button--custom', custom);
    });
  };

  // The shared dialog wears the opening block's --tqm-* overrides.
  T.carry = (el, from) => {
    const d = el.dataset;
    if (d.tqBase === undefined) d.tqBase = el.getAttribute('style') || '';
    el.setAttribute('style', d.tqBase);
    if (from && from.style) {
      for (const p of Array.from(from.style)) {
        if (p.indexOf('--tqm-') === 0) el.style.setProperty(p, from.style.getPropertyValue(p));
      }
    }
    T.apply(el, from);
  };

  const watched = new WeakSet();
  const run = () => {
    document.querySelectorAll(ROOTS).forEach((root) => {
      T.apply(root);
      const sec = root.closest('.shopify-section');
      if (!sec || watched.has(sec)) return;
      watched.add(sec);
      let t = null;
      new MutationObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
          cache.delete(sec);
          sec.querySelectorAll(ROOTS).forEach((r) => T.apply(r));
        }, 250);
      }).observe(sec, { childList: true, subtree: true });
    });
  };
  const again = () => {
    cache.clear();
    run();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  window.addEventListener('load', again, { once: true });
  for (const e of ['shopify:section:load', 'shopify:section:reorder', 'shopify:block:select']) {
    document.addEventListener(e, again);
  }
});
