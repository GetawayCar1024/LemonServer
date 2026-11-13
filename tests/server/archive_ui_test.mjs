// Archived contests can be cloned and made public; list actions keep the scroll position.
import assert from 'node:assert/strict';
import { withBrowser } from './browser_harness.mjs';

await withBrowser(async ({ api, js, wait, send, click, open, origin }) => {
  const names = Array.from({ length: 24 }, (_, i) => 'round-' + String(i).padStart(2, '0'));
  for (const name of names) await api('POST', '/api/contests', { name });
  for (const name of names.slice(0, 16)) await api('POST', `/api/contests/${name}/archive`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 600, deviceScaleFactor: 1, mobile: false });
  const accept = async () => {
    await wait(`!!document.querySelector('.modal-back:last-child .modal-foot button:last-child')`);
    await click('.modal-back:last-child .modal-foot button:last-child');
  };
  const scrollTo = async (name) => {
    await js(`(()=>{const page=document.querySelector('.page');const item=document.querySelector('[data-contest="${name}"]');page.scrollTop=item.offsetTop-page.offsetTop-200;return page.scrollTop;})()`);
    return js(`document.querySelector('.page').scrollTop`);
  };
  const scrollTop = () => js(`document.querySelector('.page').scrollTop`);

  await send('Page.navigate', { url: origin + '/?qa=archives#/archives' });
  await wait(`!!document.querySelector('[data-contest="round-10"]')`);
  let top = await scrollTo('round-10');
  assert.ok(top > 300, 'the archive list must scroll in this viewport');
  await js(`window.marker=document.querySelector('[data-contest="round-10"]')`);
  await js(`document.querySelector('[data-public="round-10"]').click()`);
  await accept();
  await wait(`document.querySelector('[data-public="round-10"]')?.textContent === '取消公开' && document.querySelector('[data-contest="round-10"]') !== window.marker`);
  assert.equal((await api('GET', '/api/contests/round-10')).public, true);
  assert.equal(await scrollTop(), top, 'making an archived contest public keeps the scroll position');
  await js(`document.querySelector('[data-public="round-10"]').click()`);
  await wait(`document.querySelector('[data-public="round-10"]')?.textContent === '公开'`);
  assert.equal((await api('GET', '/api/contests/round-10')).public, false);
  assert.equal(await scrollTop(), top);

  await js(`document.querySelector('[data-contest="round-11"] [data-unarchive]').click()`);
  await accept();
  await wait(`!document.querySelector('[data-contest="round-11"]')`);
  assert.equal((await api('GET', '/api/contests/round-11')).archived, false);
  assert.equal(await scrollTop(), top, 'unarchiving keeps the scroll position');
  console.log('PASS archived contests can be made public or private; list actions keep the scroll position');

  await js(`location.hash='#/contests'`);
  await wait(`!!document.querySelector('[data-contest="round-20"]')`);
  top = await scrollTo('round-20');
  assert.ok(top > 0);
  await js(`[...document.querySelectorAll('[data-contest="round-20"] button')].find(button=>button.textContent==='存档').click()`);
  await accept();
  await wait(`!document.querySelector('[data-contest="round-20"]')`);
  assert.equal((await api('GET', '/api/contests/round-20')).archived, true);
  const limit = await js(`(()=>{const page=document.querySelector('.page');return page.scrollHeight-page.clientHeight;})()`);
  assert.equal(await scrollTop(), Math.min(top, limit), 'archiving keeps the scroll position (the shorter list may end sooner)');
  assert.ok(await scrollTop() > 0);
  console.log('PASS archiving from the contest list keeps the scroll position');

  await js(`location.hash='#/archives'`);
  await wait(`!!document.querySelector('[data-clone="round-03"]')`);
  await js(`document.querySelector('[data-clone="round-03"]').click()`);
  await wait(`!!document.querySelector('.modal-back input[type=text]')`);
  await js(`document.querySelector('.modal-back input[type=text]').value='round-03-copy'`);
  await accept();
  await wait(`location.hash === '#/contest/round-03-copy/tasks'`);
  const copy = await api('GET', '/api/contests/round-03-copy');
  assert.equal(copy.archived, false); assert.equal((await api('GET', '/api/contests/round-03')).archived, true);
  console.log('PASS archived contests can be cloned');

  await open('round-04', 'results');
  await js(`[...document.querySelectorAll('.subbar button')].find(button=>button.textContent==='比赛设置').click()`);
  await wait(`!!document.querySelector('.modal-back input[type=checkbox]')`);
  assert.equal(await js(`document.querySelector('.modal-back input[type=checkbox]').disabled`), false);
  await js(`document.querySelector('.modal-back input[type=checkbox]').click()`);
  await accept();
  await wait(`S.contest?.public === true`);
  assert.equal((await api('GET', '/api/contests/round-04')).public, true);
  assert.equal((await api('GET', '/api/contests/round-04')).archived, true);
  console.log('PASS the settings of an archived contest can change its visibility');
});
