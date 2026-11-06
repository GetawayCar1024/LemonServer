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
