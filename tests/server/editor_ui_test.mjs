import assert from 'node:assert/strict';
import { withBrowser } from './browser_harness.mjs';

await withBrowser(async ({ api, js, wait, click, drag, open, delay }) => {
  await api('POST', '/api/contests', { name: 'editor-test' });
  const contest = '/api/contests/editor-test';
  const cases = [1, 2, 3].map(n => ({ fullScore: n * 10, timeLimit: 1000, memoryLimit: 256, inputFiles: [`sum/${n}.in`], outputFiles: [`sum/${n}.out`], dependenceSubtask: [] }));
  for (let n = 1; n <= 3; n++) for (const [ext, content] of [['in', '1 2\n'], ['out', '3\n']])
    await api('PUT', contest + '/files/upload?' + new URLSearchParams({ root: 'data', path: `sum/${n}.${ext}` }), undefined, content);
  await api('POST', contest + '/tasks', { problemTitle: '求和', sourceFileName: 'sum', standardInputCheck: true, standardOutputCheck: true, testCases: cases });
  await open('editor-test');
  await js('openTestCaseManager(0)');
  await wait('!!document.querySelector(".tcm-table tbody tr.case")');
  const failures = [];
  const row = n => `.tcm-table tbody tr.case:nth-child(${n})`;
  await click(row(1) + ' td.c');
  await click(row(3) + ' td.c', { modifiers: 2 });
  if (!await js(`[...document.querySelectorAll('.tcm-toolbar button')].some(b=>b.textContent.includes('合并')&&!b.disabled)`)) failures.push('Selecting right-hand test cases must enable merging their subtasks');
  if (!await js(`document.querySelectorAll('.tcm-table td.sub.selected').length >= 2`)) failures.push('Right-hand selection must also highlight its subtasks');
  // Make the former deferred outside-click binding fail deterministically, not only on fast CI hosts.
  await js(`window.originalUiTimeout=window.setTimeout;window.setTimeout=(callback,ms,...args)=>window.originalUiTimeout(callback,ms===0?5000:ms,...args)`);
  await click(row(1) + ' td.c', { button: 'right' });
  if (!await js(`[...document.querySelectorAll('.menu .mi')].some(item=>item.textContent.includes('修改'))`)) failures.push('Right-clicking a test case must offer editing actions');
  await click('.tcm-table thead th');
  if (await js('!!document.querySelector(".menu")')) failures.push('An outside click must immediately dismiss the context menu');
  await js(`(()=>{window.pointerTrace=[]; for(const type of ['mousedown','mousemove','mouseup']) document.addEventListener(type,event=>{window.pointerTrace.push({type:event.type,buttons:event.buttons,x:event.clientX,y:event.clientY,row:event.target.closest('tr')?.dataset.case,target:event.target.tagName,css:event.target.className});},{capture:true});})()`);
  await drag(row(1) + ' td.c input', row(3) + ' td.c input');
  await delay(30);
  if (await js(`document.querySelectorAll('.tcm-table tr.case.selected').length`) !== 3) {
    const details = await js(`({viewport:[innerWidth,innerHeight],window:[outerWidth,outerHeight],selection:[...document.querySelectorAll('.tcm-table tr.case.selected')].map(row=>row.dataset.case),pointer:window.pointerTrace})`);
    failures.push('Pointer drag must select a contiguous range of test cases: ' + JSON.stringify(details));
  }
  if (await js('window.getSelection().toString()') !== '') failures.push('Range selection must not select page text');
  await js('window.setTimeout=window.originalUiTimeout');
  assert.deepEqual(failures, []);
  console.log('PASS test manager right-click, unified selection and pointer range selection');

  const toolbar = label => js(`[...document.querySelectorAll('.tcm-toolbar button')].find(button=>button.textContent.includes(${JSON.stringify(label)})).click()`);
  const menu = label => js(`[...document.querySelectorAll('.menu .mi')].find(item=>item.textContent.includes(${JSON.stringify(label)})).click()`);
  const groups = () => js(`document.querySelectorAll('.tcm-subhead').length`);
  const scores = () => js(`[...document.querySelectorAll('tr[data-sub-start]')].map(row=>+row.querySelector('td.sub input').value)`);
  await toolbar('合并');
  assert.equal(await groups(), 1);
  assert.deepEqual(await scores(), [60]);
  await toolbar('撤销');
  await click(row(1) + ' td.c'); await click(row(3) + ' td.c', { modifiers: 2 });
  await click(row(1) + ' td.c', { button: 'right' }); await menu('修改子任务');
  await wait(`document.querySelectorAll('.modal-back').length === 2`);
  await js(`(()=>{const modal=document.querySelector('.modal-back:last-child'); const input=modal.querySelector('input[type=number]'); input.value='25';input.dispatchEvent(new Event('input',{bubbles:true}));modal.querySelector('.modal-foot button:last-child').click();})()`);
  assert.deepEqual(await scores(), [25, 20, 25]);
  await toolbar('撤销');
  await click(row(1) + ' td.c', { button: 'right' }); await menu('修改测试点');
  await wait(`document.querySelectorAll('.modal-back').length === 2`);
  await js(`(()=>{const modal=document.querySelector('.modal-back:last-child');modal.querySelector('input[aria-label="输入文件"]').value='sum/2.in';modal.querySelector('input[aria-label="输出文件"]').value='sum/2.out';modal.querySelector('.modal-foot button:last-child').click();})()`);
  assert.equal(await js(`document.querySelector(${JSON.stringify(row(1) + ' td.c input')}).value`), 'sum/2.in');
  await toolbar('撤销');
  await click(row(1) + ' td.c'); await click(row(3) + ' td.c', { modifiers: 2 });
  await click(row(1) + ' td.c', { button: 'right' }); await menu('绑定到子任务'); await menu('#2');
  assert.equal(await groups(), 1);
  assert.deepEqual(await scores(), [60]);
  assert.deepEqual(await js(`[...document.querySelectorAll('.tcm-table input.path')].filter((_,i)=>i%2===0).map(input=>input.value)`), ['sum/2.in', 'sum/1.in', 'sum/3.in']);
  await toolbar('撤销');
  await click('.modal-foot button:last-child');
  await wait('!document.querySelector(".modal-back")');
  assert.deepEqual((await api('GET', contest + '/tasks/0')).testCases.map(item => item.fullScore), [10, 20, 30]);
  console.log('PASS right-click editing, selected-only batch updates, binding, scores and undo');

  for (const name of ['second', 'third']) await api('POST', contest + '/tasks', { problemTitle: name, sourceFileName: name });
  await api('PUT', contest + '/files/upload?' + new URLSearchParams({ root: 'source', path: 'alice/sum.cpp' }), undefined,
    '#include <cstdio>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d\\n",a+b);}\n');
  await api('POST', contest + '/refresh');
  await api('POST', contest + '/judge', { mode: 'all' });
  for (let i = 0; i < 600; i++) { if (!(await api('GET', '/api/judge/status')).judging) break; await delay(50); }
  assert.equal((await api('GET', contest + '/contestants/alice')).details[0].taskScore, 60);
  await api('PUT', contest + '/files/upload?' + new URLSearchParams({ root: 'data', path: 'checkers/ok.cpp' }), undefined,
    '#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);ouf.readInt();quitf(_ok,"accepted");}\n');
  await api('PUT', contest + '/files/upload?' + new URLSearchParams({ root: 'data', path: 'sum/pc.cpp' }), undefined,
    '#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);ouf.readInt();quitf(_pc(50),"half");}\n');
  await open('editor-test');
  await js(`(()=>{const source=document.querySelector('[data-task="0"]');const target=document.querySelector('[data-task="2"]');const r=target.getBoundingClientRect();const dataTransfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientY:r.bottom-1}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientY:r.bottom-1}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));})()`);
  await wait(`[...document.querySelectorAll('.tree-item:not(.child) .label')].map(x=>x.textContent).join(',') === 'second,third,求和'`);
  assert.deepEqual((await api('GET', contest)).tasks.map(item => item.sourceFileName), ['second', 'third', 'sum']);
  assert.equal((await api('GET', contest + '/contestants/alice')).details[2].taskScore, 60, 'judged results must move with their task');
  const badMove = await js(`api('POST', cpath()+'/tasks/0/move',{to:1.5}).then(()=>200).catch(error=>error.status)`);
  assert.equal(badMove, 400);
  console.log('PASS task drag reordering and target-index validation');

  await click('[data-task="2"] .label');
  assert.equal(await js(`[...document.querySelectorAll('.editor select')].some(el=>[...el.options].some(option=>option.value==='5'))`), false, 'the Testlib mode is only offered to tasks still using it');
  await js(`(()=>{const select=[...document.querySelectorAll('.editor select')].find(el=>[...el.options].some(option=>option.value==='4'));select.value='4';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(`!!document.querySelector('input[aria-label="从源文件编译"]')`);
  await click('input[aria-label="从源文件编译"]');
  await js(`[...document.querySelectorAll('.editor button')].find(button=>button.textContent==='选择文件').click()`);
  await wait(`!!document.querySelector('[role=listbox][aria-label="数据文件"] [data-file]')`);
  // files of the task's own folder come first; the filter narrows the list, Enter chooses
  assert.equal(await js(`document.querySelector('[data-file]').dataset.file`), 'sum/pc.cpp');
  await js(`(()=>{const input=document.querySelector('.file-pick-filter');input.value='ok';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  await wait(`document.querySelector('input[aria-label="校验器文件"]').value === 'checkers/ok.cpp'`);
  await js(`[...document.querySelectorAll('.editor button')].find(button=>button.textContent==='编译并使用').click()`);
  await wait('!!document.querySelector(".modal-back")');
  await click('.modal-back:last-child .modal-foot button:last-child');
  try { await wait('!document.querySelector(".modal-back")', 1200); }
  catch (error) { throw new Error(error.message + '\n' + await js(`document.querySelector('.compile-msg')?.textContent`)); }
  const checked = await api('GET', contest + '/tasks/2');
  assert.match(checked.specialJudge, /^checkers\/ok(?:\.exe)?$/);
  assert.equal(checked.comparisonMode, 4);
  console.log('PASS source picker compiles and assigns an executable checker');

  // A plain Testlib checker (registerTestlibCmd) compiled here runs as a Lemon checker and scores like Testlib mode.
  const judgeAlice = async () => {
    await api('POST', contest + '/judge', { mode: 'selected', items: [{ contestant: 'alice', tasks: [2] }] });
    for (let i = 0; i < 600; i++) { if (!(await api('GET', '/api/judge/status')).judging) break; await delay(50); }
    return (await api('GET', contest + '/contestants/alice')).details[2];
  };
  const okResult = await judgeAlice();
  assert.equal(okResult.taskScore, 60, 'quitf(_ok) gives the full score: ' + JSON.stringify(okResult));
  const compiled = await api('POST', contest + '/files/compile', { root: 'data', path: 'sum/pc.cpp' });
  assert.ok(compiled.ok, compiled.output);
  await api('PUT', contest + '/tasks/2', { specialJudge: compiled.executable.replace(/^data\//, '') });
  const partial = await judgeAlice();
  assert.equal(partial.taskScore, 30, '_pc(50) gives half of each subtask: ' + JSON.stringify(partial.message));
  assert.equal(partial.result[0][0], 2);
  await api('PUT', contest + '/files/upload?' + new URLSearchParams({ root: 'data', path: 'sum/fail.cpp' }), undefined,
    '#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);quitf(_fail,"broken");}\n');
  const failing = await api('POST', contest + '/files/compile', { root: 'data', path: 'sum/fail.cpp' });
  assert.ok(failing.ok, failing.output);
  await api('PUT', contest + '/tasks/2', { specialJudge: failing.executable.replace(/^data\//, '') });
  assert.equal((await judgeAlice()).result[0][0], 8, 'FAIL is an invalid checker, as in Testlib mode');
  console.log('PASS compiled Testlib checkers run in Lemon mode with Testlib scoring');
  // the page may still show the contest as busy from the API-driven judging until its next poll
  await js('reloadContest().then(()=>route())');
  await wait(`[...document.querySelectorAll('.editor button')].some(button=>button.textContent==='导入 Hydro 配置'&&!button.disabled)`);

  const openImport = async () => {
    await js(`[...document.querySelectorAll('.editor button')].find(button=>button.textContent==='导入 Hydro 配置').click()`);
    await wait(`!!document.querySelector('textarea[aria-label="Hydro 配置"]')`);
  };
  await openImport();
  const yaml = 'time: 2s\nmemory: 512m\nfilename: null\nunknown: ignored\ncases:\n  - {input: 1.in, output: 1.out}\n  - {input: missing.in, output: missing.out}\n';
  await js(`(()=>{const area=document.querySelector('textarea[aria-label="Hydro 配置"]');area.value=${JSON.stringify(yaml)};area.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('.modal-back:last-child button')].find(button=>button.textContent==='解析').click();})()`);
  assert.ok(await js(`document.querySelector('.import-warnings').textContent.includes('unknown')`));
  assert.ok(await js(`document.querySelector('.import-warnings').textContent.includes('missing.in')`));
  await click('.modal-back:last-child .modal-foot button:last-child');
  await wait('!document.querySelector(".modal-back")');
  let imported = await api('GET', contest + '/tasks/2');
  assert.equal(imported.testCases.length, 1);
  assert.deepEqual([imported.testCases[0].timeLimit, imported.testCases[0].memoryLimit], [2000, 512]);
  await openImport();
  await js(`(()=>{const original=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type==='file'){HTMLInputElement.prototype.click=original;Object.defineProperty(this,'files',{value:[new File(['time: 3s\\nmemory: 64m\\n'],'config.yaml',{type:'text/yaml'})]});this.dispatchEvent(new Event('change'));}else original.call(this);};[...document.querySelectorAll('.modal-back button')].find(button=>button.textContent==='选择本地文件').click();})()`);
  await wait(`!document.querySelector('.modal-back:last-child .modal-foot button:last-child').disabled`);
  await click('.modal-back:last-child .modal-foot button:last-child');
  await wait('!document.querySelector(".modal-back")');
  imported = await api('GET', contest + '/tasks/2');
  assert.deepEqual([imported.testCases[0].timeLimit, imported.testCases[0].memoryLimit], [3000, 64]);
  console.log('PASS pasted/file Hydro imports apply valid settings and report skipped entries');

  await openImport();
  await js(`(()=>{const area=document.querySelector('textarea[aria-label="Hydro 配置"]');area.value='checker_type: testlib\\nchecker: checkers/ok.cpp\\n';area.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('.modal-back:last-child button')].find(button=>button.textContent==='解析').click();})()`);
  await click('.modal-back:last-child .modal-foot button:last-child');
  await wait('!document.querySelector(".modal-back")', 1200);
  assert.match((await api('GET', contest + '/tasks/2')).specialJudge, /^checkers\/ok(?:\.exe)?$/);
  console.log('PASS Hydro source checker compiles before being assigned');

  await api('PUT', contest + '/tasks/2', { testCases: [cases[0], { ...cases[1], dependenceSubtask: [1] }] });
  await js('reloadContest().then(()=>openTestCaseManager(2))');
  await wait('!!document.querySelector(".tcm-table")');
  await click('.tcm-table tbody tr:first-child td.sub');
  await toolbar('下移');
  assert.deepEqual(await scores(), [10, 20], 'reordering must not silently discard a dependency');
  assert.ok(await js(`document.querySelector('#toast-root').textContent.includes('依赖的子任务')`));
  await click('.tcm-table tbody tr:first-child td.sub', { modifiers: 2 });
  const colors = () => js(`['1','2'].map(n=>{const row=document.querySelector('.tcm-table tbody tr:nth-child('+n+')');return [getComputedStyle(row.querySelector('td.sub')).backgroundColor,getComputedStyle(row.querySelector('td.c')).backgroundColor];})`);
  let shading = await colors();
  assert.deepEqual(shading.map(row => row[0]), shading.map(row => row[1]));
  assert.notEqual(shading[0][0], shading[1][0], 'subtasks should alternate in light mode');
  await js(`document.documentElement.dataset.theme='dark'`);
  shading = await colors();
  assert.deepEqual(shading.map(row => row[0]), shading.map(row => row[1]));
  assert.notEqual(shading[0][0], shading[1][0], 'subtasks should alternate in dark mode');
  console.log('PASS dependencies survive rejected moves and subtask shading works in both themes');
});
