import assert from 'node:assert/strict';
import { withBrowser } from './browser_harness.mjs';

await withBrowser(async ({ api, js, wait, send, click, drag, open, delay }) => {
  const run = async (name, action) => { if (!process.env.LEMON_UI_CASE || process.env.LEMON_UI_CASE === name) { await action(); console.log('PASS ' + name); } };
  await api('POST', '/api/contests', { name: 'interactions' });
  const base = '/api/contests/interactions';
  for (const name of ['a', 'b']) await api('POST', base + '/tasks', { problemTitle: name.toUpperCase(), sourceFileName: name, testCases: [] });
  const code = '// exact code 😀\r\n\tint main() { return 0; }\r\n\r\n';
  await api('PUT', base + '/files/upload?root=source&path=alice/a.cpp', undefined, code);
  await api('POST', base + '/refresh');
  await wait('!!document.querySelector(".topbar")');
  const seed = async () => {
    await open('interactions', 'results');
    await js(`(()=>{
      S.judge.panelOpen=false;S.contest.totalScore=200;
      S.contest.contestants=Array.from({length:80},(_,i)=>({name:'user'+String(i).padStart(2,'0'),totalScore:100-i,totalUsedTime:1000,judgingTime:'',tasks:[0,1].map(()=>({score:50,judged:true,compileState:0,submitted:true}))}));
      S.resultSort={key:'total',direction:-1};rerenderResults();
    })()`);
  };
  await run('compact evenly spaced login controls', async () => {
    await js('renderLogin()');
    const layout = await js(`(()=>{const input=document.querySelector('.login-box input'), buttons=[...document.querySelectorAll('.login-box button')];const boxes=[input,...buttons].map(el=>el.getBoundingClientRect());return {gaps:boxes.slice(1).map((r,i)=>r.top-boxes[i].bottom),widths:boxes.map(r=>r.width)};})()`);
    assert.ok(layout.gaps.every(value => value <= 12 && Math.abs(value - layout.gaps[0]) < 1), JSON.stringify(layout));
    assert.ok(layout.widths.every(value => value <= 285), JSON.stringify(layout));
  });
  await run('a plain click replaces a rectangle and Ctrl keeps toggling cells', async () => {
    await seed();
    await drag('[data-result-key="user00|0"]', '[data-result-key="user02|1"]');
    assert.equal(await js('S.resultSel.size'), 6);
    await click('[data-result-key="user01|0"]');
    assert.deepEqual(await js('[...S.resultSel]'), ['user01|0']);
    await click('[data-result-key="user02|1"]', { modifiers: 2 });
    await click('[data-result-key="user01|0"]', { modifiers: 2 });
    assert.deepEqual(await js('[...S.resultSel]'), ['user02|1']);
    await click('[data-result-key="user02|1"]');
    assert.equal(await js('S.resultSel.size'), 0);
  });
  await run('finishing without a retained finish event still sorts results and preserves scroll', async () => {
    await seed();
    await js(`(()=>{
      document.querySelector('.results-wrap').scrollTop=400;
      window.oldScroll=document.querySelector('.results-wrap').scrollTop;
      S.contest.busy=true;S.contest.judging=true;window.afterContest=structuredClone(S.contest);
      afterContest.busy=false;afterContest.judging=false;afterContest.contestants[70].totalScore=300;
      window.oldApi=api;api=async(method,url,...args)=>url.startsWith('/api/judge/status')?{running:false,judging:false,contest:'interactions',queue:[],events:[],progress:0,maximum:0}:url==='/api/contests/interactions'?afterContest:oldApi(method,url,...args);
    })()`);
    try {
      await js('pollJudge()'); await delay(1000);
      assert.equal(await js(`document.querySelector('tr[data-contestant]').dataset.contestant`), 'user70');
      assert.equal(await js(`document.querySelector('tr[data-contestant="user70"] td').textContent`), '1');
      assert.equal(await js(`document.querySelector('.results-wrap').scrollTop`), await js('window.oldScroll'));
    } finally { await js('api=window.oldApi;stopJudgePolling()'); }
  });
  await run('confirmation focuses the accept button for Enter and Space', async () => {
    await open('interactions', 'results');
    for (const [key, code, virtual] of [['Enter', 'Enter', 13], [' ', 'Space', 32]]) {
      await js(`(()=>{window.confirmed=null;confirmDlg('Test confirmation','确认操作').then(value=>{window.confirmed=value;});return true;})()`);
      await wait(`document.activeElement?.textContent === '确认操作'`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, text: key === 'Enter' ? '\r' : ' ' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual });
      await wait('window.confirmed === true');
    }
  });
  await run('source preview copies exact text with clipboard and HTTP fallback', async () => {
    await open('interactions', 'results');
    await js(`showSource('alice',0)`);
    await wait(`!!document.querySelector('.source-view')`);
    for (const fallback of [false, true]) {
      await js(`(()=>{window.copied=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(${fallback})throw Error('denied');window.copied=text;}}});document.execCommand=command=>{if(command==='copy'){window.copied=document.activeElement.value;return true;}return false;};})()`);
      await click('[data-copy-source]');
      await wait('window.copied !== null');
      assert.equal((await js('window.copied')).replace(/\r\n/g, '\n'), code.replace(/\r\n/g, '\n'));
      assert.equal(await js(`document.querySelector('.source-view').textContent`), code);
      assert.equal(await js(`document.querySelectorAll('textarea[data-clipboard-copy]').length`), 0);
    }
  });
});
