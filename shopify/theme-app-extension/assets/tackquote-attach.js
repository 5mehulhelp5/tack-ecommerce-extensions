/*
 * The quote form's optional buyer message and attachments (merchant settings
 * "Let buyers add a message" / "Let buyers attach files"). Loaded only by a
 * drawer that offers either.
 *
 * Each file goes up first, as raw bytes, to `${proxy}/quote-upload?name=…`
 * (201 {uploadId, uploadToken?}). A GUEST's first upload returns an
 * `uploadToken`, sent as `upload_token` on the next uploads and as
 * `uploadToken` in the quote request; the request then carries `uploadIds`.
 * Up to 3 PDF, JPEG or PNG files of 5 MB each, checked here only to save a
 * wasted upload: the server decides. An error's own `message` is shown.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  if (ns.quoteExtras) return;
  const MAX_FILES = 3;
  const MAX_MB = 5;
  const TYPES = /^(application\/pdf|image\/jpeg|image\/png)$/;
  const NAMES = /\.(pdf|jpe?g|png)$/i;
  let token = '';
  let sent = new WeakMap(); // File -> uploadId, so a resend never re-uploads

  /** POST; reject with the server's own sentence ({statusCode, message}). */
  const post = (url, body, type) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': type, Accept: 'application/json' },
      body,
      credentials: 'same-origin',
    }).then((r) =>
      r
        .json()
        .catch(() => ({}))
        .then((d) => {
          if (!r.ok) {
            const m = d && d.message;
            throw new Error(Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : `HTTP ${r.status}`);
          }
          return d;
        }),
    );

  ns.quoteExtras = {
    post,
    /** An attachment the server no longer recognises: upload again, then resend. */
    stale: (m) => /^An attached file has expired or was not uploaded from this session/.test(String(m || '')),
    reset: () => {
      token = '';
      sent = new WeakMap();
    },
    /** Resolve to the extra request fields: message, uploadIds, uploadToken. */
    collect: (el, proxy, say) => {
      const d = el.dataset;
      const out = {};
      const msg = el.querySelector('[name="message"]');
      if (msg && msg.value.trim()) out.message = msg.value.trim().slice(0, 2000);
      const input = el.querySelector('[name="files"]');
      const files = input && input.files ? Array.from(input.files) : [];
      if (!files.length) return Promise.resolve(out);
      if (files.length > MAX_FILES) return Promise.reject(new Error(d.msgFilesMax));
      for (const f of files) {
        if (!TYPES.test(f.type) && !NAMES.test(f.name)) {
          return Promise.reject(new Error(ns.format(d.msgFileType, { label: f.name })));
        }
        if (f.size > MAX_MB * 1024 * 1024) {
          return Promise.reject(new Error(ns.format(d.msgFileSize, { label: f.name, max: MAX_MB })));
        }
      }
      const ids = [];
      return files
        .reduce(
          (p, f) =>
            p.then(() => {
              if (sent.has(f)) {
                ids.push(sent.get(f));
                return null;
              }
              say(ns.format(d.msgUploading, { label: f.name }));
              const q = `name=${encodeURIComponent(String(f.name || 'file').slice(0, 120))}${token ? `&upload_token=${encodeURIComponent(token)}` : ''}`;
              return post(`${proxy}/quote-upload?${q}`, f, 'application/octet-stream').then((r) => {
                if (r.uploadToken) token = r.uploadToken;
                sent.set(f, r.uploadId);
                ids.push(r.uploadId);
              });
            }),
          Promise.resolve(),
        )
        .then(() => {
          out.uploadIds = ids;
          if (token) out.uploadToken = token;
          return out;
        });
    },
  };
});
