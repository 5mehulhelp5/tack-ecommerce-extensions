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

  /**
   * Pure: cart.js lines to quote lines, ONE per variant with quantities summed.
   * A cart can carry the same variant on two lines (different properties or
   * selling plans); with `replace` the second would overwrite the first. The
   * 100-line cap is then counted on the aggregated lines, in the merge.
   */
  ns.cartLines = (items, cur) => {
    const by = new Map();
    for (const i of items || []) {
      const id = String(i.variant_id);
      const q = Number(i.quantity) > 0 ? Number(i.quantity) : 0;
      const had = by.get(id);
      if (had) had.quantity += q;
      else by.set(id, { variantId: id, name: i.title || i.product_title, sku: i.sku || '', quantity: q, unit: typeof i.price === 'number' ? i.price / 100 : undefined, cur });
    }
    return Array.from(by.values()).filter((l) => l.quantity > 0);
  };

  /**
   * Pure. A sold-out variant is QUOTABLE by default (B2B backorders run through
   * quotes); only the merchant's "Disable the button" setting refuses it.
   * Returns 'ok' (in stock or unknown), 'quote' or 'disable'.
   */
  ns.soldOut = (variant, mode) => {
    if (!variant || variant.available !== false) return 'ok';
    return mode === 'disable' ? 'disable' : 'quote';
  };
  /**
   * Pure: attach the DISPLAY prices to a line (never sent; see
   * tackquote-quote-lines.js): the variant's storefront price (Liquid cents ->
   * major units), plus the buyer's TackQuote wholesale price and quantity-break
   * rungs when the price blocks on this page already answered for this SKU.
   */
  ns.productLine = (line, variant, cur) => {
    const out = Object.assign({}, line, { cur: cur || undefined });
    if (variant && typeof variant.price === 'number') out.unit = variant.price / 100;
    const w = ns.wholesale && ns.wholesale[line.sku];
    if (w && (!cur || w.currency === cur)) out.wprice = w.amount;
    const b = ns.breaks && ns.breaks[line.sku];
    if (b && (!cur || b.currency === cur)) out.tiers = b.rows;
    return out;
  };
  /** Pure: a quoted sold-out line says so, for the buyer and the seller. */
  ns.soldOutName = (name, state, label) => (state === 'quote' && label ? `${name} (${label})` : name);

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
      const mode = root.dataset.tackquoteSoldOut;
      const current = () => ns.findVariant(variants, ns.variantId(root));
      // "Disable the button": disabled (the theme's Sold out look) while the
      // selected variant is unavailable, and live across variant changes.
      const sync = () => {
        const off = ns.soldOut(current(), mode) === 'disable';
        button.disabled = off;
        status.textContent = off ? root.dataset.msgUnavailable || '' : '';
      };
      sync();
      ns.onChange(root, sync);

      button.addEventListener('click', () => {
        const q = ns.quote;
        const el = q && q.drawer();
        if (!el) return;
        const variant = current();
        const state = ns.soldOut(variant, mode);
        if (state === 'disable') return;
        const item = ns.productLine(
          {
            variantId: ns.variantId(root),
            name: ns.soldOutName(ns.label(root, variant), state, root.dataset.msgOutOfStock),
            sku: variant ? variant.sku : '',
            quantity: ns.quantity(root),
          },
          variant,
          ns.pageCurrency(root),
        );
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
          const lines = ns.cartLines(cart.items, cart.currency);
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
