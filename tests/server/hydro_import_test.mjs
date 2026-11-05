import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import hydro from '../../web/hydro-import.js';

const files = ['sum/1.in', 'sum/1.out', 'sum/2.in', 'sum/2.out', 'sum/3.in', 'sum/3.out', 'sum/checker.cpp', 'sum/checker.exe'];
const original = { fullScore: 100, timeLimit: 1000, memoryLimit: 256, inputFiles: ['sum/1.in'], outputFiles: ['sum/1.out'], dependenceSubtask: [] };
const parse = text => hydro.parse(text, { files, base: 'sum', task: { testCases: [original] } });

test('the bundled YAML parser matches the pinned upstream artifact', () => {
  const bytes = readFileSync(new URL('../../web/vendor/js-yaml-4.1.1.min.js', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '0de3dec92d20eab9e0b46a5d928cd45ec025d73e348ddf458dbfb01da00cb473');
});

test('limits and file I/O import without changing source names or original objects', () => {
  const result = parse('time: 2s\nmemory: 512m\nfilename: sum\n');
  assert.deepEqual(result.patch.testCases[0], { ...original, timeLimit: 2000, memoryLimit: 512 });
  assert.equal(original.timeLimit, 1000);
  assert.deepEqual([result.patch.inputFileName, result.patch.outputFileName, result.patch.standardInputCheck], ['sum.in', 'sum.out', false]);
  assert.equal(result.patch.sourceFileName, undefined);
  assert.deepEqual(result.warnings, []);
});

test('Hydro top-level cases use sum scoring with the final cases receiving the remainder', () => {
  const result = parse('time: 1500ms\ncases:\n  - { input: 1.in, output: 1.out }\n  - { input: 2.in, output: 2.out }\n  - { input: 3.in, output: 3.out }\n');
  assert.deepEqual(result.patch.testCases.map(item => item.fullScore), [33, 33, 34]);
  assert.ok(result.patch.testCases.every(item => item.timeLimit === 1500 && item.inputFiles.length === 1));
  assert.equal(result.patch.standardInputCheck, true);
  assert.equal(result.patch.standardOutputCheck, true);
  assert.equal(result.tests, 3);
});

test('min/sum subtasks preserve scores and remap dependencies to all expanded groups', () => {
  const result = parse(`subtasks:
  - id: 7
    type: min
    score: 40
    cases: [{input: 1.in, output: 1.out}, {input: 2.in, output: 2.out}]
  - id: 9
    type: sum
    score: 60
    if: [7]
    cases: [{input: 2.in, output: 2.out}, {input: 3.in, output: 3.out}]
  - id: 10
    type: min
    score: 20
    if: [9]
    cases: [{input: 3.in, output: 3.out}]
`);
  assert.deepEqual(result.patch.testCases.map(item => item.fullScore), [40, 30, 30, 20]);
  assert.deepEqual(result.patch.testCases.map(item => item.dependenceSubtask), [[], [1], [1], [2, 3]]);
  assert.equal(result.patch.testCases[0].inputFiles.length, 2);
});

test('invalid settings and missing cases are reported and skipped independently', () => {
  const result = parse(`time: -1
memory: 1g
filename: 中文
checker_type: unsupported
unknown_option: true
cases:
  - {input: ../private.in, output: 1.out}
  - {input: absent.in, output: absent.out}
  - {input: 2.in, output: 2.out, time: bad, score: -2}
`);
  assert.equal(result.patch.testCases.length, 1);
  assert.deepEqual(result.patch.testCases[0].inputFiles, ['sum/2.in']);
  assert.equal(result.patch.testCases[0].memoryLimit, 1024);
  assert.equal(result.patch.testCases[0].timeLimit, 1000);
  assert.equal(result.patch.inputFileName, undefined);
  assert.equal(result.patch.comparisonMode, undefined);
  assert.ok(result.warnings.length >= 6);
});

test('unsupported aggregations are skipped, not silently changed to min', () => {
  const result = parse(`subtasks:
  - {id: 1, type: max, score: 30, cases: [{input: 1.in, output: 1.out}]}
  - {id: 2, type: min, score: 70, if: [1], cases: [{input: 2.in, output: 2.out}]}
`);
  assert.equal(result.patch.testCases.length, 1);
  assert.equal(result.patch.testCases[0].fullScore, 70);
  assert.deepEqual(result.patch.testCases[0].dependenceSubtask, []);
  assert.ok(result.warnings.some(message => message.includes('计分方式')));
  assert.ok(result.warnings.some(message => message.includes('依赖编号')));
});

test('nonuniform min limits and cyclic dependencies have explicit warnings', () => {
  const result = parse(`time: 1s
subtasks:
  - {id: 1, if: [2], cases: [{input: 1.in, output: 1.out, time: 2s}, {input: 2.in, output: 2.out}]}
  - {id: 2, if: [1], cases: [{input: 3.in, output: 3.out}]}
`);
  assert.ok(result.warnings.some(message => message.includes('循环依赖')));
  assert.ok(result.warnings.some(message => message.includes('时限不同')));
  assert.equal(result.patch.testCases[0].timeLimit, 1000);
  assert.ok(result.patch.testCases.every((item, i) => item.dependenceSubtask.every(dep => dep <= i)));
});

test('checker sources require a successful compile before assignment', () => {
  const source = parse('checker_type: testlib\nchecker: checker.cpp\n');
  assert.deepEqual(source.checkerSource, { path: 'sum/checker.cpp', comparisonMode: 5 });
  assert.equal(source.patch.specialJudge, undefined);
  const executable = parse('checker_type: lemon\nchecker: checker.exe\n');
  assert.equal(executable.patch.specialJudge, 'sum/checker.exe');
  assert.equal(executable.patch.comparisonMode, 4);
});

test('invalid case lists never clear existing data and valid global fields still apply', () => {
  const result = parse('time: 3s\ncases: [{input: absent.in, output: absent.out}]');
  assert.equal(result.patch.testCases[0].timeLimit, 3000);
  assert.deepEqual(result.patch.testCases[0].inputFiles, original.inputFiles);
});

test('implicit testcase files are grouped by Hydro subtask identifiers', () => {
  const result = hydro.parse('subtasks:\n - {id: 1, score: 30}\n - {id: 2, score: 70, if: [1]}', {
    files: ['p/1_1.in', 'p/1_1.out', 'p/1_2.in', 'p/1_2.out', 'p/2_1.in', 'p/2_1.out'], base: 'p', task: {},
  });
  assert.deepEqual(result.patch.testCases.map(item => item.fullScore), [30, 70]);
  assert.deepEqual(result.patch.testCases.map(item => item.inputFiles.length), [2, 1]);
  assert.deepEqual(result.patch.testCases[1].dependenceSubtask, [1]);
});

test('YAML syntax errors, duplicate keys and recursive aliases are rejected', () => {
  assert.throws(() => parse('time: [broken'));
  assert.throws(() => parse('time: 1s\ntime: 2s'));
  assert.throws(() => parse('subtasks: &x [*x]'), /循环引用/);
  assert.throws(() => parse('!!js/function function(){}'));
  const result = parse('__proto__: {polluted: true}\ntime: 2s');
  assert.equal({}.polluted, undefined);
  assert.ok(result.warnings.some(message => message.includes('__proto__')));
});
