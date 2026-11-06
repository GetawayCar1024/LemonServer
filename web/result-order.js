/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  const names = new Intl.Collator('zh-CN', { numeric: true });
  const score = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  function sort(rows, key = 'total', direction = -1) {
    const value = row => key === 'name' ? row.name : key === 'total' ? score(row.totalScore) : score(row.tasks[Number(key.slice(5))]?.score);
    return rows.slice().sort((a, b) => {
      const left = value(a), right = value(b);
      if (key !== 'name' && (left === null || right === null) && left !== right) return left === null ? 1 : -1;
      const order = key === 'name' ? names.compare(left, right) : (left ?? 0) - (right ?? 0);
      return order * direction || names.compare(a.name, b.name);
    });
  }
  const api = { sort };
  root.LemonResultOrder = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
