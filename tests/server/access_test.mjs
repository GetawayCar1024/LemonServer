// Public results are an explicit allowlist; archived contests are immutable through every API path.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const executable = path.resolve(process.argv[2]), home = await fs.mkdtemp(path.join(os.tmpdir(), 'lemon-access-'));
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, token;
const start = async () => {
  server = spawn(executable, ['--host', '127.0.0.1', '--port', String(port), '--config', path.join(home, 'server.json')], { cwd: home, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 150; i++) { if (await fetch(origin + '/api/auth/status').then(r => r.ok).catch(() => false)) return; assert.equal(server.exitCode, null); await pause(100); }
  throw Error('Server did not start');
};
const stop = async () => {
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill();
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  await Promise.race([exited, pause(5000)]);
};
const call = async (method, endpoint, { body, raw, auth = token, expect = 200 } = {}) => {
  const r = await fetch(origin + endpoint, { method, headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), 'Content-Type': raw === undefined ? 'application/json' : 'application/octet-stream' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(60000) });
  const value = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  assert.equal(r.status, expect, `${method} ${endpoint}: ${JSON.stringify(value).slice(0, 400)}`); return value;
};
const guest = (endpoint, expect = 200) => call('GET', endpoint, { auth: '', expect });
const idle = async () => { for (let i = 0; i < 600; i++) { if (!(await call('GET', '/api/judge/status')).judging) return; await pause(50); } throw Error('Judging did not finish'); };
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
const zip = files => {
  const local = [], central = []; let offset = 0, size = 0;
  for (const [file, text] of Object.entries(files)) {
    const name = Buffer.from(file), bytes = Buffer.from(text), header = Buffer.alloc(30), record = Buffer.alloc(46), crc = crc32(bytes);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(record, name); offset += header.length + name.length + bytes.length; size += record.length + name.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
};
const base = '/api/contests/public-round', pub = '/api/public/contests/public-round';
try {
  await start(); token = (await call('POST', '/api/auth/login', { body: { token: '123456' } })).session;
  const status = await guest('/api/auth/status');
  assert.equal(status.role, 'guest'); assert.equal(status.authenticated, false);
  for (const key of ['tokenIsDefault', 'setupRequired', 'platform']) assert.equal(status[key], undefined);
  await call('PUT', '/api/setup', { body: { contestRoot: path.join(home, 'contests') } });
  const created = await call('POST', '/api/contests', { body: { name: 'public-round' }, expect: 201 });
  assert.equal(created.public, false); assert.equal(created.archived, false);
  await call('POST', '/api/contests', { body: { name: 'private-round', title: 'PRIVATE_CONTEST_SENTINEL' }, expect: 201 });
  assert.deepEqual((await guest('/api/public/contests')).contests, []);
  await guest(pub, 404);
  await call('PUT', base, { body: { public: true } });
  await call('PUT', base + '/files/upload?root=data&path=a/1.in', { raw: '1\n' });
  await call('PUT', base + '/files/upload?root=data&path=a/1.out', { raw: '1\n' });
  await call('POST', base + '/tasks', { body: { problemTitle: 'Echo', sourceFileName: 'a', standardInputCheck: true, standardOutputCheck: true, testCases: [{ fullScore: 100, timeLimit: 1000, memoryLimit: 128, inputFiles: ['a/1.in'], outputFiles: ['a/1.out'] }] }, expect: 201 });
  const source = '#include <cstdio>\n// PRIVATE_SOURCE_SENTINEL\nint main(){puts("1");}\n';
  await call('PUT', base + '/files/upload?root=source&path=alice/a.cpp', { raw: source });
  await call('PUT', base + '/files/upload?root=source&path=bad/a.cpp', { raw: 'int main(){ PRIVATE_SOURCE_SENTINEL }' });
  await call('POST', base + '/refresh');
  const pending = await guest(pub);
  assert.deepEqual(pending.tasks[0].testCases, [], 'unjudged test configuration is not part of result.html');
  await call('POST', base + '/judge', { body: { mode: 'all' }, expect: 202 });
  await call('POST', base + '/archive', { expect: 409 });
  await idle();
  const adminBad = await call('GET', base + '/contestants/bad');
  assert.ok(adminBad.details[0].compileMessage.includes('PRIVATE_SOURCE_SENTINEL'));
  const list = await guest('/api/public/contests');
  assert.deepEqual(list.contests.map(c => c.name), ['public-round']);
  assert.equal(list.contestRoot, undefined); assert.equal(list.queue, undefined);
  const visible = await guest(pub), details = await guest(pub + '/contestants/alice'), failed = await guest(pub + '/contestants/bad');
  assert.deepEqual(Object.keys(visible).sort(), ['archived', 'busy', 'contestants', 'judging', 'name', 'public', 'status', 'tasks', 'title', 'totalScore']);
  assert.deepEqual(Object.keys(visible.tasks[0]).sort(), ['problemTitle', 'taskType', 'testCases', 'totalScore']);
  assert.deepEqual(Object.keys(visible.contestants[0].tasks[0]).sort(), ['compileState', 'judged', 'score']);
  assert.equal(details.details[0].taskScore, 100);
  assert.equal(visible.tasks[0].specialJudge, undefined); assert.equal(visible.directory, undefined); assert.equal(visible.downZip, undefined);
  assert.equal(visible.contestants[0].tasks[0].codeSize, undefined);
  for (const data of [visible, details, failed, await guest(pub + '/judge/status')]) {
    const text = JSON.stringify(data); assert.ok(!text.includes('PRIVATE_') && !text.includes(home.replaceAll('\\', '\\\\')));
  }
  assert.equal(failed.details[0].compileMessage, undefined);
  assert.equal(failed.details[0].inputFiles, undefined, 'compile failures do not expose stale test arrays');
  for (const route of ['/api/contests', base, base + '/files', base + '/files/download?root=source&path=alice/a.cpp', base + '/contestants/alice/source/0', base + '/export?format=html', '/api/settings', '/api/compilers', '/api/judge/status', '/api/judge-queue', '/api/apikeys']) await guest(route, 401);
  await guest('/api/public/contests/private-round', 404);
  await guest(pub + '/contestants/alice/source/0', 404);
  await guest(pub + '/files/download?root=source&path=alice/a.cpp', 404);
  await call('PUT', base, { body: { public: 'true' }, expect: 400 });
  await call('PUT', base, { body: { public: true }, auth: '', expect: 401 });
  await call('PUT', base + '/files/upload?root=source&path=alice/a.cpp', { raw: source + '\n' });
  assert.deepEqual((await guest(pub + '/contestants/alice')).details[0], { judged: false }, 'unjudged cells do not expose previous test details');
  await call('POST', base + '/judge', { body: { mode: 'unjudged' }, expect: 202 });
  await idle();
  console.log('PASS guest results allowlist, private contests, code and diagnostic restrictions');

  const key = (await call('POST', '/api/apikeys', { body: { name: 'integration' } })).key;
  await call('POST', base + '/archive');
  assert.deepEqual((await guest('/api/public/contests')).contests, []);
  assert.deepEqual((await guest('/api/public/contests?archived=1')).contests.map(c => c.name), ['public-round']);
  assert.equal((await guest(pub)).archived, true);
  const cdf = path.join(home, 'contests/public-round/public-round.cdf'), before = createHash('sha256').update(await fs.readFile(cdf)).digest('hex');
  const writes = [
    ['PUT', '', { title: 'changed' }], ['PUT', '', { public: false }], ['POST', '/save'], ['DELETE', ''],
    ['POST', '/tasks', {}], ['PUT', '/tasks/0', {}], ['DELETE', '/tasks/0'], ['POST', '/tasks/0/move', { to: 0 }],
    ['POST', '/add-tasks', {}], ['POST', '/refresh'], ['POST', '/cleanup', {}], ['DELETE', '/contestants/alice'],
    ['POST', '/judge', { mode: 'all' }], ['POST', '/judge/stop'], ['POST', '/judge/cancel'], ['DELETE', '/judge'],
    ['PUT', '/down-zip'], ['DELETE', '/down-zip'], ['POST', '/files/template', {}], ['POST', '/files/compile', {}],
    ['PUT', '/files/upload?root=source&path=alice/a.cpp', undefined, source], ['PUT', '/files/text?root=source&path=alice/a.cpp', { content: 'changed' }],
    ['POST', '/files/unzip?root=data', undefined, 'invalid'], ['POST', '/files/mkdir', { root: 'data', path: 'new' }],
    ['POST', '/files/delete', { root: 'source', paths: ['alice'] }], ['POST', '/files/copy', { root: 'source', paths: ['alice'], to: '' }],
    ['POST', '/files/move', { root: 'source', paths: ['alice'], to: '' }], ['POST', '/files/rename', { root: 'source', from: 'alice', to: 'other' }],
  ];
  for (const auth of [token, key]) for (const [method, suffix, body, raw] of writes) await call(method, base + suffix, { body, raw, auth, expect: 409 });
  await call('POST', '/api/contests/%70ublic-round/refresh', { expect: 409 });
  if (process.platform === 'win32') await call('POST', '/api/contests/PUBLIC-ROUND/refresh', { expect: 409 });
  await call('GET', base + '/export?format=html&save=1', { expect: 409 });
  const replacement = zip({ 'round.cdf': JSON.stringify({ contestTitle: 'replacement', tasks: [], contestants: [] }), 'lemonserver.json': JSON.stringify({ public: true, archived: true }) });
  await call('POST', '/api/import-contest?name=public-round&overwrite=1', { raw: replacement, expect: 409 });
  assert.equal(createHash('sha256').update(await fs.readFile(cdf)).digest('hex'), before);
  const clone = await call('POST', base + '/clone', { body: { name: 'archive-copy', withSubmissions: true }, expect: 201 });
  assert.equal(clone.public, false); assert.equal(clone.archived, false);
  await stop(); await start(); token = (await call('POST', '/api/auth/login', { body: { token: '123456' } })).session;
  assert.equal((await call('GET', base)).archived, true); assert.equal((await guest(pub)).public, true);
  assert.equal(createHash('sha256').update(await fs.readFile(cdf)).digest('hex'), before);
  await call('DELETE', base + '/archive');
  await call('PUT', base, { body: { title: 'editable again' } });
  await call('POST', base + '/judge', { body: { mode: 'unjudged' }, expect: 409 }); // nothing left to judge, not an archive lock
  await call('PUT', base, { body: { public: false } }); await guest(pub, 404);
  await call('POST', '/api/import-contest?name=new-import', { raw: replacement, expect: 201 });
  const imported = await call('GET', '/api/contests/new-import');
  assert.equal(imported.public, false); assert.equal(imported.archived, false);
  const blocked = zip({ 'blocked.cdf': JSON.stringify({ contestTitle: 'blocked', tasks: [], contestants: [] }), 'lemonserver.json/blocker': 'not a metadata file' });
  await call('POST', '/api/import-contest?name=failed-import', { raw: blocked, expect: 400 });
  assert.equal(await fs.stat(path.join(home, 'contests/failed-import')).then(() => true).catch(() => false), false, 'metadata must be sanitized before an import becomes visible');
  const props = path.join(home, 'contests/private-round/lemonserver.json');
  await fs.rename(props, props + '.backup'); await fs.mkdir(props);
  await call('PUT', '/api/contests/private-round', { body: { public: true }, expect: 500 });
  await call('POST', '/api/contests/private-round/archive', { expect: 500 });
  assert.equal((await call('GET', '/api/contests/private-round')).public, false);
  assert.equal((await call('GET', '/api/contests/private-round')).archived, false);
  await fs.rmdir(props); await fs.rename(props + '.backup', props);
  console.log('PASS archive locks, API-key parity, protected overwrite, persistence and private import defaults');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) await stop();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
