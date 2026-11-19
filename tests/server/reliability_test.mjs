import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withServer } from './server_harness.mjs';

await withServer(async ({ home, api, idle, restart }) => {
  await api('POST', '/api/contests', { name: 'seed' }, { expect: 201 });
  const task = (await api('POST', '/api/contests/seed/tasks', { problemTitle: '中文显示名', standardInputCheck: true, standardOutputCheck: true,
    testCases: [1, 2].map(n => ({ fullScore: 1.25, timeLimit: 1000, memoryLimit: 128, inputFiles: [`cases/${n}.in`], outputFiles: [`cases/${n}.out`] })) }, { expect: 201 })).task;
  assert.match(task.sourceFileName, /^[A-Za-z0-9_-]+$/);
  const cdf = JSON.parse(await fs.readFile(path.join(home, 'contests/seed/seed.cdf'), 'utf8'));
  cdf.contestTitle = 'Mixed separators';
  for (const tc of cdf.tasks[0].testCases) { tc.inputFiles = tc.inputFiles.map(file => file.replaceAll('/', '\\')); tc.outputFiles = tc.outputFiles.map(file => file.replaceAll('/', '\\')); }
  const folder = path.join(home, 'contests/mixed');
  await fs.mkdir(path.join(folder, 'data/cases'), { recursive: true }); await fs.mkdir(path.join(folder, 'source/alice'), { recursive: true });
  await fs.writeFile(path.join(folder, 'mixed.cdf'), JSON.stringify(cdf));
  for (const n of [1, 2]) for (const ext of ['in', 'out']) await fs.writeFile(path.join(folder, `data/cases/${n}.${ext}`), '1\n');
  await fs.writeFile(path.join(folder, `source/alice/${task.sourceFileName}.cpp`), '#include <cstdio>\nint main(){int x;scanf("%d",&x);printf("%d\\n",x);}\n');
  const base = '/api/contests/mixed';
  const loaded = await api('GET', base);
  assert.deepEqual(loaded.tasks[0].testCases.map(tc => tc.inputFiles[0]), ['cases/1.in', 'cases/2.in']);
  await api('POST', base + '/refresh'); await api('POST', base + '/judge', { mode: 'all' }, { expect: 202 }); await idle();
  assert.equal((await api('GET', base + '/contestants/alice')).totalScore, 2.5, 'legacy path spelling must work before editing a test case');
  await api('PUT', base + '/tasks/0', { problemTitle: '改中文名但不改文件' });
  assert.equal((await api('GET', base)).tasks[0].sourceFileName, task.sourceFileName);
  await api('PUT', base, { title: 'Backup checkpoint' });
  await api('PUT', '/api/setup', { contestRoot: path.join(home, 'contests') });
  const main = path.join(folder, 'mixed.cdf');
  assert.ok((await fs.stat(main + '.bak')).size > 0);
  await fs.writeFile(main, Buffer.alloc(4096)); await fs.writeFile(path.join(home, 'server.json'), Buffer.alloc(4096));
  await restart();
  assert.equal((await api('GET', base + '/contestants/alice')).totalScore, 2.5);
  assert.ok((await fs.readdir(folder)).some(name => name.startsWith('mixed.cdf.corrupt-')));
  await api('PUT', '/api/setup', { contestRoot: path.join(home, 'contests') });
  assert.ok(JSON.parse(await fs.readFile(path.join(home, 'server.json'), 'utf8')).tokenHash);
  const newToken = 'recovery-test-private-token';
  const session = (await api('PUT', '/api/auth/token', { currentToken: '123456', newToken })).session;
  await api('PUT', '/api/setup', { contestRoot: path.join(home, 'contests') }, { auth: session });
  await fs.writeFile(path.join(home, 'server.json'), Buffer.alloc(128));
  await restart({ loginToken: newToken });
  await api('POST', '/api/auth/login', { token: '123456' }, { auth: '', expect: 401 });
  console.log('PASS legacy paths before edits, independent Chinese display names, CDF/config backup recovery and retained corruption evidence');
});

await withServer(async ({ api, request }) => {
  await api('POST', '/api/contests', { name: 'downloads' }, { expect: 201 });
  const base = '/api/contests/downloads';
  for (const name of ['one/a.txt', 'two/b.txt', 'note.txt', 'unselected.txt']) await api('PUT', base + '/files/upload?root=contest&path=' + name, undefined, { raw: name });
  const first = { 'X-CodeHub-Instance': 'first-codehub-001' }, second = { 'X-CodeHub-Instance': 'second-codehub-002' };
  await api('PUT', base + '/files/upload?root=source&path=alice/a.cpp', undefined, { raw: 'first private source', headers: first });
  await api('PUT', base + '/files/upload?root=source&path=bob/a.cpp', undefined, { raw: 'second private source', headers: second });
  const blocked = await api('PUT', base + '/files/upload?root=contest&path=note.txt/child.txt', undefined, { raw: 'must not replace the parent', expect: 500 });
  assert.match(blocked.error, /destination folder/i);
  assert.equal((await api('GET', base + '/files/download?root=contest&path=note.txt&text=1')).content, 'note.txt');
  console.log('PASS failed upload destinations return a storage error and preserve existing files');
  await api('POST', base + '/files/mkdir', { root: 'contest', path: 'one/empty' });
  await api('POST', base + '/archive');
  const response = await request('POST', base + '/files/download-selection', { body: { root: 'contest', paths: ['one', 'two', 'note.txt'] } });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()), names = [];
  for (let offset = 0; offset + 46 <= bytes.length; offset++) if (bytes.readUInt32LE(offset) === 0x02014b50) {
    const length = bytes.readUInt16LE(offset + 28); names.push(bytes.subarray(offset + 46, offset + 46 + length).toString('utf8'));
  }
  for (const name of ['one/a.txt', 'two/b.txt', 'note.txt']) assert.ok(names.includes(name), names.join(','));
  assert.ok(names.some(name => name.replace(/\/$/, '') === 'one/empty')); assert.ok(!names.includes('unselected.txt'));
  await api('POST', base + '/files/download-selection', { root: 'contest', paths: ['../server.json'] }, { expect: 400 });
  await api('POST', base + '/files/download-selection', { root: 'contest', paths: ['one'] }, { auth: '', expect: 401 });
  await api('POST', base + '/files/download-selection', { root: 'source', paths: ['alice', 'bob'] }, { headers: first, expect: 404 });
  await api('GET', base + '/files/download?root=source&path=', undefined, { headers: first, expect: 404 });
  console.log('PASS one ZIP for selected files/folders, empty directories, archived reads, traversal and guest denial');
});
