/*
 * The order-limits (minimum order quantity) notice.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `GET {proxy}/order-limits` shipped in the API on 2026-09-04 (#423 Phase 4)
 * and NOTHING CALLED IT. The endpoint was written, tested, throttled and
 * documented; no block, no asset and no locale key ever asked it anything, so
 * the feature reached no merchant. `shopify-proxy-route-coverage.spec.ts` in
 * the API repo is what now fails when that happens again — this file is the
 * other half it was waiting for.
 *
 * ── The one behavioural difference from its siblings ────────────────────────
 *
 * The price and quantity-break blocks HIDE for a shopper they cannot price,
 * because a ladder that does not exist for this viewer is nothing to announce.
 * A minimum is the opposite: it is merchant policy that every visitor is
 * subject to and will hit at checkout regardless, so a signed-out shopper gets
 * the `scope: 'all'` rules and sees them. The controller's own docblock makes
 * the same point — withholding it "hides the whole point of the notice".
 *
 * Buyer- and company-scoped limits still require a resolved identity, and the
 * server sets `accountSpecific` so this block can say "based on your account"
 * only when that is true. Labelling a blanket policy as personal, or a personal
 * one as blanket, is the failure the whole wholesale surface exists to avoid.
 *
 * Identity is asserted by Shopify, never by this page: the request goes to the
 * merchant's own domain at the app proxy path and Shopify signs `shop` and
 * `logged_in_customer_id` with the app secret.
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  /*
   * Deliberately shorter than the 5 minutes the price blocks use.
   *
   * A stale PRICE is embarrassing; a stale MINIMUM is a shopper adding nine
   * units under a rule that now says ten and being refused at checkout — the
   * exact rejection this notice exists to prevent. One minute is long enough to
   * absorb a variant-switch storm and short enough that a merchant editing a
   * rule sees it take effect while they are still looking at the page.
   */
  const CACHE_TTL_MS = 60 * 1000;

  /*
   * The state machine, pure so it is tested on its own (test/blocks-state.test.mjs).
   * `none` is the healthy common answer: hidden for shoppers, and in the theme
   * editor a hint saying where to set rules — never an error.
   */
  ns.limitsView = (data, designMode) => {
    const s = data && data.status;
    if (s === 'limited' && Array.isArray(data.limits) && data.limits.length) return 'list';
    if (!designMode) return 'hide';
    if (s === 'unlinked' && data.reason === 'shop_not_installed') return 'not-connected';
    return 'none';
  };

  ns.boot('.tackquote-block[data-tackquote-mode="order-limits"]', (root) => {
    const proxy = ns.safeProxyPath(root.dataset.tackquoteProxy);
    const body = root.querySelector('[data-tackquote-limits-body]');
    if (!proxy || !body) return;

    const variants = ns.variants(root);
    const designMode = root.dataset.tackquoteDesign === 'true';
    // Not an identity — an identity would have to be signed. This only
    // partitions the per-tab cache so signing out cannot leave an
    // account-specific minimum on screen.
    const customerMarker = root.dataset.tackquoteCustomer || 'anon';
    // `tackquoteProductId`, NOT `tackquoteProduct` — the latter is already the
    // product TITLE everywhere in this extension (`ns.label` reads it), and
    // reusing it here would have sent a product name to the API as an id.
    const productId = root.dataset.tackquoteProductId || '';
    let inFlight = 0;

    function show(node) {
      root.hidden = false;
      body.textContent = '';
      body.appendChild(node);
    }

    function line(text, className) {
      const p = document.createElement('p');
      if (className) p.className = className;
      p.textContent = text;
      return p;
    }

    function standDown(why) {
      if (designMode) {
        const frag = document.createDocumentFragment();
        frag.appendChild(line(root.dataset.msgError, 'tackquote-limits__error'));
        if (why) frag.appendChild(line(why, 'tackquote-price__error-detail'));
        show(frag);
        return;
      }
      root.hidden = true;
    }

    function money(amount, currency) {
      try {
        return new Intl.NumberFormat(document.documentElement.lang || 'en', {
          style: 'currency',
          currency: currency || 'USD',
        }).format(amount);
      } catch (_err) {
        return `${String(amount)} ${String(currency || '')}`;
      }
    }

    /*
     * The merchant's own wording wins whenever they wrote one.
     *
     * `message` is nullable on every rule, so a block that rendered only
     * `limits[].message` would draw an empty notice for every rule the merchant
     * never captioned — which is most of them. The fallbacks below are composed
     * from the bounds the server actually sent, and a rule this build does not
     * understand produces NOTHING rather than a sentence guessed from its name.
     */
    function describe(limit) {
      if (limit.message && limit.message.trim()) return limit.message.trim();

      const { limitType, min, max, currency } = limit;
      const qty = limitType === 'product_qty' || limitType === 'per_product_qty';
      const total = limitType === 'order_total';
      const items = limitType === 'order_item_count' || limitType === 'unique_items';

      const fmt = (n) => (total ? money(n, currency) : String(n));
      const key = qty
        ? 'qty'
        : total
          ? 'total'
          : items
            ? 'items'
            : null;
      if (!key) return null;

      if (min != null && max != null) {
        return ns.format(root.dataset[`msg${key}Range`], { min: fmt(min), max: fmt(max) });
      }
      if (min != null) return ns.format(root.dataset[`msg${key}Min`], { min: fmt(min) });
      if (max != null) return ns.format(root.dataset[`msg${key}Max`], { max: fmt(max) });
      return null;
    }

    function render(data) {
      const view = ns.limitsView(data, designMode);
      // `none` is the common, healthy answer: most products have no minimum.
      // `unlinked` means the shop is not connected — the merchant's problem,
      // not something to narrate on a product page.
      if (view === 'hide') {
        root.hidden = true;
        return;
      }
      if (view === 'not-connected') {
        standDown(root.dataset.msgDiagNotConnected);
        return;
      }
      if (view === 'none') {
        show(line(root.dataset.msgDiagNoLimits || root.dataset.msgEmpty, 'tackquote-limits__error'));
        return;
      }

      const sentences = data.limits.map(describe).filter(Boolean);
      if (sentences.length === 0) {
        root.hidden = true;
        return;
      }

      const wrap = document.createElement('div');
      const list = document.createElement('ul');
      list.className = 'tackquote-limits__list';
      sentences.forEach((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        list.appendChild(li);
      });
      wrap.appendChild(list);

      // Only when the server says so. `accountSpecific` is true exactly when a
      // limit could NOT have been returned to a stranger.
      if (data.accountSpecific) {
        wrap.appendChild(line(root.dataset.msgAccountNote, 'tackquote-limits__note'));
      }
      // Only when TackQuote's checkout validation is confirmed active.
      if (data.checkoutApplied === true) {
        wrap.appendChild(line(root.dataset.msgEnforcedNote, 'tackquote-limits__note'));
      }
      show(wrap);
    }

    function refresh() {
      const variant = ns.findVariant(variants, ns.variantId(root));
      const sku = variant ? variant.sku : '';
      // A product with neither a SKU nor an id cannot be asked about. Both are
      // sent when present: a rule may name either.
      if (!sku && !productId) {
        if (designMode) show(line(root.dataset.msgDiagNoSku, 'tackquote-limits__error'));
        else root.hidden = true;
        return;
      }

      const cacheKey = `limits:${customerMarker}:${proxy}:${sku || productId}`;
      const cached = ns.cache.read(cacheKey);
      const token = ++inFlight;

      if (cached) render(cached);

      const params = [];
      if (sku) params.push(`sku=${encodeURIComponent(sku)}`);
      if (productId) params.push(`productId=${encodeURIComponent(productId)}`);

      ns.fetchJson(`${proxy}/order-limits?${params.join('&')}`)
        .then((data) => {
          if (token !== inFlight) return;
          // `unlinked` is deliberately NOT cached: a merchant who finishes
          // installing must not keep seeing the uninstalled answer. `limited`
          // and `none` are both stable facts about the rules.
          if (data.status === 'limited' || data.status === 'none') {
            ns.cache.write(cacheKey, data, CACHE_TTL_MS);
          }
          render(data);
        })
        .catch((err) => {
          if (token !== inFlight) return;
          // A stale minimum already on screen is better than none: it is the
          // conservative direction, since the shopper is warned rather than
          // surprised at checkout.
          if (cached) return;
          standDown(ns.explain(root, err, proxy));
        });
    }

    ns.onChange(root, refresh);
    refresh();
  });
});
