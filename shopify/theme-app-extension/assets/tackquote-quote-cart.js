/*
 * Quote triggers: the Add to Quote / Request a Quote buttons, every "View
 * quote" trigger, live item counts, and the cart page's "Request a quote for
 * your cart". The drawer and the draft live in tackquote-quote.js (ns.quote).
 *
 * Counts are the number of LINES in the saved quote (a B2B line of 500 units
 * is one item), read straight from localStorage so a badge is right before the
 * drawer runtime loads; kept live by its `tackquote:draft` event, `storage`
 * (other tabs) and `pageshow` (back/forward cache).
 *
 * The cart import reads Shopify's own Ajax Cart API (`cart.js`, same origin,
 * https://shopify.dev/docs/api/ajax/reference/cart): a cart page changes its
 * lines without reloading, so a Liquid snapshot would be stale. No price is
 * read or sent; the 100-line cap is the drawer's, and a full quote fails closed.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  if (ns.quoteCount) return;
  const KEY = `tackquote:draft:${window.location.host}`;
  const shopRoot = () => (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';

  ns.quoteCount = () => {
    try {
      const a = JSON.parse(window.localStorage.getItem(KEY) || '[]');
      return Array.isArray(a) ? a.length : 0;
    } catch (_err) {
      return 0;
    }
  };

  const paint = (n) => {
    const c = typeof n === 'number' ? n : ns.quoteCount();
    document.querySelectorAll('[data-tackquote-count]').forEach((el) => {
      el.textContent = String(c);
      el.hidden = c === 0;
    });
    document.querySelectorAll('[data-tackquote-count-label]').forEach((el) => {
      el.setAttribute('aria-label', ns.format(el.dataset.tackquoteCountLabel, { count: c, label: el.dataset.tackquoteLabel || '' }));
    });
    document.querySelectorAll('[data-tackquote-hide-empty]').forEach((el) => {
      el.hidden = c === 0 && el.dataset.tackquoteHideEmpty !== 'never';
    });
    document.dispatchEvent(new CustomEvent('tackquote:counted', { detail: { count: c } }));
  };
  ns.quotePaint = paint;

  document.addEventListener('tackquote:draft', (e) => paint(e.detail && e.detail.count));
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) paint();
  });
  window.addEventListener('pageshow', () => paint());

  // "View quote": the merchant's Quote page when one is set, else the drawer.
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('[data-tackquote-open]');
    if (!t) return;
    const page = t.dataset.tackquotePage;
    if (page && page.charAt(0) === '/' && page.indexOf('//') !== 0) {
      window.location.href = page;
      return;
    }
    e.preventDefault();
    if (typeof ns.quoteOpen === 'function') ns.quoteOpen(t.closest('[data-tq-root]') || t, t.getAttribute('aria-controls'));
  });

  ns.boot(
    '.tackquote-block[data-tackquote-mode="add"], .tackquote-block[data-tackquote-mode="request"]',
    (root) => {
      const proxy = ns.safeProxyPath(root.dataset.tackquoteProxy);
      const button = root.querySelector('[data-tackquote-action]');
      const status = root.querySelector('[data-tackquote-status]');
      if (!proxy || !button) return;
      const variants = ns.variants(root);

      button.addEventListener('click', () => {
        const q = ns.quote;
        const el = q && q.drawer();
        if (!el) return;
        const variant = ns.findVariant(variants, ns.variantId(root));
        if (variant && variant.available === false) {
          status.textContent = el.dataset.msgUnavailable;
          return;
        }
        const item = {
          variantId: ns.variantId(root),
          name: ns.label(root, variant),
          sku: variant ? variant.sku : '',
          quantity: ns.quantity(root),
        };
        const ctx = {
          proxy,
          currency: root.dataset.tackquoteCurrency,
          customerName: root.dataset.tackquoteCustomerName,
          customerEmail: root.dataset.tackquoteCustomerEmail,
          from: root,
        };
        if (root.dataset.tackquoteMode === 'add') {
          const merged = q.merge([item]);
          if (!merged) {
            status.textContent = el.dataset.msgFull;
            return;
          }
          status.textContent = merged.already ? el.dataset.msgAlready : el.dataset.msgAdded;
          ctx.items = merged.items;
          ctx.persist = true;
        } else {
          // THIS product only, never the accumulated quote.
          ctx.items = [item];
          ctx.persist = false;
        }
        q.open(ctx);
      });
    },
  );

  // Cart page: bring the cart's lines into the quote. Quantities are SET, so
  // pressing it twice never doubles a line.
  ns.boot('.tackquote-qcart', (box) => {
    const d = box.dataset;
    const btn = box.querySelector('[data-tackquote-cart-import]');
    const status = box.querySelector('[data-tackquote-status]');
    if (!btn) return;
    btn.addEventListener('click', () => {
      status.textContent = d.msgSending || '';
      btn.disabled = true;
      fetch(`${shopRoot()}cart.js`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((cart) => {
          const lines = (cart.items || []).map((i) => ({
            variantId: String(i.variant_id),
            name: i.title || i.product_title,
            sku: i.sku || '',
            quantity: i.quantity,
          }));
          if (!lines.length) {
            status.textContent = d.msgCartEmpty;
            return;
          }
          const ok = typeof ns.quoteAdd === 'function' && ns.quoteAdd(lines, { replace: true, note: d.msgCartAdded, from: box });
          status.textContent = ok ? d.msgCartAdded : d.msgFull;
        })
        .catch(() => {
          status.textContent = d.msgCartFailed;
        })
        .finally(() => {
          btn.disabled = false;
        });
    });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => paint());
  else paint();
  document.addEventListener('shopify:section:load', () => paint());
});
