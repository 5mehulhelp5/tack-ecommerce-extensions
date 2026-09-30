/**
 * Wholesale account application, rendered from a TackQuote form definition.
 *
 * Every request goes to the MERCHANT's own domain at the app proxy path, and
 * Shopify forwards it to TackQuote with `shop` and `logged_in_customer_id`
 * signed using the app's client secret. No tenant id travels from this page at
 * all — the server derives it from the signed `shop`.
 *
 * That signature is also what lets this form skip the Turnstile challenge the
 * open public endpoint requires: Turnstile validates a hostname, and this page
 * is on the merchant's domain, not TackQuote's. A signed proxy request is the
 * stronger proof anyway — it names the merchant rather than asserting "probably
 * a human".
 *
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  ns.boot('.tackquote-block[data-tackquote-mode="signup"]', (root) => {
    const proxy = ns.safeProxyPath(root.dataset.tackquoteProxy);
    const body = root.querySelector('[data-tackquote-signup-body]');
    // Blank is the normal case: the server then serves the store's DEFAULT form.
    const formSlug = (root.dataset.tackquoteForm || '').trim();
    if (!proxy || !body) return;
    const url = formSlug
      ? `${proxy}/wholesale-signup/${encodeURIComponent(formSlug)}`
      : `${proxy}/wholesale-signup`;

    const msg = (name) => root.dataset[name] || '';

    function show(node) {
      body.textContent = '';
      body.appendChild(node);
    }

    function line(text, className) {
      const p = document.createElement('p');
      if (className) p.className = className;
      p.textContent = text;
      return p;
    }

    // Field rendering lives in tackquote-signup-fields.js (size budget). Schema
    // JavaScript loads `async`, so wait for it rather than assume an order.
    function withFields(fn) {
      if (ns.signupFields) return fn();
      ns.signupFieldsWaiting = (ns.signupFieldsWaiting || []).concat(fn);
    }

    function renderForm(definition) {
      const f = ns.signupFields;
      const fields = Array.isArray(definition.fields) ? definition.fields : [];
      if (fields.length === 0) {
        show(line(msg('msgUnavailable'), 'tackquote-signup__error'));
        return;
      }

      const form = document.createElement('form');
      form.className = 'tackquote-signup__form';
      const wraps = fields.map((field) => f.build(field, `tq-${formSlug || 'default'}`, msg));
      for (const wrap of wraps) form.appendChild(wrap);
      const refresh = () => f.apply(fields, wraps);
      form.addEventListener('input', refresh);
      form.addEventListener('change', refresh);
      refresh();

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'tackquote-button tackquote-button--theme button button--primary btn tackquote-signup__submit';
      submit.textContent = msg('msgSubmit') || 'Apply';
      form.appendChild(submit);

      const status = document.createElement('p');
      status.className = 'tackquote-signup__status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      form.appendChild(status);

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        refresh();
        if (!form.checkValidity()) {
          status.textContent = msg('msgRequired');
          form.reportValidity();
          return;
        }

        // Only SHOWN fields travel; a hidden field is never sent or required.
        const answers = [];
        for (let i = 0; i < fields.length; i += 1) {
          if (wraps[i].hidden) continue;
          const value = f.read(fields[i], wraps[i]);
          if (value === undefined || value === '') continue;
          if (fields[i].type === 'file') {
            const problem = f.fileProblem(value, fields[i]);
            if (problem) {
              status.textContent = ns.format(msg(problem === 'type' ? 'msgFileType' : 'msgFileSize'), {
                label: fields[i].label,
                max: String(fields[i].maxSizeMb || 5),
              });
              return;
            }
          }
          answers.push([fields[i], value]);
        }

        submit.disabled = true;
        status.textContent = msg('msgSubmitting');
        const slug = definition.slug || formSlug;
        const target = slug ? `${proxy}/wholesale-signup/${encodeURIComponent(slug)}` : url;
        const values = {};

        // Files first, one at a time, then the application that names them.
        answers
          .reduce(
            (chain, [field, value]) =>
              chain.then(() => {
                if (field.type !== 'file') {
                  values[field.key] = value;
                  return null;
                }
                status.textContent = ns.format(msg('msgUploading'), { label: field.label });
                return f.upload(proxy, slug, field, value).then((r) => {
                  values[field.key] = { uploadId: r.uploadId };
                });
              }),
            Promise.resolve(),
          )
          .then(() => f.post(target, JSON.stringify({ values }), 'application/json'))
          .then((result) => {
            const message =
              typeof result?.message === 'string' && result.message.trim() ? result.message : msg('msgSuccess');
            show(line(message, 'tackquote-signup__success'));
          })
          .catch((err) => {
            submit.disabled = false;
            // The server's sentence names the field; a transport failure does not.
            const text = err && err.message && !/^HTTP \d+$/.test(err.message) ? err.message : msg('msgError');
            status.textContent = text;
          });
      });

      show(form);
    }

    ns.fetchJson(url)
      .then((definition) => withFields(() => renderForm(definition)))
      .catch((err) => {
        // 404 = no form switched on. In the theme editor only (the attribute is
        // empty for shoppers), say where to fix it; everyone else sees the plain
        // "not available" line, which is not an error a shopper can act on.
        const noForm = msg('msgNoForm');
        const text = noForm && err && err.message === 'HTTP 404' ? noForm : msg('msgUnavailable');
        show(line(text, 'tackquote-signup__error'));
      });
  });
});
