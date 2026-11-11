import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withServer } from './server_harness.mjs';

await withServer(async ({ home, api, request }) => {
  await api('POST', '/api/contests', { name: 'seed' }, { expect: 201 });
  await api('POST', '/api/contests/seed/tasks', { problemTitle: 'A', sourceFileName: 'a', testCases: [{ fullScore: 100, timeLimit: 1000, memoryLimit: 128, inputFiles: ['1.in','2.in','3.in','4.in'], outputFiles: ['1.out','2.out','3.out','4.out'] }] }, { expect: 201 });
  const source = JSON.parse(await fs.readFile(path.join(home, 'contests/seed/seed.cdf'), 'utf8'));
  source.contestTitle = 'Large result fixture';
  source.tasks = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(source.tasks[0]), problemTitle: `Task ${i}`, sourceFileName: `p${i}` }));
  source.contestants = Array.from({ length: 2000 }, (_, i) => ({ contestantName: `user${i}`, checkJudged: Array(8).fill(true), sourceFile: Array(8).fill('a.cpp'), compileMesaage: Array(8).fill(''), compileState: Array(8).fill(0),
    inputFiles: Array.from({ length: 8 }, () => [['1.in','2.in','3.in','4.in']]), result: Array.from({ length: 8 }, () => [[0,0,0,0]]),
    message: Array.from({ length: 8 }, () => [['','','','']]), score: Array.from({ length: 8 }, () => [[100,100,100,100]]),
    timeUsed: Array.from({ length: 8 }, () => [[1,1,1,1]]), memoryUsed: Array.from({ length: 8 }, () => [[1024,1024,1024,1024]]) }));
  const folder = path.join(home, 'contests/large'); await fs.mkdir(folder);
  const cdf = path.join(folder, 'large.cdf'); await fs.writeFile(cdf, JSON.stringify(source));
  await fs.writeFile(path.join(folder, 'lemonserver.json'), JSON.stringify({ public: true, archived: false }));
  const endpoint = '/api/public/contests/large';
  const first = await request('GET', endpoint, { auth: '' });
  assert.equal(first.status, 200); const etag = first.headers.get('etag'); await first.arrayBuffer();
  const begin = performance.now();
  const responses = await Promise.all(Array.from({ length: 24 }, async () => {
    const response = await request('GET', endpoint, { auth: '', headers: etag ? { 'If-None-Match': etag } : {} });
    const bytes = (await response.arrayBuffer()).byteLength;
    return { status: response.status, bytes };
  }));
  const readMs = performance.now() - begin;
  await fs.utimes(cdf, new Date('2000-01-01'), new Date('2000-01-01'));
  const before = (await fs.stat(cdf, { bigint: true })).mtimeNs;
  const archiveStart = performance.now(); await api('POST', '/api/contests/large/archive?summary=1');
  const archiveMs = performance.now() - archiveStart, after = (await fs.stat(cdf, { bigint: true })).mtimeNs;
  console.log(JSON.stringify({ contestants: 2000, tasks: 8, parallelReads: 24, readMs: Math.round(readMs), archiveMs: Math.round(archiveMs), responseBytes: responses.reduce((n, r) => n + r.bytes, 0), hasEtag: !!etag, cdfRewritten: before !== after }));
  if (process.argv.includes('--measure')) return;
  assert.ok(etag, 'public snapshots need validators so visitors need not download unchanged tables');
  assert.ok(responses.every(response => response.status === 304 && !response.bytes));
  assert.equal(after, before, 'archiving an already saved contest must not rewrite its CDF');
  const changed = await request('GET', endpoint, { auth: '', headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).archived, true);
  await api('DELETE', '/api/contests/large/archive'); await api('PUT', '/api/contests/large', { public: false });
  assert.equal((await request('GET', endpoint, { auth: '', headers: { 'If-None-Match': etag } })).status, 404, 'cached public data cannot outlive revocation');
  await api('POST', '/api/contests', { name: 'retry-save' }, { expect: 201 });
  const retry = '/api/contests/retry-save', retryCdf = path.join(home, 'contests/retry-save/retry-save.cdf');
  await fs.rename(retryCdf, retryCdf + '.previous'); await fs.mkdir(retryCdf);
  await api('PUT', retry, { title: 'pending save' }, { expect: 500 });
  await api('POST', retry + '/archive?summary=1', undefined, { expect: 500 });
  assert.equal((await api('GET', retry)).archived, false, 'a failed data save must not archive the contest');
  await fs.rmdir(retryCdf); await fs.rename(retryCdf + '.previous', retryCdf);
  await api('POST', retry + '/archive?summary=1');
  const recovered = JSON.parse(await fs.readFile(retryCdf, 'utf8'));
  assert.equal(recovered.contestTitle, 'pending save', 'failed saves stay dirty and are retried before archiving');
  assert.equal(recovered.version, '1.0', 'integer-only contests retain the old file version');
  console.log('PASS conditional public reads, archive I/O, immediate cache revocation and failed-save recovery');
});
