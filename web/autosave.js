/* SPDX-FileCopyrightText: 2026 LemonServer contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 * One serialized, retryable edit stream per editor. No DOM dependency.
 */
(function (root) {
  'use strict';
  const active = new Set();
  let flushing = null;

  function create(save, { delay = 500, onState = () => {}, onError = () => {} } = {}) {
    let pending = null, timer = null, running = null;
    const queue = {
      schedule(patch) {
        pending = { ...pending, ...structuredClone(patch) };
        active.add(queue);
        onState('pending');
        clearTimeout(timer);
        timer = setTimeout(() => queue.flush().catch(onError), delay);
      },
      flush() {
        clearTimeout(timer); timer = null;
        if (running) return running;
        if (!pending) return Promise.resolve();
        running = (async () => {
          while (pending) {
            clearTimeout(timer); timer = null;
            const patch = pending; pending = null;
            onState('saving');
            try { await save(patch); }
            catch (error) {
              pending = { ...patch, ...pending };
              onState('failed');
              throw error;
            }
          }
          onState('saved');
        })().finally(() => {
          running = null;
          if (!pending) active.delete(queue);
        });
        return running;
      },
    };
    return queue;
  }

  function flushAll() {
    if (!flushing) {
      flushing = (async () => {
        while (active.size) await Promise.all([...active].map(queue => queue.flush()));
      })().finally(() => { flushing = null; });
    }
    return flushing;
  }

  const api = { create, flushAll, get pending() { return active.size > 0; } };
  root.LemonAutosave = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
