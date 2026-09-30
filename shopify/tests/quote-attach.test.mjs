// Buyer message and attachments (assets/tackquote-attach.js) against the
// quote-upload contract: raw bytes to `${proxy}/quote-upload?name=…`, a guest's
// first answer carries `uploadToken`, sent as `upload_token` on the next upload
// and as `uploadToken` in the quote request with `uploadIds`.
// Zero dependencies: `node --test shopify/tests/quote-attach.test.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-app-extension', 'assets');
const calls = [];
let answers = [];
const fetch = (url, opts) => {
  calls.push({ url, opts });
  const a = answers.shift() || { status: 201, body: {} };
  return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) });
};
const document = { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {} };
const window = { location: { search: '', host: 'x' }, addEventListener: () => {} };
const ctx = vm.createContext({ window, document, fetch, URLSearchParams, setTimeout, clearTimeout, WeakMap, Map, Promise });
for (const f of ['tackquote-shared.js', 'tackquote-attach.js']) vm.runInContext(readFileSync(join(ASSETS, f), 'utf8'), ctx);
const X = window.TackQuote.quoteExtras;

const drawer = (files, message) => ({
  dataset: { msgFilesMax: 'max 3', msgFileType: '{label}: type', msgFileSize: '{label}: size {max}', msgUploading: 'up {label}' },
  querySelector: (sel) => (sel.includes('message') ? { value: message || '' } : { files }),
});
const file = (name, type, size = 10) => ({ name, type, size });

test('uploads each file as raw bytes, then carries the guest token forward', async () => {
  calls.length = 0;
  X.reset();
  answers = [
    { status: 201, body: { uploadId: 'u1', uploadToken: 'tok-123456789' } },
    { status: 201, body: { uploadId: 'u2' } },
  ];
  const out = await X.collect(drawer([file('a.pdf', 'application/pdf'), file('b.png', 'image/png')], '  Need 40 by Friday '), '/apps/tq', () => {});
  assert.equal(calls[0].url, '/apps/tq/quote-upload?name=a.pdf');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[1].url, '/apps/tq/quote-upload?name=b.png&upload_token=tok-123456789');
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { message: 'Need 40 by Friday', uploadIds: ['u1', 'u2'], uploadToken: 'tok-123456789' });
});

test('refuses a fourth file, a wrong type or an oversized file before uploading', async () => {
  calls.length = 0;
  const f = file('a.pdf', 'application/pdf');
  await assert.rejects(X.collect(drawer([f, f, f, f]), '/p', () => {}), /max 3/);
  await assert.rejects(X.collect(drawer([file('x.exe', 'application/x-msdownload')]), '/p', () => {}), /x\.exe: type/);
  await assert.rejects(X.collect(drawer([file('big.pdf', 'application/pdf', 6 * 1024 * 1024)]), '/p', () => {}), /big\.pdf: size 5/);
  assert.equal(calls.length, 0);
});

test('shows the server message, and recognises the expired-attachment 400', async () => {
  X.reset();
  answers = [{ status: 413, body: { statusCode: 413, message: 'That file is too large.' } }];
  await assert.rejects(X.collect(drawer([file('a.pdf', 'application/pdf')]), '/p', () => {}), /That file is too large\./);
  assert.ok(X.stale('An attached file has expired or was not uploaded from this session. Upload it again.'));
  assert.ok(!X.stale('Invalid app proxy request'));
});

test('no files and no message: nothing is uploaded and nothing extra is sent', async () => {
  calls.length = 0;
  const out = await X.collect(drawer([]), '/p', () => {});
  assert.deepEqual(JSON.parse(JSON.stringify(out)), {});
  assert.equal(calls.length, 0);
});
