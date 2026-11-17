import assert from 'node:assert/strict';
import { withBrowser } from './browser_harness.mjs';

await withBrowser(async ({ api, js, wait, click, send, open, origin }) => {
  const base = '/api/contests/new-workflow';
  await api('POST', '/api/contests', { name: 'new-workflow' });
  await api('POST', base + '/tasks', { problemTitle: '中文显示名称', testCases: [{ fullScore: 10, timeLimit: 1000, memoryLimit: 128, inputFiles: ['1.in'], outputFiles: ['1.out'] }] });
  await open('new-workflow', 'tasks');
  await js('openTestCaseManager(0)'); await wait('!!document.querySelector(".tcm-table tbody tr.case")');
  await click('.tcm-table tbody tr.case td.c', { button: 'right' });
  await js(`[...document.querySelectorAll('.menu .mi')].find(item=>item.textContent.includes('修改子任务')).click()`);
  await wait('document.querySelectorAll(".modal-back").length===2');
  await js(`(()=>{const input=document.querySelector('.modal-back:last-child input[type=number]');input.value='7.5';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait('document.querySelectorAll(".modal-back").length===1');
  await wait(`document.querySelector('#toast-root')?.textContent.includes('测试点已保存')`);
  assert.equal((await api('GET', base + '/tasks/0')).testCases[0].fullScore, 7.5);
  await click('.modal-back .x');
  console.log('PASS Enter applies and persists subtask settings');

  for (const name of ['one/a.txt', 'two/b.txt']) await api('PUT', base + '/files/upload?root=contest&path=' + name, undefined, name);
  await open('new-workflow', 'files'); await wait('!!document.querySelector(".fs-list")');
  await js(`S.fs.selected=new Set(['one','two']);document.querySelector('.tabpage').replaceChildren();renderFilesTab(document.querySelector('.tabpage'))`);
  await wait('!!document.querySelector(".fs-list")');
  await js(`window.downloadSelection=null;window.savedDownload=download;download=(url,name,body)=>{window.downloadSelection={url,name,body};};[...document.querySelectorAll('.fs button')].find(button=>button.textContent==='下载').click()`);
  const selection = await js('window.downloadSelection');
  assert.deepEqual(selection.body.paths.sort(), ['one', 'two']); assert.ok(selection.url.endsWith('/files/download-selection'));
  await js('download=window.savedDownload');
  console.log('PASS selected folders are downloaded in one request');

  const auth = (await api('POST', '/api/auth/login', { token: '123456' })).session;
  const response = await fetch(origin + base + '/files/download?root=contest&path=', { headers: { Authorization: 'Bearer ' + auth } });
  assert.equal(response.status, 200);
  const archive = Buffer.from(await response.arrayBuffer()).toString('base64');
  for (const kind of ['drop', 'paste']) {
    await js(`location.hash='#/contests'`); await wait('!!document.querySelector(".page .narrow")');
    await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(archive)}),x=>x.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(kind + '-import.zip')}));const page=document.querySelector('.page');page.focus();page.dispatchEvent(${kind === 'drop' ? "new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true})" : "new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true})"});})()`);
    await wait('!!document.querySelector(".modal-back input")');
    await click('.modal-back .modal-foot button:last-child');
    await wait(`location.hash.includes('/contest/${kind}-import/') && !!document.querySelector('.tree-list')`);
    assert.equal((await api('GET', '/api/contests/' + kind + '-import')).tasks[0].problemTitle, '中文显示名称');
  }
  console.log('PASS homepage drop and clipboard imports use the real contest import endpoints');
});
