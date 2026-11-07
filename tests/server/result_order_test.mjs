import assert from 'node:assert/strict';
import { test } from 'node:test';
import order from '../../web/result-order.js';
const rows = [{ name: 'user10', totalScore: 80, tasks: [{ score: 0 }] }, { name: 'user2', totalScore: 20, tasks: [{ score: 100 }] }, { name: 'user1', totalScore: -1, tasks: [{ score: -1 }] }];
test('result sorting keeps missing results last and retains deterministic name order', () => {
  assert.deepEqual(order.sort(rows, 'total', -1).map(row => row.name), ['user10', 'user2', 'user1']);
  assert.deepEqual(order.sort(rows, 'total', 1).map(row => row.name), ['user2', 'user10', 'user1']);
  assert.deepEqual(order.sort(rows, 'task:0', -1).map(row => row.name), ['user2', 'user10', 'user1']);
  assert.deepEqual(order.sort(rows, 'name', 1).map(row => row.name), ['user1', 'user10', 'user2']);
  assert.deepEqual(order.sort(rows, 'name', -1).map(row => row.name), ['user2', 'user10', 'user1']);
  assert.deepEqual(rows.map(row => row.name), ['user10', 'user2', 'user1']);
});
test('equal scores are ordered by total time, then by name in dictionary order', () => {
  const tied = [
    { name: 'b', totalScore: 100, totalUsedTime: 300, tasks: [{ score: 100 }] },
    { name: 'a', totalScore: 100, totalUsedTime: 300, tasks: [{ score: 100 }] },
    { name: 'Z', totalScore: 100, totalUsedTime: 300, tasks: [{ score: 100 }] },
    { name: 'c', totalScore: 100, totalUsedTime: 120, tasks: [{ score: 100 }] },
    { name: 'd', totalScore: 100, totalUsedTime: -1, tasks: [{ score: 100 }] },
    { name: 'e', totalScore: 90, totalUsedTime: 10, tasks: [{ score: 90 }] },
  ];
  assert.deepEqual(order.sort(tied, 'total', -1).map(row => row.name), ['c', 'Z', 'a', 'b', 'd', 'e']);
  assert.deepEqual(order.sort(tied, 'total', 1).map(row => row.name), ['e', 'c', 'Z', 'a', 'b', 'd']);
  assert.deepEqual(order.sort(tied, 'task:0', -1).map(row => row.name), ['c', 'Z', 'a', 'b', 'd', 'e']);
});
