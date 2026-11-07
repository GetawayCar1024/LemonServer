/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  const score = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  // plain dictionary (code point) order
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // Equal scores: less total time first (not judged completely: last), then by name.
  const byTime = (a, b) => {
    const left = score(a.totalUsedTime), right = score(b.totalUsedTime);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return left - right;
  };
  function sort(rows, key = 'total', direction = -1) {
    const value = row => key === 'name' ? row.name : key === 'total' ? score(row.totalScore) : score(row.tasks[Number(key.slice(5))]?.score);
    return rows.slice().sort((a, b) => {
      if (key === 'name') return byName(a.name, b.name) * direction;
      const left = value(a), right = value(b);
      if ((left === null || right === null) && left !== right) return left === null ? 1 : -1;
      return ((left ?? 0) - (right ?? 0)) * direction || byTime(a, b) || byName(a.name, b.name);
    });
  }
  const api = { sort };
  root.LemonResultOrder = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
