import assert from 'node:assert/strict';
import { test } from 'node:test';
import autosave from '../../web/autosave.js';

test('flush coalesces edits and completes before the following action', async () => {
  const calls = [];
  const queue = autosave.create(async patch => calls.push(patch), { delay: 60000 });
  queue.schedule({ title: 'first', source: 'sum' });
  queue.schedule({ title: 'last' });
  assert.equal(autosave.pending, true);
  await autosave.flushAll();
  calls.push('judge');
  assert.deepEqual(calls, [{ title: 'last', source: 'sum' }, 'judge']);
  assert.equal(autosave.pending, false);
});

test('in-flight saves are serialized and later edits are not lost', async () => {
  const calls = []; let finish;
  const queue = autosave.create(patch => {
    calls.push(patch);
    return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  }, { delay: 60000 });
  queue.schedule({ output: 'old.out' });
  const flushed = autosave.flushAll();
  queue.schedule({ output: 'new.out', time: 1200 });
  assert.equal(calls.length, 1);
  finish(); await flushed;
  assert.deepEqual(calls, [{ output: 'old.out' }, { output: 'new.out', time: 1200 }]);
  assert.equal(autosave.pending, false);
});

test('failed edits remain retryable and newer values win on retry', async () => {
  let fail = true; const calls = [];
  const queue = autosave.create(async patch => { if (fail) throw new Error('write failed'); calls.push(patch); }, { delay: 60000 });
  queue.schedule({ output: 'missing.out', title: 'unchanged' });
  await assert.rejects(autosave.flushAll(), /write failed/);
  assert.equal(autosave.pending, true);
  queue.schedule({ output: 'valid.out' }); fail = false;
  await autosave.flushAll();
  assert.deepEqual(calls, [{ output: 'valid.out', title: 'unchanged' }]);
  assert.equal(autosave.pending, false);
});
