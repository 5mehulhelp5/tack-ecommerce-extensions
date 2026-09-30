/*
 * Field rendering and rules for the Wholesale Application block (Wave 3).
 * Split from tackquote-signup.js to keep each asset under 10 KB.
 *
 * Mirrors the ONE server-side schema (apps/api wholesale-form-schema.ts):
 *   types  text, email, tel (Phone), number, select, checkbox, textarea,
 *          file, address, tax_id
 *   showIf { field, equals }: shown only while an EARLIER field holds that
 *          value; a hidden controller hides its dependants. Hidden fields are
 *          disabled (so the browser skips their validation) and never sent.
 *   file   uploaded first as raw bytes to {proxy}/wholesale-upload, then sent
 *          as { uploadId }. The server sniffs the type; the checks here only
 *          save a wasted upload.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  const ADDRESS = ['line1', 'line2', 'city', 'region', 'postalCode', 'country'];
  const ADDRESS_REQUIRED = ['line1', 'city', 'postalCode', 'country'];
  const AUTOCOMPLETE = {
    line1: 'address-line1',
    line2: 'address-line2',
    city: 'address-level2',
    region: 'address-level1',
    postalCode: 'postal-code',
    country: 'country-name',
  };

  const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

  /** Pure: is `field` shown for these values? Same rule as the server. */
  function shown(field, byKey, values, depth) {
    if (!field.showIf) return true;
    if ((depth || 0) > 25) return false;
    const controller = byKey.get(field.showIf.field);
    if (!controller || !shown(controller, byKey, values, (depth || 0) + 1)) return false;
    const current = values[controller.key];
    if (typeof field.showIf.equals === 'boolean') return current === field.showIf.equals;
    return typeof current === 'string' && current.trim() === field.showIf.equals;
  }

  /** Pure: why a chosen file would be refused, or null. */
  function fileProblem(file, field) {
    if (!file) return null;
    const accept = Array.isArray(field.accept) && field.accept.length ? field.accept : null;
    if (accept && file.type && accept.indexOf(file.type) === -1) return 'type';
    const maxMb = Number(field.maxSizeMb) || 5;
    if (file.size > maxMb * 1024 * 1024) return 'size';
    return null;
  }

  /** One field's wrapper, label, help and control. */
  function build(field, idBase, msg) {
    const id = `${idBase}-${field.key}`;
    const wrap = el('div', { className: 'tackquote-signup__field' });
    wrap.dataset.key = field.key;
    const labelText = (field.label || field.key) + (field.required ? ' *' : '');
    let control;

    if (field.type === 'address') {
      const set = el('fieldset', { className: 'tackquote-signup__address' });
      set.appendChild(el('legend', { textContent: labelText }));
      for (const part of ADDRESS) {
        const input = el('input', { type: 'text', id: `${id}-${part}`, name: `${field.key}.${part}` });
        input.autocomplete = AUTOCOMPLETE[part];
        if (field.required && ADDRESS_REQUIRED.indexOf(part) !== -1) input.required = true;
        const label = el('label', { htmlFor: input.id, textContent: msg(`msgAddr_${part}`) || part });
        set.append(label, input);
      }
      wrap.appendChild(set);
    } else {
      if (field.type === 'textarea') {
        control = el('textarea', { rows: 4 });
      } else if (field.type === 'select' && Array.isArray(field.options)) {
        control = el('select');
        // A blank first option, so a required select cannot default to an answer.
        control.appendChild(el('option', { value: '', textContent: msg('msgChoose') || '' }));
        for (const option of field.options) {
          control.appendChild(el('option', { value: String(option), textContent: String(option) }));
        }
      } else if (field.type === 'checkbox') {
        control = el('input', { type: 'checkbox' });
      } else if (field.type === 'file') {
        control = el('input', { type: 'file' });
        if (Array.isArray(field.accept)) control.accept = field.accept.join(',');
      } else {
        const type = ['email', 'tel', 'number'].indexOf(field.type) !== -1 ? field.type : 'text';
        control = el('input', { type });
        if (field.type === 'tel') control.autocomplete = 'tel';
        if (field.type === 'email') control.autocomplete = 'email';
        if (field.type === 'tax_id') control.autocomplete = 'off';
      }
      control.id = id;
      control.name = field.key;
      if (field.required) control.required = true;
      wrap.append(el('label', { htmlFor: id, textContent: labelText }), control);
    }
    if (field.help) wrap.appendChild(el('small', { className: 'tackquote-signup__help', textContent: field.help }));
    return wrap;
  }

  /** The current answer of a field's wrapper; undefined when unanswered. */
  function read(field, wrap) {
    if (field.type === 'address') {
      const out = {};
      for (const part of ADDRESS) {
        const input = wrap.querySelector(`[name="${field.key}.${part}"]`);
        const v = input ? input.value.trim() : '';
        if (v) out[part] = v;
      }
      return Object.keys(out).length ? out : undefined;
    }
    const control = wrap.querySelector(`[name="${field.key}"]`);
    if (!control) return undefined;
    // A checkbox MUST travel as a JSON boolean; "on" is sent for ticked AND unticked.
    if (field.type === 'checkbox') return control.checked === true;
    if (field.type === 'file') return control.files && control.files[0] ? control.files[0] : undefined;
    return control.value;
  }

  /** Show/hide by condition. Hidden wrappers are disabled so validation skips them. */
  function apply(fields, wraps) {
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const values = {};
    fields.forEach((field, i) => {
      const visible = shown(field, byKey, values);
      wraps[i].hidden = !visible;
      for (const c of wraps[i].querySelectorAll('input, select, textarea')) c.disabled = !visible;
      if (visible) {
        const v = read(field, wraps[i]);
        if (typeof v === 'string' || typeof v === 'boolean') values[field.key] = v;
      }
    });
  }

  /** POST and surface the server's own sentence on a 4xx (it names the field). */
  function post(url, body, contentType) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Accept: 'application/json' },
      body,
      credentials: 'same-origin',
    }).then((res) =>
      res
        .json()
        .catch(() => ({}))
        .then((data) => {
          if (!res.ok) {
            const m = data && data.message;
            throw new Error(Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : `HTTP ${res.status}`);
          }
          return data;
        }),
    );
  }

  /** Raw-bytes upload through the App Proxy; resolves to { uploadId }. */
  function upload(proxy, formSlug, field, file) {
    const q = `form=${encodeURIComponent(formSlug || '')}&field=${encodeURIComponent(field.key)}&name=${encodeURIComponent(String(file.name || 'file').slice(0, 120))}`;
    return post(`${proxy}/wholesale-upload?${q}`, file, 'application/octet-stream');
  }

  ns.signupFields = { shown, fileProblem, build, read, apply, post, upload };
  const waiting = ns.signupFieldsWaiting || [];
  ns.signupFieldsWaiting = [];
  waiting.forEach((fn) => fn());
});
