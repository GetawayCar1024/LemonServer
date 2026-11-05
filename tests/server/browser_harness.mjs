// Fresh LemonServer + real Chromium. Helpers intentionally drive pointer events, not only .click().
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const value = probe.address().port; await new Promise(resolve => probe.close(resolve)); return value;
};

export async function withBrowser(action) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const executable = path.resolve(process.argv[2]);
  const chrome = process.env.CHROME_BIN || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
  assert.ok(chrome, 'Install Chromium or set CHROME_BIN');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lemon-editor-'));
  const serverPort = await port(), debugPort = await port(), origin = `http://127.0.0.1:${serverPort}`;
  const env = { ...process.env, ...(process.platform === 'win32' && existsSync('E:/MinGW64/bin/g++.exe') ? { PATH: 'E:/MinGW64/bin;' + process.env.PATH } : {}) };
  const server = spawn(executable, ['--host', '127.0.0.1', '--port', String(serverPort), '--config', path.join(home, 'server.json'), ...(process.argv.includes('--embedded') ? [] : ['--web-root', path.join(repo, 'web')])], { cwd: home, env, windowsHide: true, stdio: 'ignore' });
  const browser = spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--window-size=1440,1000', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(home, 'browser')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserError = '', token, socket, send;
  browser.stderr.on('data', data => { browserError = (browserError + data).slice(-8192); });
  browser.on('error', error => { browserError += error.message; });
  const api = async (method, endpoint, body, raw) => {
    const response = await fetch(origin + endpoint, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': raw === undefined ? 'application/json' : 'application/octet-stream' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(60000) });
    const value = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
    assert.ok(response.ok, `${method} ${endpoint}: ${response.status} ${JSON.stringify(value).slice(0, 500)}`);
    return value;
  };
  try {
    for (let i = 0; i < 150; i++) {
      if (await fetch(origin + '/api/auth/status').then(r => r.ok).catch(() => false)) break;
      assert.equal(server.exitCode, null, 'LemonServer exited during startup'); await delay(100);
    }
    token = (await api('POST', '/api/auth/login', { token: '123456' })).session;
    await api('PUT', '/api/setup', { contestRoot: path.join(home, 'contests') });
    let target;
    for (let i = 0; i < 300 && !target; i++) {
      if (browser.exitCode !== null || browser.signalCode !== null) break;
      target = await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(1000) }).then(r => r.json()).then(items => items.find(item => item.type === 'page')).catch(() => null);
      if (!target) await delay(100);
    }
    assert.ok(target, `Chromium did not start: ${browserError}`);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
    let nextId = 0; const requests = new Map();
    socket.addEventListener('message', event => {
      const response = JSON.parse(event.data), request = requests.get(response.id);
      if (!request) return; requests.delete(response.id);
      response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result);
    });
    send = (method, params = {}) => new Promise((resolve, reject) => { requests.set(++nextId, { resolve, reject }); socket.send(JSON.stringify({ id: nextId, method, params })); });
    const js = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const wait = async (expression, attempts = 200) => {
      for (let i = 0; i < attempts; i++) { if (await js(expression)) return; await delay(50); }
      throw new Error('UI timeout: ' + expression);
    };
    const position = selector => js(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)throw Error('Missing target'); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    const click = async (selector, { button = 'left', modifiers = 0, clickCount = 1 } = {}) => {
      const at = await position(selector);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button, modifiers, clickCount });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button, modifiers, clickCount });
    };
    const drag = async (from, to, modifiers = 0) => {
      const start = await position(from), end = await position(to);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, modifiers, clickCount: 1 });
      for (let i = 1; i <= 12; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (end.x - start.x) * i / 12, y: start.y + (end.y - start.y) * i / 12, button: 'left', buttons: 1, modifiers });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', modifiers, clickCount: 1 });
    };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: origin });
    await wait('!!document.querySelector("#app") && location.origin !== "null"');
    await js(`localStorage.setItem('lemonserver.session', ${JSON.stringify(token)})`);
    const open = async (name, tab = 'tasks') => {
      await send('Page.navigate', { url: `${origin}/?qa=${Date.now()}#/contest/${encodeURIComponent(name)}/${tab}` });
      await wait('!!document.querySelector(".tabpage")');
    };
    await action({ api, js, wait, send, click, drag, open, home, origin, delay });
    if (process.env.LEMON_UI_SCREENSHOT) {
      await delay(250); // capture after the modal's entrance animation, not a translucent intermediate frame
      const image = await send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(process.env.LEMON_UI_SCREENSHOT, Buffer.from(image.data, 'base64'));
    }
  } finally {
    if (send) await Promise.race([send('Browser.close').catch(() => {}), delay(500)]);
    socket?.close(); browser.kill(); server.kill();
    if (process.platform === 'win32' && server.exitCode === null) spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    await delay(300); await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
