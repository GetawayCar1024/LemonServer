// Usage: node tests/server/ui_test.mjs <LemonServer executable>
// Drives the real browser/editor and a fresh local server. Requires Chromium (or CHROME_BIN).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.resolve(process.argv[2]);
const browserPath = process.env.CHROME_BIN || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
assert.ok(browserPath, 'Install Chromium or set CHROME_BIN');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lemon-ui-'));
const port = async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const value = probe.address().port; await new Promise(resolve => probe.close(resolve)); return value;
};
const serverPort = await port(), debugPort = await port(), origin = `http://127.0.0.1:${serverPort}`;
const env = { ...process.env, ...(process.platform === 'win32' && existsSync('E:/MinGW64/bin/g++.exe') ? { PATH: 'E:/MinGW64/bin;' + process.env.PATH } : {}) };
const server = spawn(executable, ['--host', '127.0.0.1', '--port', String(serverPort), '--config', path.join(home, 'server.json'), ...(process.argv.includes('--embedded') ? [] : ['--web-root', path.join(repo, 'web')])], { cwd: home, env, windowsHide: true, stdio: 'ignore' });
const browser = spawn(browserPath, ['--headless', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(home, 'browser')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserError = '';
browser.stderr.on('data', data => { browserError = (browserError + data).slice(-8192); });
browser.on('error', error => { browserError += error.message; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let token, socket, send;
const api = async (method, endpoint, body, raw) => {
  const response = await fetch(origin + endpoint, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
};
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(origin + '/api/auth/status').then(r => r.ok).catch(() => false)) break;
    await delay(100);
  }
  token = (await api('POST', '/api/auth/login', { token: '123456' })).session;
  await api('PUT', '/api/setup', { contestRoot: path.join(home, 'contests') });
  await api('POST', '/api/contests', { name: 'ui-test' });
  const contest = '/api/contests/ui-test';
  for (const [name, content] of Object.entries({ 'sum/1.in': '1 2\n', 'sum/1.out': '3\n' })) await api('PUT', contest + '/files/upload?' + new URLSearchParams({ root: 'data', path: name }), undefined, content);
  await api('POST', contest + '/tasks', { problemTitle: '求和', sourceFileName: 'sum', standardInputCheck: true, standardOutputCheck: true,
    testCases: [{ fullScore: 100, timeLimit: 1000, memoryLimit: 256, inputFiles: ['sum/1.in'], outputFiles: ['sum/missing.out'] }] });
  await api('PUT', contest + '/files/upload?' + new URLSearchParams({ root: 'source', path: 'alice/sum.cpp' }), undefined, '#include <cstdio>\nint main(){long long a,b;scanf("%lld%lld",&a,&b);printf("%lld\\n",a+b);}\n');
  await api('POST', contest + '/refresh');
  let targets;
  for (let i = 0; i < 300 && !targets?.some(t => t.type === 'page'); i++) {
    if (browser.exitCode !== null || browser.signalCode !== null) break;
    targets = await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(1000) }).then(r => r.json()).catch(() => null);
    if (!targets?.some(t => t.type === 'page')) await delay(100);
  }
  assert.ok(targets?.some(t => t.type === 'page'), `Chromium did not start (${browserPath}; exit ${browser.exitCode}; signal ${browser.signalCode}):\n${browserError}`);
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0; const requests = new Map();
  socket.addEventListener('message', event => { const response = JSON.parse(event.data), request = requests.get(response.id); if (request) { requests.delete(response.id); response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result); } });
  send = (method, params = {}) => new Promise((resolve, reject) => { requests.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const wait = async expression => { for (let i = 0; i < 120; i++) { if (await js(expression)) return; await delay(50); } throw new Error('UI timeout: ' + expression); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: origin });
  await wait(`location.origin === ${JSON.stringify(origin)} && !!document.querySelector('#app')`);
  await js(`localStorage.setItem('lemonserver.session', ${JSON.stringify(token)})`);
  await send('Page.navigate', { url: origin + '/?qa=1#/contest/ui-test/tasks' });
  await wait('!!document.querySelector(".tree-item .label")');
  const failures = [];
  await js('document.querySelector(".tree-item .label").click()');
  if (await js('document.querySelectorAll(".tree-item.child").length') !== 0) failures.push('Selecting a task must keep its test cases collapsed');
  if (await js('document.querySelectorAll(".tree-item.child").length') === 0) await js('document.querySelector(".tree-item .twisty").click()');
  await wait('!!document.querySelector(".tree-item.child")');
  await js('document.querySelector(".tree-item .twisty").click()');
  await delay(50);
  if (await js('document.querySelectorAll(".tree-item.child").length') !== 0) failures.push('The selected task must be collapsible');
  if (!await js('!!document.querySelector(".tree-item.child")')) await js('document.querySelector(".tree-item .twisty").click()');
  await wait('!!document.querySelector(".tree-item.child")');
  await js('document.querySelector(".tree-item.child").click()');
  await wait('!!document.querySelector(".editor tbody input")');
  // Correct an old path, then immediately use the same handler as "judge all".
  // The edit must reach the server before judging starts, without a 500 ms pause.
  await js(`(async () => {const input = document.querySelectorAll('.editor tbody input')[1];input.value='sum/1.out';input.dispatchEvent(new Event('input',{bubbles:true}));await startJudge('all');})()`);
  for (let i = 0; i < 300; i++) { if (!(await api('GET', '/api/judge/status')).judging) break; await delay(50); }
  const result = await api('GET', contest + '/contestants/alice');
  if (result.totalScore !== 100) failures.push('Pending editor save was not flushed before judging: ' + JSON.stringify(result.details));
  await js('document.querySelector(".tree-item:not(.child) .label").click()');
  await wait('!!document.querySelector("#f-src")');
  const previousJob = (await api('GET', '/api/judge/status')).job;
  await js(`(async () => {const input=document.querySelector('#f-src');input.value='中文程序';input.dispatchEvent(new Event('input',{bubbles:true}));await startJudge('all');})()`);
  assert.equal((await api('GET', '/api/judge/status')).job, previousJob, 'a rejected save must prevent judging');
  assert.equal((await api('GET', contest + '/tasks/0')).sourceFileName, 'sum', 'invalid save must not mutate the task');
  await js(`(async () => {const input=document.querySelector('#f-src');input.value='sum';input.dispatchEvent(new Event('input',{bubbles:true}));const title=document.querySelector('.editor .form-grid input[type=text]');title.value='renamed';title.dispatchEvent(new Event('input',{bubbles:true}));await startJudge('all');})()`);
  for (let i = 0; i < 300; i++) { if (!(await api('GET', '/api/judge/status')).judging) break; await delay(50); }
  assert.equal((await api('GET', contest + '/tasks/0')).sourceFileName, 'sum', 'display rename must not rename program files');
  assert.equal((await api('GET', contest + '/contestants/alice')).totalScore, 100, 'correcting a rejected save must work on the first retry');
  assert.deepEqual(failures, []);
  console.log('PASS task selection/collapse and save-before-judge browser regressions');
} finally {
  if (send) await Promise.race([send('Browser.close').catch(() => {}), delay(500)]);
  socket?.close(); browser.kill(); server.kill();
  if (process.platform === 'win32' && server.exitCode === null) spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  await delay(300);
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
