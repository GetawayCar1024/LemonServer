import assert from 'node:assert/strict';
import { test } from 'node:test';
import order from '../../web/result-order.js';
const rows = [{ name: 'user10', totalScore: 80, tasks: [{ score: 0 }] }, { name: 'user2', totalScore: 20, tasks: [{ score: 100 }] }, { name: 'user1', totalScore: -1, tasks: [{ score: -1 }] }];
test('result sorting keeps missing results last and retains deterministic name order', () => {
  assert.deepEqual(order.sort(rows, 'total', -1).map(row => row.name), ['user10', 'user2', 'user1']);
  assert.deepEqual(order.sort(rows, 'total', 1).map(row => row.name), ['user2', 'user10', 'user1']);
  assert.deepEqual(order.sort(rows, 'task:0', -1).map(row => row.name), ['user2', 'user10', 'user1']);
  assert.deepEqual(order.sort(rows, 'name', 1).map(row => row.name), ['user1', 'user2', 'user10']);
  assert.deepEqual(rows.map(row => row.name), ['user10', 'user2', 'user1']);
});
