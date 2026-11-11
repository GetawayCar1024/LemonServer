/* SPDX-FileCopyrightText: 2026 LemonServer contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Pure, best-effort conversion of Hydro config.yaml into a LemonLime task patch.
 */
(function (root) {
  'use strict';
  const yaml = typeof module !== 'undefined' ? require('./vendor/js-yaml-4.1.1.min.js') : root.jsyaml;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const maximum = 2147483647;
  const split = (total, count) => Array.from({ length: count }, (_, i) => Number.isInteger(total)
    ? Math.floor(total / count) + (i >= count - total % count ? 1 : 0) : i + 1 === count ? total - (total / count) * i : total / count);
  const safePath = value => typeof value === 'string' && value.length > 0 && !/^[\\/]|^[A-Za-z]:|[\x00-\x1f<>:"|?*]/.test(value)
    && !value.replace(/\\/g, '/').split('/').some(part => part === '..' || part === '.');
  const portable = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(value)
    && !value.endsWith('.') && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);

  function parse(text, options = {}) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > 512 * 1024) throw new Error('配置不能超过 512 KiB');
    const config = yaml.load(text, { schema: yaml.JSON_SCHEMA });
    if (!object(config)) throw new Error('配置须为 YAML 对象');
    // Reject recursive/deep aliases and excessive input before traversing user-controlled structures.
    let nodes = 0;
    const visit = (value, parents = new Set(), depth = 0) => {
      if (++nodes > 100000 || depth > 40) throw new Error('配置结构过大或嵌套过深');
      if (!value || typeof value !== 'object') return;
      if (parents.has(value)) throw new Error('配置包含循环引用');
      const next = new Set(parents); next.add(value);
      for (const item of Object.values(value)) visit(item, next, depth + 1);
    };
    visit(config);
    const warnings = [], patch = {}, task = options.task || {}, defaults = options.defaults || {};
    const warn = (key, reason) => { if (warnings.length < 300) warnings.push(`${key}：${reason}，已跳过`); };
    const fields = (value, allowed, prefix) => { for (const key of Object.keys(value)) if (!allowed.includes(key)) warn(prefix + key, '不支持的配置项'); };
    fields(config, ['type', 'time', 'memory', 'filename', 'checker_type', 'checker', 'cases', 'subtasks'], '');
    const base = String(options.base || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (base && !safePath(base)) throw new Error('数据目录须位于 data 内');
    const files = new Set(options.files || []);
    const resolve = (value, label) => {
      if (!safePath(value)) { warn(label, '文件路径无效'); return null; }
      const normalized = value.replace(/\\/g, '/');
      const candidates = [...new Set([base ? `${base}/${normalized}` : normalized, normalized])].filter(file => files.has(file));
      if (candidates.length) return candidates[0];
      if (!base && !normalized.includes('/')) {
        const matching = [...files].filter(file => file.split('/').pop() === normalized);
        if (matching.length === 1) return matching[0];
        if (matching.length > 1) { warn(label, '文件名不唯一，请指定数据目录'); return null; }
      }
      warn(label, `找不到 ${normalized}`); return null;
    };
    const limit = (value, kind, fallback, label) => {
      if (value === undefined) return fallback;
      const match = /^(\d+(?:\.\d+)?)\s*(ms|us|s|k|kb|m|mb|g|gb)?$/i.exec(String(value).trim());
      const factors = kind === 'time' ? { '': 1, ms: 1, us: .001, s: 1000 } : { '': 1, k: 1 / 1024, kb: 1 / 1024, m: 1, mb: 1, g: 1024, gb: 1024 };
      const result = match && factors[(match[2] || '').toLowerCase()] !== undefined
        ? (kind === 'time' ? Math.floor : Math.ceil)(Number(match[1]) * factors[(match[2] || '').toLowerCase()]) : NaN;
      if (!Number.isSafeInteger(result) || result < 1 || result > maximum) { warn(label, '限制无效'); return fallback; }
      return result;
    };
    const score = (value, label) => {
      if (value === undefined) return undefined;
      if (!Number.isFinite(value) || value < 0 || value > maximum) { warn(label, '分值须为非负数'); return undefined; }
      if (!value) { warn(label, 'Hydro 的零分值表示使用默认值'); return undefined; }
      return value;
    };
    const rootTime = limit(config.time, 'time', null, 'time');
    const rootMemory = limit(config.memory, 'memory', null, 'memory');
    const time = rootTime ?? task.testCases?.[0]?.timeLimit ?? defaults.defaultTimeLimit ?? 1000;
    const memory = rootMemory ?? task.testCases?.[0]?.memoryLimit ?? defaults.defaultMemoryLimit ?? 256;
    if (own(config, 'type')) {
      if (config.type === 'default') patch.taskType = 0;
      else if (config.type === 'submit_answer') patch.taskType = 1;
      else warn('type', '该题型无法直接转换');
    }
    if (own(config, 'filename')) {
      if (config.filename === '' || config.filename === null) { patch.standardInputCheck = true; patch.standardOutputCheck = true; }
      else if (portable(config.filename)) Object.assign(patch, { inputFileName: config.filename + '.in', outputFileName: config.filename + '.out', standardInputCheck: false, standardOutputCheck: false });
      else warn('filename', '须使用安全英文文件名');
    }

    let checkerSource = null;
    if (config.checker_type === 'testlib' || config.checker_type === 'lemon') {
      if (object(config.checker)) {
        fields(config.checker, ['file', 'lang'], 'checker.');
        if (config.checker.lang && config.checker.lang !== 'auto') warn('checker.lang', '语言配置不直接导入，按文件扩展名选择编译器');
      }
      const source = object(config.checker) ? config.checker.file : config.checker;
      const checker = resolve(source, 'checker');
      const mode = config.checker_type === 'testlib' ? 5 : 4;
      if (checker) {
        // compiled with the bundled Testlib, a Testlib checker also runs as a Lemon checker
        if (/\.(?:cpp|cc|cxx|c)$/i.test(checker)) checkerSource = { path: checker, comparisonMode: 4 };
        else if (/\.(?:py|js|ts|java|cs|pas|sh|ya?ml|json)$/i.test(checker)) warn('checker', '此类校验器不能直接执行');
        else Object.assign(patch, { specialJudge: checker, comparisonMode: mode });
      }
    } else if (own(config, 'checker_type') || own(config, 'checker')) warn('checker_type', '不能等价转换，保留当前比较方式');

    let sourceGroups = null;
    if (own(config, 'cases')) {
      if (Array.isArray(config.cases) && config.cases.length) sourceGroups = [{ type: 'sum', cases: config.cases }];
      else if (!Array.isArray(config.cases)) warn('cases', '须为列表');
    }
    if (!sourceGroups && own(config, 'subtasks')) {
      if (Array.isArray(config.subtasks)) sourceGroups = config.subtasks;
      else warn('subtasks', '须为列表');
    }
    if ((!sourceGroups && !(task.testCases || []).length) || (sourceGroups && !sourceGroups.some(group => Array.isArray(group?.cases) && group.cases.length))) {
      const found = new Map();
      for (const input of [...files].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
        if (base && !input.startsWith(base + '/')) continue;
        const name = input.split('/').pop(), match = /^(.*?)(?:(\d+)[_-])?(\d+)\.in$/i.exec(name);
        if (!match) continue;
        const output = [input.replace(/\.in$/i, '.out'), input.replace(/\.in$/i, '.ans')].find(file => files.has(file));
        if (!output) continue;
        const id = Number(match[2] || 1);
        if (!found.has(id)) found.set(id, { id, type: match[2] ? 'min' : 'sum', cases: [] });
        found.get(id).cases.push({ input, output });
      }
      if (found.size) {
        const configured = sourceGroups || [];
        sourceGroups = configured.map(group => object(group) ? { ...found.get(group.id), ...group, cases: found.get(group.id)?.cases || [] } : group);
        for (const [id, group] of found) if (!configured.some(item => item?.id === id)) sourceGroups.push(group);
      }
    }
    if (sourceGroups && sourceGroups.length > 10000) throw new Error('子任务过多');
    const groups = [], ids = new Set();
    for (const [index, source] of (sourceGroups || []).entries()) {
      const label = `subtasks[${index}]`;
      if (!object(source)) { warn(label, '须为对象'); continue; }
      fields(source, ['id', 'type', 'score', 'time', 'memory', 'if', 'cases'], label + '.');
      const id = source.id ?? index + 1;
      if (!Number.isSafeInteger(id) || id < 0 || ids.has(id)) { warn(label + '.id', '编号无效或重复'); continue; }
      ids.add(id);
      const type = source.type ?? 'min';
      if (!['min', 'sum'].includes(type)) { warn(label + '.type', '不支持此计分方式'); continue; }
      if (!Array.isArray(source.cases) || !source.cases.length) { warn(label + '.cases', '没有测试点'); continue; }
      const groupTime = limit(source.time, 'time', time, label + '.time'), groupMemory = limit(source.memory, 'memory', memory, label + '.memory');
      const seen = new Set(), data = [];
      for (const [k, item] of source.cases.entries()) {
        if (!object(item)) { warn(`${label}.cases[${k}]`, '须为对象'); continue; }
        fields(item, ['input', 'output', 'time', 'memory', 'score'], `${label}.cases[${k}].`);
        const input = resolve(item.input, `${label}.cases[${k}].input`), output = resolve(item.output, `${label}.cases[${k}].output`);
        if (!input || !output) continue;
        const key = input + '\0' + output;
        if (seen.has(key)) { warn(`${label}.cases[${k}]`, '重复测试点'); continue; }
        seen.add(key);
        data.push({ input, output, time: limit(item.time, 'time', groupTime, `${label}.cases[${k}].time`), memory: limit(item.memory, 'memory', groupMemory, `${label}.cases[${k}].memory`), score: score(item.score, `${label}.cases[${k}].score`) });
      }
      if (!data.length) { warn(label, '没有可导入的测试点'); continue; }
      let dependencies = source.if ?? [];
      if (!Array.isArray(dependencies)) { warn(label + '.if', '依赖须为列表'); dependencies = []; }
      groups.push({ id, type, data, time: groupTime, memory: groupMemory, score: score(source.score, label + '.score'), dependencies, label });
    }
    groups.sort((a, b) => a.id - b.id);
    const missingScores = split(Math.max(0, 100 - groups.reduce((total, group) => total + (group.score || 0), 0)), groups.filter(group => group.score === undefined).length);
    for (const group of groups) {
      group.score ??= missingScores.shift();
      group.dependencies = [...new Set(group.dependencies)].filter(id => {
        if (!Number.isSafeInteger(id) || id === group.id || !groups.some(other => other.id === id)) { warn(group.label + '.if', '依赖编号无效'); return false; }
        return true;
      });
    }
    const sorted = [], pending = groups.slice();
    while (pending.length) {
      const next = pending.findIndex(group => group.dependencies.every(id => sorted.some(other => other.id === id)));
      if (next < 0) {
        for (const group of pending) { warn(group.label + '.if', '循环依赖'); group.dependencies = group.dependencies.filter(id => sorted.some(other => other.id === id)); }
        sorted.push(...pending); break;
      }
      sorted.push(pending.splice(next, 1)[0]);
    }
    const converted = [], where = new Map();
    for (const group of sorted) {
      const dependencies = group.dependencies.flatMap(id => where.get(id) || []);
      const first = converted.length;
      const make = (points, items, tl, ml) => ({ fullScore: points, timeLimit: tl, memoryLimit: ml, inputFiles: items.map(item => item.input), outputFiles: items.map(item => item.output), dependenceSubtask: dependencies });
      if (group.type === 'min') {
        let tl = group.data[0].time, ml = group.data[0].memory;
        if (group.data.some(item => item.time !== tl)) { warn(group.label + '.cases.time', '同一子任务的时限不同，保留子任务时限'); tl = group.time; }
        if (group.data.some(item => item.memory !== ml)) { warn(group.label + '.cases.memory', '同一子任务的内存限制不同，保留子任务限制'); ml = group.memory; }
        if (group.data.some(item => item.score !== undefined && item.score !== group.score)) warn(group.label + '.cases.score', 'min 计分使用子任务分值');
        converted.push(make(group.score, group.data, tl, ml));
      } else {
        if (group.data.reduce((total, item) => total + (item.score || 0), 0) > group.score) {
          warn(group.label + '.cases.score', '测试点分值之和超过子任务分值'); group.data.forEach(item => { item.score = undefined; });
        }
        const remaining = split(group.score - group.data.reduce((total, item) => total + (item.score || 0), 0), group.data.filter(item => item.score === undefined).length);
        for (const item of group.data) converted.push(make(item.score ?? remaining.shift(), [item], item.time, item.memory));
      }
      where.set(group.id, Array.from({ length: converted.length - first }, (_, i) => first + i + 1));
    }
    if (converted.length) patch.testCases = converted;
    else if ((rootTime !== null || rootMemory !== null) && task.testCases?.length)
      patch.testCases = task.testCases.map(item => ({ ...item, timeLimit: rootTime ?? item.timeLimit, memoryLimit: rootMemory ?? item.memoryLimit }));
    const meaningful = Object.keys(patch).length > 0 || !!checkerSource;
    if (meaningful && !own(config, 'type')) patch.taskType = 0;
    if (meaningful && !own(config, 'filename')) { patch.standardInputCheck = true; patch.standardOutputCheck = true; }
    return { patch, warnings, checkerSource, tests: patch.testCases?.reduce((total, item) => total + item.inputFiles.length, 0) || 0 };
  }

  const api = { parse };
  root.LemonHydro = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
