/*
 * Shared selection helpers for the TackQuote blocks.
 *
 * Loaded from Liquid via `asset_url`, because a block's `javascript` schema key
 * allows exactly one file and each block already spends it on its own runtime.
 * Shopify supports both routes.
 *
 * ---------------------------------------------------------------------------
 * Why the runtimes queue instead of calling into this directly
 * ---------------------------------------------------------------------------
 * Schema-declared JavaScript is injected as `<script async>`, so nothing
 * guarantees this file executes before a block runtime that depends on it — and
 * an ordering bug here would surface as a block that works on a fast connection
 * and silently does nothing on a slow one. So each runtime PUSHES its
 * initialiser onto `window.TackQuoteQ` and this file drains the queue, replacing
 * `push` so later arrivals run immediately. Load order stops mattering in both
 * directions.
 *
 * Design notes for everything else in here live in the extension README.
 */
(() => {
  // A merchant can place several blocks on one page, each emitting this tag.
  if (window.TackQuote) return;

  const ns = {};
  window.TackQuote = ns;

  /** The proxy path must stay same-origin and relative, so it cannot be pointed off-store. */
  ns.safeProxyPath = (raw) => {
    if (!raw || raw.charAt(0) !== '/' || raw.indexOf('//') === 0) return null;
    return raw.replace(/\/+$/, '');
  };

  /** A fetch with a hard deadline, so TackQuote latency never becomes storefront latency. */
  ns.fetchJson = (url, options) => {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || 2500;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    return fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || { Accept: 'application/json' },
      body: opts.body,
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined,
    })
      .then((res) => {
        // A dev store's password gate REDIRECTS and fetch follows it, so it arrives as a 200 HTML page, not an HTTP error.
        if (res.redirected && /\/password(\?|$)/.test(res.url)) {
          throw new Error('STOREFRONT_PASSWORD');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // An HTML body is never a valid answer from this API.
        const type = res.headers.get('content-type') || '';
        if (type && type.indexOf('json') === -1) {
          throw new Error('NOT_JSON');
        }
        return res.json();
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  };

  /**
   * Per-tab cache (sessionStorage: a price belongs to the authenticated session).
   * Every access is wrapped because blocked site data throws on the accessor.
   * Keys must carry the customer marker so a logout in the same tab cannot reuse a price.
   */
  ns.cache = {
    read: (key) => {
      try {
        const raw = window.sessionStorage.getItem(`tackquote:${key}`);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || typeof entry.expires !== 'number' || entry.expires < Date.now()) return null;
        return entry.value;
      } catch (_err) {
        return null;
      }
    },
    write: (key, value, ttlMs) => {
      try {
        window.sessionStorage.setItem(
          `tackquote:${key}`,
          JSON.stringify({ value, expires: Date.now() + ttlMs }),
        );
      } catch (_err) {
        // Quota, private mode, or blocked site data. Caching is an optimisation.
      }
    },
  };

  ns.variants = (root) => {
    const node = root.querySelector('.tackquote-variants');
    try {
      const parsed = JSON.parse(node.textContent);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  };

  /*
   * App blocks can see their parent section's `id` and nothing else, so there is
   * no supported way to ask the theme which form belongs to this product.
   * `form[action*="/cart/add"]` is the one selector every Online Store 2.0 theme
   * shares; widening the search keeps blocks working outside the product form.
   */
  ns.form = (root) => {
    const section = root.closest('.shopify-section') || document;
    return (
      root.closest('form[action*="/cart/add"]') ||
      section.querySelector('form[action*="/cart/add"]') ||
      document.querySelector('form[action*="/cart/add"]')
    );
  };

  ns.quantity = (root) => {
    const form = ns.form(root);
    const field = form?.querySelector('[name="quantity"]');
    const n = field ? Number.parseInt(field.value, 10) : 1;
    return Number.isFinite(n) && n > 0 ? n : 1;
  };

  /*
   * Priority: the `?variant=` search param (kept in sync by every theme, and
   * survives back/forward), then the product form's own `id` field, then whatever
   * Liquid rendered initially.
   */
  ns.variantId = (root) => {
    const fromUrl = new URLSearchParams(window.location.search).get('variant');
    if (fromUrl) return String(fromUrl);
    const form = ns.form(root);
    const field = form?.querySelector('[name="id"]');
    return String(field?.value || root.dataset.tackquoteVariant || '');
  };

  ns.findVariant = (list, id) => list.filter((v) => String(v.id) === String(id))[0] || null;

  /*
   * Variant changes. No single cross-theme event exists, so combine: form
   * change/input, popstate, a MutationObserver on the form's input[name="id"]
   * `value` attribute (setAttribute only; a `.value =` assignment is invisible
   * to it), and Horizon's `shopify:product:select` (StandardEvents.productSelect,
   * dispatched before its section fetch resolves, so wait on `event.promise`).
   * Dawn's own variant-change is an in-memory pub/sub, not a DOM event, so Dawn
   * is covered by its bubbling `change` on input[name="id"]. Bursts coalesce.
   */
  ns.onChange = (root, handler) => {
    let timer = null;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(handler, 50);
    };
    const form = ns.form(root);
    if (form) {
      form.addEventListener('change', fire);
      form.addEventListener('input', fire);
      const idField = form.querySelector('input[name="id"]');
      if (idField && typeof MutationObserver === 'function') {
        new MutationObserver(fire).observe(idField, { attributes: true, attributeFilter: ['value'] });
      }
    }
    window.addEventListener('popstate', fire);
    document.addEventListener(
      'shopify:product:select',
      (e) => {
        const p = e && e.promise;
        if (p && typeof p.then === 'function') p.then(fire, fire);
        else fire();
      },
      true,
    );
  };

  ns.label = (root, variant) => {
    const title = root.dataset.tackquoteProduct;
    return variant?.title && variant.title !== 'Default Title'
      ? `${title} - ${variant.title}`
      : title;
  };

  /**
   * Fill `{name}` placeholders in a localized string.
   *
   * Localized copy has to keep its numbers inside the sentence — "Minimum order
   * 10 units" is one word order in English and another in most other
   * languages, so a block cannot concatenate the number onto a fragment and
   * stay translatable. The locale file owns the whole sentence and names its
   * holes; this fills them.
   *
   * Returns '' for a missing template rather than printing `undefined` beside a
   * product, and leaves an unknown placeholder untouched so a typo in a
   * translation is visible to whoever added it instead of silently blanking.
   */
  ns.format = (template, values) => {
    if (!template) return '';
    return String(template).replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(values || {}, key) ? String(values[key]) : match,
    );
  };

  /** Initialise `selector` blocks now and again whenever the theme editor reloads a section. */
  ns.boot = (selector, init) => {
    function run(scope) {
      (scope || document).querySelectorAll(selector).forEach((el) => {
        if (el.dataset.tackquoteReady !== 'true') {
          el.dataset.tackquoteReady = 'true';
          init(el);
        }
      });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        run();
      });
    } else {
      run();
    }
    document.addEventListener('shopify:section:load', (event) => {
      run(event.target);
    });
  };
  const queue = window.TackQuoteQ || [];
  queue.forEach((fn) => {
    fn(ns);
  });
  // Anything that loads after this runs straight away.
  window.TackQuoteQ = {
    push: (fn) => {
      fn(ns);
    },
  };
})();
