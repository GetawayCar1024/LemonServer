// Several CodeHub servers linked to one contest: each one only sees, writes and judges its own contestants.
import assert from 'node:assert/strict';
import { withServer } from './server_harness.mjs';

await withServer(async ({ api, request, idle, restart }) => {
  await api('POST', '/api/contests', { name: 'shared' }, { expect: 201 });
  const base = '/api/contests/shared', A = { 'X-CodeHub-Instance': 'codehub-room-a' }, B = { 'X-CodeHub-Instance': 'codehub-room-b' };
  const as = headers => (method, endpoint, body, options = {}) => api(method, endpoint, body, { ...options, headers });
  const a = as(A), b = as(B);
  await api('PUT', base + '/files/upload?root=data&path=echo/1.in', undefined, { raw: '1\n' });
  await api('PUT', base + '/files/upload?root=data&path=echo/1.out', undefined, { raw: '1\n' });
  await api('POST', base + '/tasks', { problemTitle: 'Echo', sourceFileName: 'echo', standardInputCheck: true, standardOutputCheck: true, testCases: [{ fullScore: 100, timeLimit: 1000, memoryLimit: 128, inputFiles: ['echo/1.in'], outputFiles: ['echo/1.out'] }] }, { expect: 201 });
  const code = '#include <cstdio>\nint main(){puts("1");}\n';
  const upload = (client, who, raw = code, options) => client('PUT', base + '/files/upload?root=source&path=' + who + '/echo.cpp', undefined, { raw, ...options });

  await a('POST', base + '/files/mkdir', { root: 'source', path: 'alice' });
  await upload(a, 'alice');
  await b('POST', base + '/files/mkdir', { root: 'source', path: 'bob' });
  await upload(b, 'bob');
  await upload(api, 'carol'); // uploaded on LemonServer itself: nobody's
  for (const attempt of [() => upload(b, 'alice', 'int main(){}', { expect: 409 }), () => b('POST', base + '/files/mkdir', { root: 'source', path: 'alice' }, { expect: 409 })]) {
    const conflict = await attempt();
    assert.equal(conflict.ownedByOther, true); assert.equal(conflict.contestant, 'alice');
  }
  await b('POST', base + '/files/unzip?root=source', undefined, { raw: 'not a zip', expect: 403 });
  await a('PUT', base + '/files/text', { root: 'source', path: 'bob/echo.cpp', content: 'x' }, { expect: 409 });
  assert.equal(await api('GET', base + '/files/download?root=source&path=alice/echo.cpp'), code, 'the other CodeHub must not overwrite the code');

  // judging from one CodeHub only judges its own contestants
  const job = await a('POST', base + '/judge', { mode: 'unjudged', refresh: true }, { expect: 202 });
  assert.equal(job.job.owner, 'codehub-room-a');
  for (const event of job.events) if (event.contestant) assert.equal(event.contestant, 'alice');
  await idle();
  const all = await api('GET', base);
  const score = name => all.contestants.find(c => c.name === name).tasks[0];
  assert.deepEqual(all.contestants.map(c => c.name).sort(), ['alice', 'bob', 'carol'], 'LemonServer itself still sees everybody');
  assert.equal(score('alice').score, 100); assert.equal(score('bob').judged, false); assert.equal(score('carol').judged, false);
  assert.deepEqual((await a('GET', base)).contestants.map(c => c.name), ['alice']);
  assert.deepEqual((await b('GET', base)).contestants.map(c => c.name), ['bob']);
  const status = await a('GET', '/api/judge/status?since=0');
  assert.ok(status.events.some(e => e.contestant === 'alice'));
  assert.equal((await b('GET', '/api/judge/status?since=0')).events.filter(e => e.contestant).length, 0, 'no events about the contestants of another CodeHub');
  for (const route of ['/contestants/alice', '/contestants/alice/source/0']) await b('GET', base + route, undefined, { expect: 404 });
  await b('GET', base + '/files/download?root=source&path=alice/echo.cpp', undefined, { expect: 404 });
  for (const route of ['/export?format=csv', '/statistics']) await b('GET', base + route, undefined, { expect: 403 });
  assert.equal((await a('GET', base + '/contestants/alice')).totalScore, 100);
  await b('POST', base + '/judge', { mode: 'unjudged' }, { expect: 202 }); await idle();
  assert.equal((await api('GET', base)).contestants.find(c => c.name === 'carol').tasks[0].judged, false, 'unowned contestants are judged only by LemonServer itself');
  assert.equal((await b('GET', base)).contestants[0].tasks[0].score, 100);

  // ownership persists, and deleting the contestant on LemonServer releases the name
  await restart();
  await upload(b, 'alice', 'int main(){}', { expect: 409 });
  await api('DELETE', base + '/contestants/alice?deleteFiles=1');
  await upload(b, 'alice');
  await upload(a, 'alice', code, { expect: 409 });
  const invalid = await request('GET', base, { headers: { 'X-CodeHub-Instance': 'bad id!' } });
  assert.equal(invalid.status, 400);
  console.log('PASS CodeHub servers sharing a contest only see, write and judge their own contestants');
});
