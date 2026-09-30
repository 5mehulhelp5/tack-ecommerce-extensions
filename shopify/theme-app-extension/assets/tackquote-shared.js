/*
 * Shared helpers for the TackQuote blocks, loaded from Liquid via `asset_url`
 * (a block's `javascript` key allows one file). Schema JavaScript is injected
 * `async`, so runtimes PUSH initialisers onto `window.TackQuoteQ` and this file
 * drains the queue; load order stops mattering. Design notes: extension README.
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

  /** Per-tab cache (a price belongs to the session); keys carry the customer marker. Blocked storage throws: wrapped. */
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

  /* App blocks see only their section's `id`; `form[action*="/cart/add"]` is the selector every OS 2.0 theme shares. */
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

  /* The LIVE selection first: the form's `id` field (every variant picker writes it), then `?variant=`, then Liquid's. */
  ns.variantId = (root) => {
    const field = ns.form(root)?.querySelector('[name="id"]');
    if (field?.value) return String(field.value);
    const fromUrl = new URLSearchParams(window.location.search).get('variant');
    return String(fromUrl || root.dataset.tackquoteVariant || '');
  };

  /* Merchant-only diagnosis of a FAILED request; copy is emitted in the theme editor only. */
  ns.explain = (root, err, path) => {
    const m = err && err.message ? String(err.message) : '';
    let key = 'msgDiagFail';
    if (m === 'STOREFRONT_PASSWORD') key = 'msgDiagPassword';
    else if (m === 'NOT_JSON') key = 'msgDiagNotJson';
    else if (m === 'HTTP 404') key = 'msgDiag404';
    else if (m === 'HTTP 401' || m === 'HTTP 403') key = 'msgDiagAuth';
    else if (/^HTTP 5/.test(m)) key = 'msgDiag5xx';
    else if (err && err.name === 'AbortError') key = 'msgDiagTimeout';
    return ns.format(root.dataset[key], { path, status: m });
  };

  /** Pure: `shop.money_format` (HTML stripped) with Shopify's placeholders; '' if unusable. */
  ns.shopMoney = (amount, format) => {
    const f = String(format || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ');
    const m = f.match(/\{\{\s*(\w+)\s*\}\}/);
    const SEP = {
      amount: [2, ',', '.'],
      amount_no_decimals: [0, ',', '.'],
      amount_with_comma_separator: [2, '.', ','],
      amount_no_decimals_with_comma_separator: [0, '.', ','],
      amount_with_apostrophe_separator: [2, "'", '.'],
      amount_with_space_separator: [2, ' ', ','],
      amount_no_decimals_with_space_separator: [0, ' ', ','],
    };
    const k = m && SEP[m[1]];
    if (!k || !Number.isFinite(Number(amount))) return '';
    const [whole, frac] = Number(amount).toFixed(k[0]).split('.');
    const n = whole.replace(/\B(?=(\d{3})+(?!\d))/g, k[1]) + (frac ? k[2] + frac : '');
    return f.replace(m[0], n);
  };

  /** Money: the shop's own format when `currency` is the shop's currency, else Intl. */
  ns.money = (amount, currency) => {
    const src = document.querySelector('[data-tackquote-money-format]');
    const d = src ? src.dataset : {};
    if (d.tackquoteMoneyFormat && currency && currency === d.tackquoteShopCurrency) {
      const out = ns.shopMoney(amount, d.tackquoteMoneyFormat);
      if (out) return out;
    }
    try {
      return new Intl.NumberFormat(document.documentElement.lang || 'en', {
        style: 'currency',
        currency: currency || 'USD',
      }).format(amount);
    } catch (_err) {
      return `${String(amount)} ${String(currency || '')}`;
    }
  };

  /* Presentment currency (Liquid cart.currency.iso_code), sent with every price read. */
  ns.pageCurrency = (root) => {
    const c = String(root.dataset.tackquoteCurrency || '').toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : '';
  };
  ns.currencyQuery = (root) => {
    const c = ns.pageCurrency(root);
    return c ? `&currency=${c}` : '';
  };

  /* Pure: 'mismatch' when the server refused the page currency or answered in another one. */
  ns.currencyView = (data, pageCurrency) => {
    if (!data) return 'ok';
    if (data.reason === 'currency_mismatch') return 'mismatch';
    const priced = data.status === 'priced' || data.status === 'ok';
    if (priced && pageCurrency && data.currency && String(data.currency).toUpperCase() !== pageCurrency) {
      return 'mismatch';
    }
    return 'ok';
  };

  ns.findVariant = (list, id) => list.filter((v) => String(v.id) === String(id))[0] || null;

  /* Variant changes: form change/input, popstate, a MutationObserver on input[name="id"]'s value
     attribute, and Horizon's `shopify:product:select` (await its `promise`). Bursts coalesce. */
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

  /* Fill `{name}` holes in a localized sentence; unknown holes stay visible, a missing template is empty. */
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
  // One runtime failing must not stop the others (the floating cart's counter
  // queued behind it would never register).
  queue.forEach((fn) => {
    try {
      fn(ns);
    } catch (_err) {}
  });
  // Anything that loads after this runs straight away.
  window.TackQuoteQ = {
    push: (fn) => {
      fn(ns);
    },
  };
})();
