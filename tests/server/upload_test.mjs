import assert from 'node:assert/strict';
import { test } from 'node:test';
import upload from '../../web/upload.js';
class Request {
  static last;
  constructor() { Request.last = this; this.upload = {}; this.headers = {}; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  getAllResponseHeaders() { return 'content-type: application/json\r\n'; }
  send(body) { this.body = body; }
  finish(status = 200) { this.status = status; this.statusText = 'fixture'; this.response = new TextEncoder().encode('{"ok":true}').buffer; this.onload(); }
}
test('byte progress updates before the server response and completion waits for that response', async t => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Request;
  t.after(() => { if (original === undefined) delete globalThis.XMLHttpRequest; else globalThis.XMLHttpRequest = original; });
  const seen = [], body = new Blob(['0123456789']);
  let completed = false;
  const pending = upload.request('/upload', { body, headers: { Authorization: 'fixture' }, onProgress: (loaded, total) => seen.push([loaded, total]) }).then(value => { completed = true; return value; });
  const request = Request.last;
  request.upload.onprogress({ loaded: 2, total: 10, lengthComputable: true });
  request.upload.onprogress({ loaded: 7, total: 10, lengthComputable: true });
  assert.deepEqual(seen, [[2, 10], [7, 10]]);
  request.upload.onload(); await Promise.resolve();
  assert.equal(completed, false);
  request.finish(); const response = await pending;
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(completed, true);
  assert.deepEqual(seen.at(-1), [10, 10]);
});
test('HTTP errors retain their status and network failures reject', async t => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Request;
  t.after(() => { if (original === undefined) delete globalThis.XMLHttpRequest; else globalThis.XMLHttpRequest = original; });
  const failed = upload.request('/upload', { body: new Blob(['x']) });
  Request.last.finish(409); assert.equal((await failed).status, 409);
  const empty = upload.request('/upload', { body: new Blob() });
  Request.last.finish(204); assert.equal((await empty).status, 204);
  const network = upload.request('/upload', { body: new Blob(['x']) });
  Request.last.onerror(); await assert.rejects(network, /上传失败/);
});

test('unreadable local files fail before a network request and are not called network errors', async t => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Request; Request.last = null;
  t.after(() => { globalThis.XMLHttpRequest = original; });
  const file = new File(['data'], 'temporary.cpp');
  file.arrayBuffer = async () => { throw new DOMException('temporary source vanished', 'NotReadableError'); };
  let error;
  const pending = upload.request('/upload', { body: file }).catch(value => { error = value; });
  await new Promise(resolve => setImmediate(resolve));
  if (Request.last) Request.last.onerror();
  await pending;
  assert.equal(error?.code, 'FILE_READ_FAILED');
  assert.match(error.message, /temporary\.cpp/);
  assert.doesNotMatch(error.message, /网络错误/);
  assert.equal(Request.last, null);
});

test('virtual dragged files are captured while available and folder paths are retained', async t => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Request;
  t.after(() => { globalThis.XMLHttpRequest = original; });
  let readable = true;
  const file = new File(['from WinRAR'], 'answer.cpp');
  file.arrayBuffer = async () => { if (!readable) throw new DOMException('gone', 'NotReadableError'); return new TextEncoder().encode('from WinRAR').buffer; };
  const leaf = { isFile: true, isDirectory: false, name: 'answer.cpp', file: ok => ok(file) };
  let listed = false;
  const folder = { isFile: false, isDirectory: true, name: 'round', createReader: () => ({ readEntries: ok => { ok(listed ? [] : [leaf]); listed = true; } }) };
  const items = await upload.collectFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => folder }], files: [] });
  readable = false;
  assert.equal(items[0].rel, 'round/answer.cpp');
  const pending = upload.request('/upload', { body: items[0].file });
  assert.equal(await Request.last.body.text(), 'from WinRAR');
  Request.last.finish(); await pending;
});

test('folder enumeration failures are reported rather than uploading a partial tree', async () => {
  const folder = { isDirectory: true, name: 'unreadable', createReader: () => ({ readEntries: (ok, bad) => bad(new DOMException('denied', 'NotReadableError')) }) };
  await assert.rejects(upload.collectFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => folder }], files: [] }), error => error.code === 'FILE_READ_FAILED' && /unreadable/.test(error.message));
  folder.createReader = () => { throw new DOMException('provider unavailable', 'NotReadableError'); };
  await assert.rejects(upload.collectFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => folder }], files: [] }), error => error.code === 'FILE_READ_FAILED');
});
