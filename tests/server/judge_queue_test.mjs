// Judging queue regressions against a real LemonServer (needs g++):
// cancel keeps previous results, stop makes the running cells unjudged, identical uploads keep results,
// results survive a hard kill, and a burst of concurrent judge requests does not bring the server down.
// Usage: node tests/server/judge_queue_test.mjs /path/to/LemonServer
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const value = probe.address().port; await new Promise(resolve => probe.close(resolve)); return value;
};
const executable = path.resolve(process.argv[2]);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lemon-queue-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let server, token;
const start = async () => {
  server = spawn(executable, ['--host', '127.0.0.1', '--port', String(port), '--config', path.join(home, 'server.json')], { cwd: home, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin + '/api/auth/status').then(r => r.ok).catch(() => false)) return;
    assert.equal(server.exitCode, null, 'LemonServer exited during startup'); await delay(100);
  }
  throw new Error('LemonServer did not start');
};
const kill = async () => {
  server.kill('SIGKILL');
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  for (let i = 0; i < 50 && server.exitCode === null && server.signalCode === null; i++) await delay(100);
};
const api = async (method, endpoint, body, raw) => {
  const response = await fetch(origin + endpoint, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': raw === undefined ? 'application/json' : 'application/octet-stream' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(60000) });
  const value = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  if (!response.ok) { const error = new Error(`${method} ${endpoint}: ${response.status} ${JSON.stringify(value).slice(0, 300)}`); error.status = response.status; throw error; }
  return value;
};
const idle = async () => { for (let i = 0; i < 2400; i++) { if (!(await api('GET', '/api/judge/status')).judging) return; await delay(50); } throw new Error('judging did not finish'); };

const base = '/api/contests/queue-test';
const people = ['p1', 'p2', 'p3', 'p4'];
// about 0.4 s of CPU time per case, so that a run can be interrupted halfway
const slow = '#include <cstdio>\n#include <ctime>\nint main(){volatile unsigned long x=0;std::clock_t t=std::clock();while(std::clock()-t<0.4*CLOCKS_PER_SEC)x++;int a;if(scanf("%d",&a)!=1)return 1;printf("%d\\n",a);}\n';
const upload = (root, file, content) => api('PUT', base + '/files/upload?' + new URLSearchParams({ root, path: file }), undefined, content);
const cells = async () => Object.fromEntries(await Promise.all(people.map(async who => [who, (await api('GET', base + '/contestants/' + who)).details[0]])));
const runAndInterrupt = async (action) => {
  await api('POST', base + '/judge', { mode: 'all' });
  for (let i = 0; i < 400; i++) { const st = await api('GET', '/api/judge/status'); if (st.running && st.progress > 0) break; await delay(25); }
  await api('POST', base + '/judge/' + action);
  await idle();
};

try {
  await start();
  token = (await api('POST', '/api/auth/login', { token: '123456' })).session;
  await api('PUT', '/api/setup', { contestRoot: path.join(home, 'contests') });
  await api('POST', '/api/contests', { name: 'queue-test' });
  const testCases = [1, 2, 3].map(n => ({ fullScore: 10, timeLimit: 5000, memoryLimit: 256, inputFiles: [`echo/${n}.in`], outputFiles: [`echo/${n}.out`] }));
  for (let n = 1; n <= 3; n++) { await upload('data', `echo/${n}.in`, `${n}\n`); await upload('data', `echo/${n}.out`, `${n}\n`); }
  await api('POST', base + '/tasks', { problemTitle: 'Echo', sourceFileName: 'echo', standardInputCheck: true, standardOutputCheck: true, testCases });
  for (const who of people) await upload('source', `${who}/echo.cpp`, slow);
  await api('POST', base + '/refresh');
  await api('POST', base + '/judge', { mode: 'all' });
  await idle();
  for (const cell of Object.values(await cells())) assert.deepEqual([cell.judged, cell.taskScore], [true, 30]);

  // the same code again: results stay; different code: that cell is unjudged
  const same = await upload('source', 'p1/echo.cpp', slow);
  assert.equal(same.unchanged, true);
  assert.equal((await cells()).p1.judged, true, 'an identical upload must keep the result');
  await upload('source', 'p1/echo.cpp', slow + '\n');
  assert.equal((await cells()).p1.judged, false, 'changed code must be judged again');
  await api('POST', base + '/judge', { mode: 'unjudged' });
  await idle();
  console.log('PASS identical uploads keep results, changed ones are judged again');

  await runAndInterrupt('cancel');
  let status = await api('GET', '/api/judge/status?since=0');
  assert.ok(status.events.some(e => e.type === 'finished' && e.canceled), 'the run must report it was canceled');
  for (const [who, cell] of Object.entries(await cells())) assert.deepEqual([who, cell.judged, cell.taskScore], [who, true, 30], 'cancel keeps the previous result');
  console.log('PASS cancel keeps the previous results of everything not judged to the end');

  await runAndInterrupt('stop');
  const stopped = Object.values(await cells());
  assert.ok(stopped.some(cell => !cell.judged), 'stop makes the cells being judged unjudged');
  console.log('PASS stop still makes the cells being judged unjudged');

  // A burst of concurrent requests of every kind, while polling and stopping / cancelling now and then.
  await api('POST', base + '/judge', { mode: 'unjudged' });
  const requests = [];
  for (let i = 0; i < 60; i++) {
    const kind = i % 6;
    const body = kind === 0 ? { mode: 'all' } : kind === 1 ? { mode: 'unjudged', refresh: true } : kind === 2 ? { mode: 'selected', items: [{ contestant: people[i % 4], tasks: [0] }] }
      : kind === 3 ? { mode: 'state', resultStates: [0] , tasks: [0] } : kind === 4 ? { mode: 'all', tasks: [0] } : { mode: 'selected', items: people.map(contestant => ({ contestant })) };
    requests.push(api('POST', base + '/judge', body).catch(error => { if (error.status !== 409) throw error; }));
    requests.push(api('GET', base).then(() => null));
    requests.push(api('GET', '/api/judge/status?since=0').then(() => null));
    if (i % 20 === 10) requests.push(api('POST', base + '/judge/' + (i % 40 === 10 ? 'cancel' : 'stop')).catch(() => null));
  }
  await Promise.all(requests);
  assert.equal(server.exitCode, null, 'the server must survive a burst of judging requests');
  await api('DELETE', base + '/judge'); // drop the rest of the queue
  await idle();
  await api('POST', base + '/judge', { mode: 'unjudged' }).catch(error => { if (error.status !== 409) throw error; });
  await idle();
  assert.equal(server.exitCode, null);
  const final = await cells();
  for (const cell of Object.values(final)) assert.deepEqual([cell.judged, cell.taskScore], [true, 30]);
  console.log('PASS a burst of concurrent judging requests is handled');

  // More contests with queued jobs than are kept in memory (8): loading one more must not unload it again
  // (this crashed the server when many judging jobs were added at once).
  const extra = Array.from({ length: 10 }, (_, i) => 'many-' + i);
  for (const name of extra) {
    const c = '/api/contests/' + name, put = (root, file, content) => api('PUT', c + '/files/upload?' + new URLSearchParams({ root, path: file }), undefined, content);
    await api('POST', '/api/contests', { name });
    await put('data', 'echo/1.in', '1\n'); await put('data', 'echo/1.out', '1\n');
    await api('POST', c + '/tasks', { problemTitle: 'Echo', sourceFileName: 'echo', standardInputCheck: true, standardOutputCheck: true, testCases: [testCases[0]] });
    await put('source', 'p1/echo.cpp', slow);
    await api('POST', c + '/refresh');
  }
  await kill(); await start(); // nothing in memory
  token = (await api('POST', '/api/auth/login', { token: '123456' })).session;
  await api('POST', base + '/judge', { mode: 'all' });
  for (const name of extra) await api('POST', `/api/contests/${name}/judge`, { mode: 'all' });
  for (const name of extra) await api('GET', `/api/contests/${name}`);
  await idle();
  assert.equal(server.exitCode, null, 'the server must survive queuing jobs on many contests');
  for (const name of extra) assert.equal((await api('GET', `/api/contests/${name}/contestants/p1`)).details[0].taskScore, 10, name);
  console.log('PASS jobs queued on more contests than are kept in memory');

  // results are on disk when judging ends, even if the process is killed right away
  await kill();
  await start();
  token = (await api('POST', '/api/auth/login', { token: '123456' })).session;
  for (const [who, cell] of Object.entries(await cells())) assert.deepEqual([who, cell.judged, cell.taskScore], [who, true, 30]);
  console.log('PASS results survive a hard kill after judging');

  if (process.platform !== 'win32') {
    // systemctl stop / restart in the middle of judging: saved, unfinished cells keep their previous results
    await api('POST', base + '/judge', { mode: 'all' });
    for (let i = 0; i < 400; i++) { const st = await api('GET', '/api/judge/status'); if (st.running && st.tasksDone > 0) break; await delay(25); }
    const exited = new Promise(resolve => server.once('exit', code => resolve(code)));
    server.kill('SIGTERM');
    assert.equal(await Promise.race([exited, delay(20000).then(() => 'timeout')]), 0, 'SIGTERM must end the server cleanly');
    await start();
    token = (await api('POST', '/api/auth/login', { token: '123456' })).session;
    for (const [who, cell] of Object.entries(await cells())) assert.deepEqual([who, cell.judged, cell.taskScore], [who, true, 30]);
    console.log('PASS SIGTERM while judging saves and keeps previous results');
  }
} finally {
  if (server) await kill();
  await delay(300);
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
