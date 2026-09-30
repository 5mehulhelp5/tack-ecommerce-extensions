/*
 * "Add to Quote" on product cards (blocks/quote-cards.liquid, an app embed):
 * collection, search and home grids have no app-block slot, so the embed finds
 * the cards and adds a button after each. The variant is resolved on click
 * through Shopify's own Ajax Product API (`products/{handle}.js`, same origin,
 * https://shopify.dev/docs/api/ajax/reference/product). A single-variant
 * product goes straight into the quote; a product with options opens its page,
 * because guessing a variant would quote the wrong thing. No price is read.
 *
 * No layout shift: the button is OVERLAID in the card's top corner
 * (position:absolute; the card becomes position:relative only if it was
 * static), so nothing visible moves when it arrives.
 * https://shopify.dev/docs/storefronts/themes/best-practices/performance/reserve-space-app-injected
 * Re-scans (debounced) when the theme re-renders the grid: filters, sorting,
 * infinite scroll. Capped per scan so a long page costs little.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  if (ns.cards) return;
  ns.cards = true;
  const cfg = document.querySelector('[data-tackquote-cards]');
  if (!cfg) return;
  const d = cfg.dataset;
  const tpl = cfg.querySelector('template');
  const shopRoot = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  const MAX = 80;
  let selector = d.selector || '.card-wrapper, product-card, .product-card, .product-item, .grid-product';
  try {
    document.querySelector(selector);
  } catch (_err) {
    selector = '.card-wrapper, product-card, .product-card, .product-item, .grid-product';
  }

  const handleOf = (href) => {
    const m = String(href || '').match(/\/products\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  };

  function add(btn, link) {
    const handle = handleOf(link.getAttribute('href'));
    const say = (t) => {
      btn.setAttribute('aria-label', t ? `${btn.dataset.label}. ${t}` : btn.dataset.label);
      const s = btn.parentNode.querySelector('[data-tackquote-card-status]');
      if (s) s.textContent = t;
    };
    // Busy, not disabled: a disabled trigger cannot take focus back when the
    // quote dialog it opened closes.
    if (!handle || btn.getAttribute('aria-busy') === 'true') return;
    btn.setAttribute('aria-busy', 'true');
    fetch(`${shopRoot}products/${encodeURIComponent(handle)}.js`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((p) => {
        if ((p.variants || []).length > 1) {
          window.location.href = link.href;
          return;
        }
        const v = (p.variants || [])[0];
        // Sold out: quotable by default, refused only when the merchant chose so.
        const state = ns.soldOut ? ns.soldOut(v, d.soldOut) : 'ok';
        if (!v || state === 'disable') {
          say(d.msgUnavailable);
          return;
        }
        const name = ns.soldOutName ? ns.soldOutName(p.title, state, d.msgOutOfStock) : p.title;
        // Display price only (cents -> major units); never sent with the request.
        const line = { variantId: String(v.id), name, sku: v.sku || '', quantity: 1, unit: v.price / 100, cur: d.currency };
        const ok = typeof ns.quoteAdd === 'function' && ns.quoteAdd([line], { from: btn.closest('[data-tq-root]') });
        say(ok ? d.msgAdded : d.msgFull);
      })
      .catch(() => say(d.msgFailure))
      .finally(() => {
        btn.removeAttribute('aria-busy');
      });
  }

  function scan() {
    let n = 0;
    for (const card of document.querySelectorAll(selector)) {
      if (n >= MAX) return;
      if (card.querySelector('.tackquote-card-add') || card.closest('[class*="tackquote"]')) continue;
      const link = card.querySelector('a[href*="/products/"]');
      if (!link || !tpl) continue;
      const frag = tpl.content.cloneNode(true);
      const btn = frag.querySelector('button');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        add(btn, link);
      });
      if (window.getComputedStyle(card).position === 'static') card.style.position = 'relative';
      card.appendChild(frag);
      if (ns.theme) ns.theme.apply(card.querySelector('.tackquote-card-add'));
      n += 1;
    }
  }

  let t = null;
  const later = () => {
    clearTimeout(t);
    t = setTimeout(scan, 200);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  if (typeof MutationObserver === 'function') {
    new MutationObserver(later).observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
  }
  document.addEventListener('shopify:section:load', later);
});
