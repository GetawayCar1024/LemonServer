import assert from 'node:assert/strict';
import { withBrowser } from './browser_harness.mjs';

await withBrowser(async ({ api, js, wait, click, drag, open, delay }) => {
  await api('POST', '/api/contests', { name: 'result-test' });
  const base = '/api/contests/result-test';
  for (const name of ['a', 'b']) {
    for (const [ext, content] of [['in', '1\n'], ['out', '1\n']]) await api('PUT', base + '/files/upload?' + new URLSearchParams({ root: 'data', path: `${name}/1.${ext}` }), undefined, content);
    await api('POST', base + '/tasks', { problemTitle: name.toUpperCase(), sourceFileName: name, standardInputCheck: true, standardOutputCheck: true,
      testCases: [{ fullScore: 100, timeLimit: 1000, memoryLimit: 128, inputFiles: [`${name}/1.in`], outputFiles: [`${name}/1.out`] }] });
  }
  const source = value => `#include <cstdio>\nint main(){puts("${value}");}\n`;
  for (const [user, a, b] of [['alice', 1, 0], ['bob', 1, 1], ['carol', 0, 0]]) for (const [name, value] of [['a', a], ['b', b]])
    await api('PUT', base + '/files/upload?' + new URLSearchParams({ root: 'source', path: `${user}/${name}.cpp` }), undefined, source(value));
  await api('POST', base + '/refresh'); await api('POST', base + '/judge', { mode: 'all' });
  for (let i = 0; i < 1200; i++) { if (!(await api('GET', '/api/judge/status')).judging) break; await delay(50); }
  await api('PUT', base + '/files/upload?' + new URLSearchParams({ root: 'source', path: 'dave/a.cpp' }), undefined, source(1));
  await api('POST', base + '/refresh');
  await open('result-test', 'results');
  await wait('!!document.querySelector("[data-result-sort=total]")');
  const order = () => js(`[...document.querySelectorAll('tr[data-contestant]')].map(row=>row.dataset.contestant)`);
  assert.deepEqual(await order(), ['bob', 'alice', 'carol', 'dave']);
  await js(`document.querySelector('[data-result-sort="task:1"]').click()`);
  assert.deepEqual(await order(), ['bob', 'alice', 'carol', 'dave']);
  await js(`document.querySelector('[data-result-sort="task:1"]').click()`);
  assert.deepEqual(await order(), ['alice', 'carol', 'bob', 'dave']);
  await js(`document.querySelector('[data-result-sort=name]').click()`);
  assert.deepEqual(await order(), ['alice', 'bob', 'carol', 'dave']);
  await click('[data-result-key="alice|0"]');
  assert.equal(await js('S.resultSel.size'), 1);
  await click('[data-result-key="alice|0"]');
  assert.equal(await js('S.resultSel.size'), 0);
  await click('[data-result-key="alice|0"]');
  await click('[data-result-key="bob|1"]', { modifiers: 2 });
  await js(`document.querySelector('[data-result-sort=total]').click()`);
  assert.deepEqual(await js('[...S.resultSel].sort()'), ['alice|0', 'bob|1']);
  await js('reloadContest().then(()=>route())');
  assert.deepEqual(await js('[...S.resultSel].sort()'), ['alice|0', 'bob|1']);
  await js('S.resultSel.clear();route()');
  await drag('[data-result-key="bob|0"]', '[data-result-key="carol|1"]');
  assert.deepEqual(await js('[...S.resultSel].sort()'), ['alice|0', 'alice|1', 'bob|0', 'bob|1', 'carol|0', 'carol|1']);
  await click('tr[data-contestant="alice"] .name');
  assert.deepEqual(await js('[...S.resultSel]'), ['alice|*']);
  await click('tr[data-contestant="alice"] .name');
  assert.equal(await js('S.resultSel.size'), 0);
  console.log('PASS score/name ordering and click-again result deselection');

  // B is deliberately made unjudged. Selecting only A must not judge B as a side effect.
  await api('PUT', base + '/files/upload?' + new URLSearchParams({ root: 'source', path: 'alice/b.cpp' }), undefined, source(1));
  await js('reloadContest().then(()=>route())');
  await wait('!!document.querySelector("[data-judge-tasks]")');
  await click('[data-judge-tasks]');
  await wait(`!!document.querySelector('[data-judge-task="1"]')`);
  await click('[data-judge-task="1"]');
  await click('.modal-back:last-child .modal-foot button:last-child');
  for (let i = 0; i < 1200; i++) { if (!(await api('GET', '/api/judge/status')).judging) break; await delay(50); }
  const alice = await api('GET', base + '/contestants/alice');
  assert.equal(alice.details[0].judged, true);
  assert.equal(alice.details[1].judged, false);
  assert.equal((await api('GET', base + '/contestants/bob')).details[1].taskScore, 100);
  console.log('PASS selected-task judging leaves other results untouched');

  await js(`S.resultSel=new Set(['bob|1']);S.resultAnchor='bob|1';S.resultSort={key:'task:1',direction:-1};location.hash='#/contest/result-test/tasks'`);
  await wait('!!document.querySelector(".tree-list")');
  await js('moveTaskTo(1,0)');
  assert.deepEqual(await js('[...S.resultSel]'), ['bob|0']);
  assert.equal(await js('S.resultSort.key'), 'task:0');
  assert.equal((await api('GET', base + '/contestants/bob')).details[0].taskScore, 100);
  console.log('PASS selection and sort follow the same task after reordering');
});
