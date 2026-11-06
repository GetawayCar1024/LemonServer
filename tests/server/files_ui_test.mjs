import assert from 'node:assert/strict';
import { withBrowser } from './browser_harness.mjs';

await withBrowser(async ({ api, js, wait, open, delay }) => {
  await api('POST', '/api/contests', { name: 'files-test' });
  const base = '/api/contests/files-test';
  await open('files-test', 'files');
  await wait('!!document.querySelector(".fs-list")');
  await js(`(()=>{const row=[...document.querySelectorAll('tr.file-row')].find(row=>row.querySelector('td.name')?.textContent.trim().endsWith('data'));row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));})()`);
  await wait(`S.fs.path === 'data' && document.querySelector('.crumbs')?.textContent.includes('data')`);
  const paste = (name, content, selector = '.fs-list', keyboard = false) => js(`(()=>{
    const target=document.querySelector(${JSON.stringify(selector)});target.focus();
    ${keyboard ? "target.dispatchEvent(new KeyboardEvent('keydown',{key:'v',ctrlKey:true,bubbles:true,cancelable:true}));" : ''}
    const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(name)}));
    const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});target.dispatchEvent(event);return event.defaultPrevented;
  })()`);
  assert.equal(await paste('clipboard.txt', 'hello\n'), true);
  await wait(`document.querySelector('.fs-list')?.textContent.includes('clipboard.txt')`);
  assert.equal((await api('GET', base + '/files/download?' + new URLSearchParams({ root: 'contest', path: 'data/clipboard.txt', text: '1' }))).content, 'hello\n');
  assert.equal(await paste('ignored.txt', 'ignore', '.fs-filter'), false);
  await delay(150);
  assert.equal((await api('GET', base + '/files?' + new URLSearchParams({ root: 'contest', path: 'data' }))).entries.some(item => item.name === 'ignored.txt'), false);
  await js(`document.querySelector('.fs-filter').blur();S.fs.clip={mode:'copy',paths:['data/clipboard.txt']}`);
  assert.equal(await paste('priority.txt', 'external', '.fs-list', true), true);
  await wait(`document.querySelector('.fs-list')?.textContent.includes('priority.txt')`);
  await delay(200);
  assert.equal((await api('GET', base + '/files?' + new URLSearchParams({ root: 'contest', path: 'data' }))).entries.length, 2);
  await js(`document.querySelector('.fs-list').dispatchEvent(new KeyboardEvent('keydown',{key:'v',ctrlKey:true,bubbles:true,cancelable:true}))`);
  await wait(`document.querySelectorAll('.fs-list tr.file-row').length === 4`);
  assert.equal((await api('GET', base + '/files?' + new URLSearchParams({ root: 'contest', path: 'data' }))).entries.length, 3);
  await js('S.fs.clip=null');
  console.log('PASS clipboard file upload, text-input exclusion and internal-clipboard priority');

  await js(`(()=>{
    window.originalUploadXHR=window.XMLHttpRequest;window.pendingUploads=[];
    window.XMLHttpRequest=class {constructor(){this.upload={};this.headers={};}open(method,url){this.url=url;}setRequestHeader(k,v){this.headers[k]=v;}getAllResponseHeaders(){return 'content-type: application/json\\r\\n';}send(body){this.body=body;window.pendingUploads.push(this);}finish(){this.status=200;this.statusText='OK';this.response=new TextEncoder().encode('{"ok":true}').buffer;this.onload();}};
    const transfer=new DataTransfer();transfer.items.add(new File(['1234'],'small.bin'));transfer.items.add(new File(['123456789012'],'large.bin'));
    document.querySelector('.fs-list').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  })()`);
  await wait('window.pendingUploads.length === 1');
  await js('window.pendingUploads[0].upload.onprogress({loaded:2})');
  assert.equal(await js(`parseFloat(document.querySelector('[data-upload-progress]').style.width)`), 12.5);
  await js('window.pendingUploads[0].upload.onload()');
  assert.equal(await js(`parseFloat(document.querySelector('[data-upload-progress]').style.width)`), 25);
  assert.equal(await js('window.pendingUploads.length'), 1);
  await js('window.pendingUploads[0].finish()');
  await wait('window.pendingUploads.length === 2');
  await js('window.pendingUploads[1].upload.onprogress({loaded:6})');
  assert.equal(await js(`parseFloat(document.querySelector('[data-upload-progress]').style.width)`), 62.5);
  await js('window.pendingUploads[1].finish()');
  await wait('!document.querySelector("[data-upload-progress]")');
  await js('window.XMLHttpRequest=window.originalUploadXHR');
  console.log('PASS byte-weighted upload progress and response completion');

  for (const theme of ['light', 'dark']) {
    await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    const color = await js(`getComputedStyle(document.querySelector('.topbar button')).color`);
    const [r, g, b] = color.match(/\d+/g).map(Number);
    assert.ok(g > r && g > b, `${theme} interactive accent must be green: ${color}`);
    const focus = await js(`getComputedStyle(document.querySelector('.topbar button')).getPropertyValue('--focus-ring')`);
    const [fr, fg, fb] = focus.match(/\d+/g).map(Number);
    assert.ok(fg > fr && fg > fb, `${theme} focus must be green: ${focus}`);
  }
  console.log('PASS green interactive palette in both themes');
});
