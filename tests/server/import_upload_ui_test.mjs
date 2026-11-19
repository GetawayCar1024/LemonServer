import assert from 'node:assert/strict';
import { withBrowser } from './browser_harness.mjs';

await withBrowser(async ({ api, js, wait, click, open, send }) => {
  const base = '/api/contests/import-upload';
  await api('POST', '/api/contests', { name: 'import-upload' });
  for (const [file, text] of Object.entries({ 'sum/1.in': '1\n', 'sum/1.out': '1\n', 'a.json': '{}', 'sum/config.yaml': 'time: 2s\nsubtasks:\n - {id: 1, type: min, score: 12.5, cases: [{input: 1.in, output: 1.out}]}\n' }))
    await api('PUT', base + '/files/upload?root=data&path=' + encodeURIComponent(file), undefined, text);
  for (const name of ['sum', 'second', 'third']) await api('POST', base + '/tasks', { problemTitle: name, sourceFileName: name,
    testCases: name === 'sum' ? [{ fullScore: 10, timeLimit: 1000, memoryLimit: 128, inputFiles: ['sum/1.in'], outputFiles: ['sum/1.out'] }] : [] });
  await open('import-upload', 'tasks');
  await js('importHydroConfig(0)');
  await wait(`!!document.querySelector('[aria-label="选择服务器 Hydro 配置"]')`);
  await click('[aria-label="选择服务器 Hydro 配置"]');
  await wait('!!document.querySelector(".file-pick-item")');
  assert.equal(await js('document.querySelector(".file-pick-item").dataset.file'), 'sum/config.yaml');
  await js(`document.querySelector('.file-pick-filter').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  await wait(`document.querySelector('textarea[aria-label="Hydro 配置"]').value.includes('12.5')`);
  assert.equal(await js(`document.querySelector('input[aria-label="数据目录"]').value`), 'sum');
  await click('.modal-back .modal-foot button:last-child');
  await wait('!document.querySelector(".modal-back")');
  assert.equal((await api('GET', base + '/tasks/0')).testCases[0].fullScore, 12.5);
  assert.equal((await api('GET', base + '/tasks/0')).testCases[0].timeLimit, 2000);
  assert.equal(await js(`document.querySelector('[data-task="0"]').draggable`), false);
  assert.equal(await js(`document.querySelector('[data-task-handle="0"]').draggable`), true);
  await js(`document.querySelector('[data-task-handle="0"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`);
  await wait(`[...document.querySelectorAll('.tree-item[data-task] .label')].map(x=>x.textContent).join(',')==='second,sum,third'`);
  assert.deepEqual((await api('GET', base)).tasks.map(task => task.sourceFileName), ['second', 'sum', 'third']);
  console.log('PASS server Hydro picker, YAML priority, relative data paths and keyboard task handle');

  await open('import-upload', 'files'); await wait('!!document.querySelector(".fs-list")');
  await js(`(()=>{
    window.originalArrayBuffer=File.prototype.arrayBuffer;
    File.prototype.arrayBuffer=function(){if(this.name==='unreadable.cpp')return Promise.reject(new DOMException('source gone','NotReadableError'));return window.originalArrayBuffer.call(this);};
    const transfer=new DataTransfer();transfer.items.add(new File(['test'],'unreadable.cpp'));
    document.querySelector('.fs-list').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  })()`);
  await wait(`document.querySelector('#toast-root').textContent.includes('无法读取本地文件')`);
  assert.ok(!await js(`document.querySelector('#toast-root').textContent.includes('网络错误')`));
  assert.ok(!(await api('GET', base + '/files?root=contest')).entries.some(item => item.name === 'unreadable.cpp'));
  await js('File.prototype.arrayBuffer=window.originalArrayBuffer');

  await js(`(()=>{
    const leaf={isFile:true,name:'inside.txt',file:ok=>ok(new File(['folder contents'],'inside.txt'))};
    const empty={isDirectory:true,name:'empty',createReader:()=>({readEntries:ok=>ok([])})};
    const folder={isDirectory:true,name:'clipboard-folder',createReader:()=>{let done=false;return {readEntries:ok=>{ok(done?[]:[leaf,empty]);done=true;}};}};
    const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{items:[{kind:'file',webkitGetAsEntry:()=>folder}],files:[]}});
    document.querySelector('.fs-list').dispatchEvent(event);
  })()`);
  await wait(`document.querySelector('.fs-list')?.textContent.includes('clipboard-folder')`);
  assert.equal((await api('GET', base + '/files/download?root=contest&path=clipboard-folder/inside.txt&text=1')).content, 'folder contents');
  assert.ok((await api('GET', base + '/files?root=contest&path=clipboard-folder')).entries.some(item => item.name === 'empty' && item.dir));
  console.log('PASS clipboard folders including empty folders; unreadable sources are not network errors');

  await js(`(()=>{
    document.querySelector('#toast-root').replaceChildren();
    File.prototype.arrayBuffer=function(){if(this.name==='delayed.txt')return new Promise(resolve=>{window.releasePaste=()=>window.originalArrayBuffer.call(this).then(resolve);});return window.originalArrayBuffer.call(this);};
    const transfer=new DataTransfer();transfer.items.add(new File(['original directory'],'delayed.txt'));
    document.querySelector('.fs-list').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  })()`);
  await wait('typeof window.releasePaste === "function"');
  await js(`[...document.querySelectorAll('tr.file-row')].find(row=>row.querySelector('td.name')?.textContent.trim().endsWith('clipboard-folder')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await wait(`S.fs.path === 'clipboard-folder' && document.querySelector('.crumbs')?.textContent.includes('clipboard-folder')`);
  await js('window.releasePaste()');
  await wait(`!document.querySelector('.modal-back') && !!document.querySelector('.fs-list') && document.querySelector('#toast-root').textContent.includes('已上传 1 个文件')`);
  assert.equal((await api('GET', base + '/files/download?root=contest&path=delayed.txt&text=1')).content, 'original directory');
  assert.ok(!(await api('GET', base + '/files?root=contest&path=clipboard-folder')).entries.some(item => item.name === 'delayed.txt'));

  await api('POST', '/api/contests', { name: 'other-upload' });
  await js(`(()=>{
    document.querySelector('#toast-root').replaceChildren();
    window.releasePaste=null;
    const transfer=new DataTransfer();transfer.items.add(new File(['original contest'],'delayed.txt'));
    document.querySelector('.fs-list').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  })()`);
  await wait('typeof window.releasePaste === "function"');
  await js(`go('#/contest/other-upload/files')`);
  await wait(`S.contest?.name === 'other-upload' && !!document.querySelector('.fs-list')`);
  await js('window.releasePaste()');
  await wait(`!document.querySelector('.modal-back') && !!document.querySelector('.fs-list') && document.querySelector('#toast-root').textContent.includes('已上传 1 个文件')`);
  assert.equal((await api('GET', base + '/files/download?root=contest&path=clipboard-folder/delayed.txt&text=1')).content, 'original contest');
  assert.ok(!(await api('GET', '/api/contests/other-upload/files?root=contest')).entries.some(item => item.name === 'delayed.txt' || item.name === 'clipboard-folder'));
  assert.equal(await js('S.contest.name'), 'other-upload');
  await js('File.prototype.arrayBuffer=window.originalArrayBuffer');
  console.log('PASS delayed clipboard reads retain their original directory and contest');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await js(`toast('无法读取本地文件“' + 'long-filename-'.repeat(30) + '.cpp”。请先解压到本地，再重新选择上传。','error')`);
  await wait(`(()=>{const r=document.querySelector('.toast:last-child').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.height>30;})()`);
  console.log('PASS long upload error messages fit narrow screens');
});
