import assert from 'node:assert/strict';
import { withServer } from './server_harness.mjs';

await withServer(async ({ api, request, idle, pause }) => {
  const base = '/api/contests/progress', pub = '/api/public/contests/progress';
  await api('POST', '/api/contests', { name: 'progress', title: '<script>PUBLIC_TITLE</script>' }, { expect: 201 });
  await api('PUT', base + '/files/upload?root=data&path=a.in', undefined, { raw: '1\n' });
  await api('PUT', base + '/files/upload?root=data&path=a.out', undefined, { raw: '1\n' });
  await api('POST', base + '/tasks', { problemTitle: 'A', sourceFileName: 'a', standardInputCheck: true, standardOutputCheck: true,
    testCases: [{ fullScore: 1.25, timeLimit: 1000, memoryLimit: 128, inputFiles: ['a.in'], outputFiles: ['a.out'] }] }, { expect: 201 });
  await api('PUT', base + '/files/upload?root=source&path=alice/a.cpp', undefined, { raw: '#include <cstdio>\n// SECRET_SOURCE_BODY\nint main(){puts("1");}\n' });
  await api('PUT', base + '/files/upload?root=source&path=bad/a.cpp', undefined, { raw: 'int main(){ SECRET_SOURCE_BODY }' });
  await api('PUT', base + '/files/upload?root=source&path=%3D1%2B2/a.cpp', undefined, { raw: '#include <cstdio>\nint main(){puts("1");}\n' });
  await api('POST', base + '/refresh');
  await api('POST', base + '/clone', { name: 'PRIVATE_QUEUED_CONTEST', withSubmissions: true }, { expect: 201 });
  await api('PUT', base, { public: true });
  await api('POST', '/api/contests/PRIVATE_QUEUED_CONTEST/judge', { mode: 'all' }, { expect: 202 });
  await api('POST', base + '/judge', { mode: 'all' }, { expect: 202 });
  let sawCase = false, since = 0;
  for (let i = 0; i < 1200; i++) {
    const status = await api('GET', pub + '/judge/status?since=' + since, undefined, { auth: '' });
    assert.equal(status.queue, undefined); assert.equal(status.queuedJobs, undefined); assert.equal(status.job, undefined);
    assert.ok(!JSON.stringify(status).includes('PRIVATE_QUEUED_CONTEST'));
    assert.ok(!JSON.stringify(status).includes('SECRET_SOURCE_BODY'));
    sawCase ||= (status.events || []).some(event => event.type === 'case');
    since = status.lastEventId || since;
    if (!(await api('GET', '/api/judge/status')).judging) break;
    await pause(50);
  }
  await idle();
  const last = await api('GET', pub + '/judge/status', undefined, { auth: '' });
  sawCase ||= (last.events || []).some(event => event.type === 'case');
  assert.ok(sawCase, 'guests must receive detailed safe progress, not only an overall percentage');
  assert.equal(last.tasksDone, 3);
  await api('POST', base + '/archive');
  for (const format of ['html', 'htm', 'csv']) {
    const response = await request('GET', pub + '/export?format=' + format, { auth: '' });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
    const content = await response.text();
    assert.ok(content.includes('alice') && content.includes('1.25'));
    assert.ok(!content.includes('SECRET_SOURCE_BODY') && !content.includes('PRIVATE_QUEUED_CONTEST'));
    if (format !== 'csv') { assert.ok(content.includes('&lt;script&gt;')); assert.ok(!content.includes('<script>PUBLIC_TITLE')); }
    else assert.ok(content.includes("'=1+2"), 'spreadsheet-formula names are exported as text');
  }
  await api('GET', pub + '/export?format=html&save=1', undefined, { auth: '', expect: 403 });
  await api('GET', '/api/public/contests/PRIVATE_QUEUED_CONTEST/export?format=csv', undefined, { auth: '', expect: 404 });
  console.log('PASS detailed public progress, no queue/source leak, safe local exports and archived exports');
});
