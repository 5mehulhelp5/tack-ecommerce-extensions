/*
 * Price Gate app embed runtime.
 *
 * WHO is gated is decided in Liquid (global `customer` and `customer.tags`),
 * and HIDING is done by the embed's own <style>. This file only adds the
 * "Log in to see prices" link where a price was hidden. So it degrades safely:
 * without this file prices stay hidden, just without the link; with the embed
 * switched off or the app uninstalled, Shopify removes the embed and nothing is
 * left in the theme. https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
 *
 * It renders nothing unless the embed emitted its config node, which happens
 * only for a gated shopper and never in the theme editor.
 */
(() => {
  const PRICE = [
    '.price',
    '.price__container',
    '.price-item',
    'price-per-item',
    '.product__price',
    '.product-price',
    '[data-product-price]',
    '[data-price]',
    '.unit-price',
  ];
  // One link per hidden price is plenty; a collection page can carry hundreds.
  const MAX_LINKS = 120;

  const api = (window.TackQuoteGate = window.TackQuoteGate || {});

  /** Pure: the selector list, merchant extras appended only if they look safe. */
  api.selectors = (extra) => {
    const list = PRICE.slice();
    const raw = String(extra || '');
    if (raw && !/[{}<;@\\]|\/\*/.test(raw)) {
      for (const s of raw.split(',')) {
        const t = s.trim();
        if (t) list.push(t);
      }
    }
    return list.join(', ');
  };

  /** Pure: the outermost matches only, so a nested .price-item inside .price gets one link. */
  api.outermost = (nodes, matches) => nodes.filter((n) => !n.parentElement || !matches(n.parentElement));

  function run() {
    const config = document.getElementById('tackquote-price-gate');
    if (!config) return;
    const href = config.dataset.loginUrl || '/account/login';
    const text = config.dataset.msg || '';
    if (!text) return;
    let selector;
    try {
      selector = api.selectors(config.dataset.extra);
      document.querySelector(selector);
    } catch (_err) {
      selector = api.selectors('');
    }
    const closestPrice = (el) => {
      try {
        return el.closest(selector);
      } catch (_err) {
        return null;
      }
    };
    let made = document.querySelectorAll('.tackquote-gate__login').length;

    const place = () => {
      const found = Array.prototype.slice.call(document.querySelectorAll(selector));
      const tops = api.outermost(found, (p) => Boolean(closestPrice(p)));
      for (const node of tops) {
        if (made >= MAX_LINKS) return;
        const next = node.nextElementSibling;
        if (next && next.classList.contains('tackquote-gate__login')) continue;
        const link = document.createElement('a');
        link.className = 'tackquote-gate__login';
        link.href = href;
        link.textContent = text;
        node.insertAdjacentElement('afterend', link);
        made += 1;
      }
    };

    place();
    // Quick-add drawers, infinite scroll and variant pickers insert prices later.
    if (typeof MutationObserver === 'function') {
      let queued = false;
      const observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        setTimeout(() => {
          queued = false;
          place();
          if (made >= MAX_LINKS) observer.disconnect();
        }, 150);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
