/*
 * LemonServer web UI (a fork of LemonLime).
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

// ------------------------------------------------------------------------------------------------
// Constants (mirroring LemonLime's enums and texts)
// ------------------------------------------------------------------------------------------------
const RESULT = [
  // [text, foreground, background]  (Settings::setTextAndColor)
  ['答案正确', '#1c1c1e', 'rgb(192,255,192)'],
  ['答案错误', '#1c1c1e', 'rgb(255,192,192)'],
  ['部分正确', '#1c1c1e', 'rgb(192,255,255)'],
  ['超过时间限制', '#1c1c1e', 'rgb(255,255,192)'],
  ['超过内存限制', '#1c1c1e', 'rgb(192,192,255)'],
  ['无法启动程序', 'rgb(200,30,30)', 'rgb(210,210,210)'],
  ['文件错误', 'rgb(150,110,0)', 'rgb(210,210,210)'],
  ['运行时错误', '#1c1c1e', 'rgb(255,192,255)'],
  ['无效的校验器', '#fff', 'rgb(128,0,0)'],
  ['校验器超时', '#fff', 'rgb(128,128,0)'],
  ['校验器运行时错误', '#fff', 'rgb(128,0,128)'],
  ['跳过', '#8e8e93', 'rgba(118,118,128,.12)'],
  ['交互器错误', '#fff', 'rgb(0,0,128)'],
  ['格式错误', '#1c1c1e', 'rgb(255,216,192)'],
  ['输出超限', '#1c1c1e', 'rgb(216,192,255)'],
];
const COMPILE_STATE = ['编译成功', '未找到源程序', '编译错误', '编译超时', '无法运行编译器', '未找到 grader'];
const RESULT_ABBR = ['AC', 'WA', 'PC', 'TLE', 'MLE', 'CSP', 'FE', 'RE', 'ISPJ', 'SPJ-TLE', 'SPJ-RE', 'SKIP', 'IE', 'PE', 'OLE'];
const COMPILE_ABBR = ['OK', 'NS', 'CE', 'CTLE', 'IC', 'NG'];
// states offered by "rejudge by state", in display order
const REJUDGE_COMPILE = [1, 2, 3, 4, 5];
const REJUDGE_RESULT = [1, 2, 3, 4, 7, 13, 14, 5, 6, 8, 9, 10, 12];
const TASK_TYPES = ['传统', '提交答案', '交互', '通信', '通信（可执行）'];
const COMPARISON_MODES = ['逐行比较', '忽略多余空格', '外部工具 (diff)', '实数比较', 'Lemon 校验器', 'Testlib 校验器'];
const COMPILER_TYPES = ['编译型', '解释型（字节码）', '解释型'];
const EDIT_LIMIT = 100 * 1024;

// ------------------------------------------------------------------------------------------------
// State
// ------------------------------------------------------------------------------------------------
const S = {
  session: localStorage.getItem('lemonserver.session') || '',
  status: null,
  contest: null,
  settings: null,
  compilers: [],
  dataFiles: [],
  sel: { task: -1, testCase: -1, expanded: new Set() },
  resultSel: new Set(),
  fs: { path: '', expanded: new Set(['']), cache: new Map(), selected: new Set() },
  judge: { timer: null, since: 0, log: [], status: null, dialog: null, contest: '' },
};

// ------------------------------------------------------------------------------------------------
// Theme (light / dark / follow system)
// ------------------------------------------------------------------------------------------------
const media = window.matchMedia('(prefers-color-scheme: dark)');
const themeMode = () => localStorage.getItem('lemonserver.theme') || 'auto';
const isDark = () => document.documentElement.dataset.theme === 'dark';
function applyTheme() {
  const mode = themeMode();
  document.documentElement.dataset.theme = mode === 'auto' ? (media.matches ? 'dark' : 'light') : mode;
}
media.addEventListener('change', () => { if (themeMode() === 'auto') { applyTheme(); if (S.session) route(); } });
applyTheme();
function setThemeMode(mode) {
  localStorage.setItem('lemonserver.theme', mode);
  applyTheme();
  for (const b of document.querySelectorAll('.theme-switch')) b.textContent = THEME_LABELS[mode];
  // score colors are computed in JS, so redraw pages that show them
  if (S.settings && $('.topbar')) route();
}
const THEME_LABELS = { auto: '◐ 跟随系统', light: '☀︎ 浅色', dark: '☾ 深色' };
function themeButton() {
  return h('button', {
    class: 'theme-switch', title: '切换深浅色',
    onclick: () => setThemeMode({ auto: 'light', light: 'dark', dark: 'auto' }[themeMode()]),
  }, THEME_LABELS[themeMode()]);
}

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else if (k === 'selected') el.selected = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const enc = encodeURIComponent;
const cpath = (name) => '/api/contests/' + enc(name || S.contest.name);
const fmtMem = (b) => (b < 0 ? '—' : (b / 1024 / 1024).toFixed(2) + ' MiB');
const fmtTime = (t) => (t < 0 ? '—' : t + ' ms');
const qs = (o) => '?' + Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
// value of <input type="datetime-local"> <-> ms since the epoch (browser's time zone)
const toLocalInput = (ms) => (ms == null ? '' : fmtDate(ms).replace(' ', 'T'));
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);
// 'before' | 'running' | 'ended' | null (no contest time)
function contestPhase(c) {
  if (c.startTime == null) return null;
  const now = Date.now() + (S.clockSkew || 0);
  return now < c.startTime ? 'before' : now < c.endTime ? 'running' : 'ended';
}
const joinPath = (a, b) => (a ? a + '/' + b : b);
const parentPath = (p) => p.split('/').slice(0, -1).join('/');

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body, opt = {}) {
  const headers = {};
  if (S.session) headers.Authorization = 'Bearer ' + S.session;
  let payload;
  if (opt.raw !== undefined) {
    payload = opt.raw;
    headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { method, headers, body: payload });
  const ctype = res.headers.get('Content-Type') || '';
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    if (ctype.includes('json')) {
      try {
        const j = await res.json();
        msg = j.contestRunning ? '比赛进行中，结束后才能查看结果和代码' : (j.error || msg);
      } catch (e) { /* ignore */ }
    }
    if (res.status === 401 && !opt.noLoginRedirect) {
      S.session = '';
      localStorage.removeItem('lemonserver.session');
      renderLogin();
    }
    throw new ApiError(res.status, msg);
  }
  if (opt.blob) return res;
  if (ctype.includes('json')) return res.json();
  return res.text();
}

function toast(msg, type = '') {
  const root = $('#toast-root');
  while (root.childNodes.length >= 3) root.firstChild.remove();
  const t = h('div', { class: 'toast ' + type }, msg);
  root.appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 5000 : 2200);
}
const fail = (e) => toast(e.message || String(e), 'error');

function modal({ title, body, buttons = [], onClose, closable = true, wide, beforeClose }) {
  const root = $('#modal-root');
  const back = h('div', { class: 'modal-back' });
  let closed = false;
  const close = async (force) => {
    if (closed) return;
    if (!force && beforeClose && !(await beforeClose())) return;
    closed = true;
    back.remove();
    if (onClose) onClose();
  };
  back._close = closable ? () => close() : null;
  const foot = h('div', { class: 'modal-foot' });
  for (const b of buttons) {
    foot.appendChild(h('button', {
      class: (b.primary ? 'primary ' : '') + (b.danger ? 'danger' : ''),
      onclick: async (ev) => {
        if (!b.onClick) return close();
        ev.currentTarget.disabled = true;
        const btn = ev.currentTarget;
        try {
          const r = await b.onClick(close);
          if (r !== false) close(true);
        } catch (e) { fail(e); } finally { btn.disabled = false; }
      },
    }, b.label));
  }
  const m = h('div', { class: 'modal', style: wide ? { width: wide } : null },
    h('div', { class: 'modal-head' }, title, closable ? h('button', { class: 'x', onclick: () => close(), title: '关闭' }, '✕') : null),
    h('div', { class: 'modal-body' }, body),
    buttons.length ? foot : null);
  back.appendChild(m);
  if (closable) back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  root.appendChild(back);
  const first = m.querySelector('.modal-body input:not([type=checkbox]):not([type=radio]),.modal-body textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: m, foot };
}

function confirmDlg(text, okLabel = '确定', danger = true) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title: '确认', body: h('div', { style: { maxWidth: '440px', lineHeight: 1.6 } }, text),
      buttons: [{ label: '取消' }, { label: okLabel, primary: !danger, danger, onClick: () => { result = true; } }],
      onClose: () => resolve(result),
    });
  });
}

function promptDlg(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { type: 'text', value, placeholder, style: { width: '360px' } });
    const m = modal({
      title, body: input,
      buttons: [{ label: '取消' }, { label: '确定', primary: true, onClick: () => { result = input.value; } }],
      onClose: () => resolve(result),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { result = input.value; m.close(true); } });
  });
}

async function download(path, fallbackName) {
  try {
    const res = await api('GET', path, undefined, { blob: true });
    const blob = await res.blob();
    let name = fallbackName;
    const m = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get('Content-Disposition') || '');
    if (m) name = decodeURIComponent(m[1]);
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) { fail(e); }
}

// Popup menu at (x, y). items: {label, kbd, count, onClick, disabled, danger} | 'sep' | {head}
function showMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { menu.appendChild(h('div', { class: 'msep' })); continue; }
    if (it.head) { menu.appendChild(h('div', { class: 'mhead' }, it.head)); continue; }
    menu.appendChild(h('div', {
      class: 'mi' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : ''),
      onclick: (e) => { e.stopPropagation(); if (it.disabled) return; closeMenu(); it.onClick(); },
    }, it.label, it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null, it.count !== undefined ? h('span', { class: 'count' }, it.count) : null));
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  S.menu = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', menuOutside, true);
    window.addEventListener('blur', closeMenu);
  }, 0);
}
function menuOutside(e) { if (S.menu && !S.menu.contains(e.target)) closeMenu(); }
function closeMenu() {
  if (S.menu) S.menu.remove();
  S.menu = null;
  document.removeEventListener('mousedown', menuOutside, true);
  window.removeEventListener('blur', closeMenu);
}
const menuBelow = (el, items) => { const r = el.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, items); };
const typing = (e) => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function lessFileName(a, b) { return a.length !== b.length ? a.length - b.length : a.localeCompare(b); }

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1024 / 1024).toFixed(2) + ' MiB';
}

const field = (label, input, hint) => [h('label', null, label), hint ? h('div', null, input, h('div', { class: 'hint' }, hint)) : input];

// ---------- colors: port of ColorTheme::getColorPer / getColorGrand ----------
function makePer(p, l, r, bound, distanRate = 1, resComp = 0) {
  const distan = distanRate * (r - l) / bound / 110;
  let res = (resComp + l) / bound + 100 * p * distan;
  if (p > 0) res += distan * 5;
  if (p >= 1 - 1e-12) res += distan * 5;
  while (res < -1e-12) res += 1;
  while (res > 1 + 1e-12) res -= 1;
  return Math.max(0, Math.min(res, 1));
}
function theme() {
  const t = (S.settings && S.settings.colorTheme && S.settings.colorTheme.mx) ? S.settings.colorTheme : {
    mx: [120, 28.9, 64.7], mi: [120, 28.9, 100], nf: [0, 0, 75], ce: [320, 60, 75], grandComp: [0, 1.1, 0], grandRate: [1, 1, 64.7 / 55],
  };
  if (!isDark()) return t;
  // Like ColorTheme::invertLightness() (used by the desktop ResultViewer in dark mode),
  // but compressed into a mid range so low scores don't turn pitch black.
  const inv = (a) => [a[0], a[1], 22 + (100 - a[2]) * 0.55];
  return { ...t, mx: inv(t.mx), mi: inv(t.mi), nf: inv(t.nf), ce: inv(t.ce) };
}
function colorPer(score, full) {
  const t = theme();
  let p = full > 0 ? score / full : 0;
  if (!isFinite(p)) p = 0;
  return `hsl(${makePer(p, t.mi[0], t.mx[0], 360) * 360},${makePer(p, t.mi[1], t.mx[1], 100) * 100}%,${makePer(p, t.mi[2], t.mx[2], 100) * 100}%)`;
}
function colorGrand(score, full) {
  const t = theme();
  let p = full > 0 ? score / full : 0;
  if (!isFinite(p)) p = 0;
  return `hsl(${makePer(p, t.mi[0], t.mx[0], 360, t.grandRate[0], t.grandComp[0]) * 360},${makePer(p, t.mi[1], t.mx[1], 100, t.grandRate[1], t.grandComp[1]) * 100}%,${makePer(p, t.mi[2], t.mx[2], 100, t.grandRate[2], t.grandComp[2]) * 100}%)`;
}
const hslOf = (a) => `hsl(${a[0]},${a[1]}%,${a[2]}%)`;
const resultTag = (state) => {
  const [txt, fg, bg] = RESULT[state] || ['?', '#1c1c1e', '#ddd'];
  return h('span', { class: 'tag', style: { color: fg, background: bg } }, txt);
};

// ------------------------------------------------------------------------------------------------
// Boot / routing
// ------------------------------------------------------------------------------------------------
async function boot() {
  try {
    S.status = await api('GET', '/api/auth/status', undefined, { noLoginRedirect: true });
  } catch (e) {
    document.body.textContent = '无法连接服务器：' + e.message;
    return;
  }
  if (!S.status.authenticated) return renderLogin();
  if (S.status.setupRequired) return renderSetup();
  route();
}

window.addEventListener('hashchange', () => {
  for (const m of [...document.querySelectorAll('#modal-root > .modal-back')]) if (m._close) m._close();
  if (S.session) route();
});
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (S.menu) { closeMenu(); return; }
  const all = document.querySelectorAll('#modal-root > .modal-back');
  const top = all[all.length - 1];
  if (top && top._close) top._close();
});

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  try {
    if (!S.settings) await loadSettings();
    if (parts[0] === 'contest' && parts[1]) return await renderContest(parts[1], parts[2] || 'tasks');
    if (parts[0] === 'settings') return await renderSettings(parts[1] || 'general');
    if (parts[0] === 'api') return renderApiDoc();
    return await renderContestList();
  } catch (e) {
    if (e.status !== 401) {
      fail(e);
      if (parts[0] === 'contest') go('#/contests');
    }
  }
}

async function loadSettings() {
  [S.settings, S.compilers] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/compilers')]);
}

function shell(content, title) {
  const app = $('#app');
  app.innerHTML = '';
  app.appendChild(h('div', { class: 'topbar' },
    h('div', { class: 'brand', onclick: () => go('#/contests') }, h('img', { src: 'logo.png', alt: '' }), 'LemonServer'),
    title ? h('div', { class: 'title' }, title) : null,
    h('div', { class: 'spacer' }),
    h('span', { class: 'judging-badge hidden', id: 'judge-badge', onclick: () => openJudgeDialog() }),
    h('button', { onclick: () => go('#/contests') }, '比赛'),
    h('button', { onclick: () => go('#/settings/general') }, '设置'),
    h('button', { onclick: () => go('#/api') }, 'API'),
    themeButton(),
    h('button', { onclick: logout }, '退出')));
  app.appendChild(h('div', { class: 'main' }, content));
  updateJudgeBadge();
}

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
  S.session = '';
  localStorage.removeItem('lemonserver.session');
  renderLogin();
}

// ------------------------------------------------------------------------------------------------
// Login & first time setup
// ------------------------------------------------------------------------------------------------
function renderLogin() {
  stopJudgePolling();
  $('#modal-root').innerHTML = '';
  const app = $('#app');
  app.innerHTML = '';
  const input = h('input', { type: 'password', placeholder: '访问令牌', autocomplete: 'current-password' });
  const err = h('div', { class: 'error-text' });
  const submit = async () => {
    err.textContent = '';
    try {
      const r = await api('POST', '/api/auth/login', { token: input.value }, { noLoginRedirect: true });
      S.session = r.session;
      localStorage.setItem('lemonserver.session', r.session);
      S.settings = null;
      if (r.tokenIsDefault) toast('仍在使用默认令牌，建议在设置中修改');
      boot();
    } catch (e) { err.textContent = e.message; input.select(); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  app.appendChild(h('div', { class: 'login-wrap' }, h('div', { class: 'login-box' },
    h('img', { src: 'logo.png', alt: '' }),
    h('h2', null, 'LemonServer'),
    input, err,
    h('button', { class: 'primary', onclick: submit }, '登录'),
    h('div', { style: { marginTop: '14px' } }, themeButton()))));
  input.focus();
}

async function renderSetup() {
  const app = $('#app');
  app.innerHTML = '';
  const setup = await api('GET', '/api/setup');
  const root = h('input', { type: 'text', value: setup.contestRoot || setup.suggestedRoot, style: { maxWidth: 'none' } });
  const t1 = h('input', { type: 'password', placeholder: '留空则不修改' });
  const t2 = h('input', { type: 'password' });
  const err = h('div', { class: 'error-text' });
  const submit = async () => {
    err.textContent = '';
    if (t1.value && t1.value !== t2.value) { err.textContent = '两次输入的令牌不一致'; return; }
    try {
      await api('PUT', '/api/setup', { contestRoot: root.value.trim() });
      if (t1.value) {
        const r = await api('PUT', '/api/auth/token', { currentToken: '123456', newToken: t1.value });
        S.session = r.session;
        localStorage.setItem('lemonserver.session', r.session);
      }
      S.status.setupRequired = false;
      go('#/contests');
    } catch (e) { err.textContent = e.message; }
  };
  app.appendChild(h('div', { class: 'login-wrap' }, h('div', { class: 'card', style: { width: '600px', padding: '26px 28px' } },
    h('h2', null, '首次使用'),
    h('p', { class: 'muted', style: { marginTop: 0 } }, '新建的比赛会保存在默认比赛位置下的同名文件夹中。'),
    h('div', { class: 'form-grid', style: { gridTemplateColumns: '110px 1fr' } },
      field('默认比赛位置', root, '服务器上的绝对路径'),
      field('新访问令牌', t1),
      field('确认令牌', t2)),
    err,
    h('div', { class: 'row', style: { marginTop: '18px' } }, h('button', { class: 'primary right', onclick: submit }, '完成')))));
}

// ------------------------------------------------------------------------------------------------
// Contest list
// ------------------------------------------------------------------------------------------------
async function renderContestList() {
  const data = await api('GET', '/api/contests');
  const name = h('input', { type: 'text', placeholder: '比赛名', style: { width: '320px' } });
  const create = async () => {
    const n = name.value.trim();
    if (!n) return name.focus();
    try {
      await api('POST', '/api/contests', { name: n });
      go('#/contest/' + enc(n) + '/tasks');
    } catch (e) { fail(e); }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  const items = data.contests.map((c) => h('div', { class: 'list-item' },
    h('div', { class: 'grow', style: { cursor: 'pointer' }, onclick: () => go('#/contest/' + enc(c.name) + '/tasks') },
      h('div', { class: 'title' }, c.title || c.name, c.current ? h('span', { class: 'pill', style: { marginLeft: '8px' } }, '已打开') : null,
        c.startTime != null ? h('span', { style: { marginLeft: '8px' } }, contestTimeLabel(c)) : null),
      h('div', { class: 'muted small-text' }, [c.title && c.title !== c.name ? c.name : null, `${c.tasks ?? '-'} 题`, `${c.contestants ?? '-'} 名选手`,
        c.startTime != null ? `${fmtDate(c.startTime)} – ${fmtDate(c.endTime)}` : c.modified].filter(Boolean).join(' · '))),
    h('button', { class: 'primary', onclick: () => go('#/contest/' + enc(c.name) + '/tasks') }, '打开'),
    h('button', {
      class: 'danger', onclick: async () => {
        if (!await confirmDlg(`删除比赛“${c.name}”及其全部数据和选手程序？此操作无法恢复。`, '删除')) return;
        try { await api('DELETE', cpath(c.name)); route(); } catch (e) { fail(e); }
      },
    }, '删除')));
  const importCard = h('div', { class: 'card' },
    h('h2', null, '导入比赛'),
    h('div', { class: 'row' },
      h('button', { onclick: () => pickContestUpload({ accept: '.zip' }, (fs) => fs.length && importContestZip(fs[0])) }, '上传 zip'),
      h('button', { onclick: () => pickContestUpload({ webkitdirectory: true, multiple: true }, (fs) => fs.length && importContestFolder(fs.map((f) => ({ file: f, rel: f.webkitRelativePath || f.name })))) }, '上传文件夹'),
      h('span', { class: 'hint' }, '包含 .cdf 的比赛文件夹（含 data、source），或其 zip；也可以直接拖到这里')));
  importCard.addEventListener('dragover', (e) => { e.preventDefault(); importCard.style.boxShadow = '0 0 0 2px var(--blue)'; });
  importCard.addEventListener('dragleave', () => { importCard.style.boxShadow = ''; });
  importCard.addEventListener('drop', async (e) => {
    e.preventDefault();
    importCard.style.boxShadow = '';
    const items = await collectDroppedFiles(e);
    if (items.length === 1 && /\.zip$/i.test(items[0].file.name)) importContestZip(items[0].file);
    else if (items.length) importContestFolder(items);
  });
  shell(h('div', { class: 'page' }, h('div', { class: 'narrow' },
    h('div', { class: 'card' },
      h('h2', null, '新建比赛'),
      h('div', { class: 'row' }, name, h('button', { class: 'primary', onclick: create }, '新建')),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, '保存在 ', h('code', null, data.contestRoot), ' · ', h('a', { href: '#/settings/folder' }, '更改'))),
    importCard,
    h('div', { class: 'card' },
      h('h2', null, '全部比赛'),
      data.contests.length ? items : h('div', { class: 'empty' }, '暂无比赛')))));
  name.focus();
  checkJudgeStatus();
}

function pickContestUpload(attrs, cb) {
  const inp = h('input', { type: 'file', ...attrs, style: { display: 'none' } });
  inp.addEventListener('change', () => { cb([...inp.files]); inp.remove(); });
  document.body.appendChild(inp);
  inp.click();
}

// Collect dropped files and folders as [{file, rel}]
async function collectDroppedFiles(e) {
  const items = [];
  const walk = (entry, prefix) => new Promise((resolve) => {
    if (entry.isFile) entry.file((f) => { items.push({ file: f, rel: prefix + f.name }); resolve(); }, () => resolve());
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const batch = () => reader.readEntries(async (ents) => {
        if (!ents.length) { for (const x of all) await walk(x, prefix + entry.name + '/'); resolve(); } else { all.push(...ents); batch(); }
      }, () => resolve());
      batch();
    } else resolve();
  });
  const roots = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (roots.length) for (const r of roots) await walk(r, '');
  else for (const f of e.dataTransfer.files) items.push({ file: f, rel: f.name });
  return items;
}

// Ask for the contest name (and whether to overwrite) before importing
function importOptions(defaultName) {
  return new Promise((resolve) => {
    let result = null;
    const name = h('input', { type: 'text', value: defaultName, style: { width: '320px' } });
    const over = h('input', { type: 'checkbox' });
    modal({
      title: '导入比赛',
      body: h('div', { class: 'form-grid', style: { gridTemplateColumns: '80px 1fr' } },
        field('比赛名', name, '保存为默认比赛位置下的同名文件夹'),
        field('', h('label', { class: 'inline' }, over, '同名比赛已存在时覆盖'))),
      buttons: [{ label: '取消' }, { label: '导入', primary: true, onClick: () => { result = { name: name.value.trim(), overwrite: over.checked }; } }],
      onClose: () => resolve(result),
    });
  });
}

async function finishImport(r) {
  toast(`已导入比赛 ${r.name}`);
  go('#/contest/' + enc(r.name) + '/tasks');
}

async function importContestZip(file) {
  const opt = await importOptions(file.name.replace(/\.zip$/i, ''));
  if (!opt) return;
  const dlg = modal({ title: '正在上传并导入…', body: h('div', { class: 'progress', style: { width: '360px' } }, h('div', { style: { width: '100%' } })), closable: false });
  try {
    const r = await api('POST', '/api/import-contest' + qs({ name: opt.name, overwrite: opt.overwrite ? 1 : 0 }), undefined, { raw: file });
    dlg.close(true);
    finishImport(r);
  } catch (e) { dlg.close(true); fail(e); }
}

async function importContestFolder(items) {
  // a picked/dropped folder arrives as "<folder>/<path>"; the folder name is the default contest name
  const tops = new Set(items.map((it) => it.rel.split('/')[0]));
  const single = tops.size === 1 && items.every((it) => it.rel.includes('/'));
  const top = single ? [...tops][0] : '';
  if (!items.some((it) => /\.cdf$/i.test(it.rel))) return toast('文件夹中没有 .cdf 文件', 'error');
  const opt = await importOptions(top || (items.find((it) => /\.cdf$/i.test(it.rel)).rel.split('/').pop().replace(/\.cdf$/i, '')));
  if (!opt) return;
  const id = 'web-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const label = h('div', { class: 'progress-label' });
  const bar = h('div', { style: { width: '0%' } });
  const dlg = modal({ title: '正在上传比赛…', body: h('div', { style: { width: '420px' } }, h('div', { class: 'progress' }, bar), label), closable: false });
  try {
    let n = 0;
    for (const it of items) {
      const rel = single ? it.rel.slice(top.length + 1) : it.rel;
      label.textContent = `${++n} / ${items.length} · ${rel}`;
      bar.style.width = (n / items.length * 100) + '%';
      await api('PUT', '/api/import-contest/file' + qs({ id, path: rel }), undefined, { raw: it.file });
    }
    label.textContent = '正在导入…';
    const r = await api('POST', '/api/import-contest/finish' + qs({ id, name: opt.name, overwrite: opt.overwrite ? 1 : 0 }));
    dlg.close(true);
    finishImport(r);
  } catch (e) {
    dlg.close(true);
    fail(e);
    api('DELETE', '/api/import-contest' + qs({ id })).catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------------
// Contest page
// ------------------------------------------------------------------------------------------------
async function reloadContest() {
  S.contest = await api('GET', cpath(S.contest.name));
  S.clockSkew = S.contest.serverTime - Date.now();
  return S.contest;
}

// Re-render the contest page when the contest starts or ends, so results are hidden / shown on time.
function scheduleContestPhaseChange() {
  clearTimeout(S.phaseTimer);
  const c = S.contest;
  const phase = contestPhase(c);
  if (phase !== 'before' && phase !== 'running') return;
  const at = (phase === 'before' ? c.startTime : c.endTime) - (Date.now() + (S.clockSkew || 0));
  const name = c.name;
  // setTimeout cannot wait more than ~24.8 days; check again later in that case
  S.phaseTimer = setTimeout(() => {
    if (S.contest && S.contest.name === name && location.hash.startsWith('#/contest/' + enc(name))) route();
  }, Math.min(at + 500, 2 ** 31 - 1));
}

function contestTimeLabel(c) {
  const phase = contestPhase(c);
  if (!phase) return null;
  const text = { before: '未开始', running: '比赛中', ended: '已结束' }[phase];
  return h('span', { class: 'pill contest-phase ' + phase, title: `${fmtDate(c.startTime)} – ${fmtDate(c.endTime)}` },
    phase === 'running' ? `${text} · 至 ${fmtDate(c.endTime).slice(5)}` : text);
}

async function loadDataFiles() {
  try {
    const r = await api('GET', cpath() + '/files' + qs({ root: 'data', recursive: 1 }));
    S.dataFiles = r.entries.map((e) => e.path).sort(lessFileName);
  } catch (e) { S.dataFiles = []; }
  let dl = $('#datafiles');
  if (!dl) { dl = h('datalist', { id: 'datafiles' }); document.body.appendChild(dl); }
  dl.innerHTML = '';
  for (const f of S.dataFiles) dl.appendChild(h('option', { value: f }));
}

async function renderContest(name, tab) {
  const prev = S.contest && S.contest.name;
  S.contest = await api('GET', cpath(name));
  S.clockSkew = S.contest.serverTime - Date.now();
  scheduleContestPhaseChange();
  if (prev !== name) {
    S.sel = { task: S.contest.tasks.length ? 0 : -1, testCase: -1, expanded: new Set() };
    S.resultSel = new Set();
    S.fs = { path: '', expanded: new Set(['']), cache: new Map(), selected: new Set() };
  }
  await loadDataFiles();
  const tabs = [['tasks', '试题'], ['results', '结果'], ['statistics', '统计'], ['files', '文件']];
  const title = h('span', null, h('span', { class: 'editable', title: '修改比赛名称', onclick: renameContest }, S.contest.title));
  const page = h('div', { class: 'tabpage' });
  if (S.fsView && tab !== 'files') S.fsView = null;
  shell(h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
    h('div', { class: 'subbar' },
      h('div', { class: 'segmented' }, tabs.map(([k, label]) => h('div', {
        class: k === tab ? 'active' : '', onclick: () => go('#/contest/' + enc(name) + '/' + k),
      }, label))),
      h('button', { class: 'small', onclick: openContestProperties }, '比赛设置'),
      contestTimeLabel(S.contest),
      h('div', { class: 'path', title: S.contest.directory }, S.contest.directory),
      h('button', { class: 'small hidden', id: 'judge-panel-toggle', onclick: () => { S.judge.panelOpen = true; renderJudgePanel(); } }, '评测日志')),
    h('div', { class: 'contest-body' }, page, h('div', { id: 'judge-panel-slot', style: { display: 'contents' } }))), title);
  renderJudgePanel();
  if (tab === 'tasks') renderTasksTab(page);
  else if (tab === 'results') renderResultsTab(page);
  else if (tab === 'statistics') await renderStatisticsTab(page);
  else if (tab === 'files') await renderFilesTab(page);
  checkJudgeStatus();
}

async function renameContest() {
  const t = await promptDlg('比赛名称', S.contest.title);
  if (t === null || !t.trim()) return;
  try { await api('PUT', cpath(), { title: t.trim() }); route(); } catch (e) { fail(e); }
}

// Contest time and down.zip (LemonServer's own contest properties)
function openContestProperties() {
  const c = S.contest;
  let changed = false;
  const start = h('input', { type: 'datetime-local', value: toLocalInput(c.startTime) });
  const end = h('input', { type: 'datetime-local', value: toLocalInput(c.endTime) });
  const clearTime = h('button', { class: 'small', onclick: () => { start.value = ''; end.value = ''; } }, '清除');
  const down = h('div');
  const zipList = h('datalist', { id: 'contest-zip-files' });
  api('GET', cpath() + '/files' + qs({ root: 'contest', recursive: 1 })).then((r) => {
    for (const e of r.entries) if (/\.zip$/i.test(e.path)) zipList.appendChild(h('option', { value: e.path }));
  }).catch(() => {});

  const setDown = async (fn) => {
    try { const p = await fn(); Object.assign(S.contest, p.downZip !== undefined ? { downZip: p.downZip } : {}); changed = true; renderDown(); } catch (e) { fail(e); }
  };
  const renderDown = () => {
    const d = S.contest.downZip;
    const pathInput = h('input', { type: 'text', list: 'contest-zip-files', placeholder: '比赛文件夹中的路径，如 down.zip', style: { width: '260px' } });
    const upload = () => pickContestUpload({ accept: '.zip' }, (fs) => fs.length && setDown(() => api('PUT', cpath() + '/down-zip', undefined, { raw: fs[0] })));
    down.innerHTML = '';
    down.appendChild(h('div', { class: 'row', style: { marginBottom: '8px' } },
      d ? h('span', null, h('code', null, d.path), ' ', h('span', { class: d.exists ? 'muted small-text' : 'error-text small-text' }, d.exists ? `${formatSize(d.size)} · ${d.modified}` : '文件不存在'))
        : h('span', { class: 'muted' }, '未设置'),
      d && d.exists ? h('button', { class: 'small', onclick: () => download(cpath() + '/down-zip', 'down.zip') }, '下载') : null,
      d ? h('button', { class: 'small danger', onclick: () => setDown(() => api('DELETE', cpath() + '/down-zip')) }, '清除') : null));
    down.appendChild(h('div', { class: 'row' },
      h('button', { class: 'small', onclick: upload }, d ? '重新上传' : '上传 zip'),
      h('span', { class: 'muted small-text' }, '或'),
      pathInput,
      h('button', {
        class: 'small', onclick: () => pathInput.value.trim() && setDown(async () => (await api('PUT', cpath(), { downZip: pathInput.value.trim() }))),
      }, '设为 down.zip')));
  };
  renderDown();

  modal({
    title: '比赛设置',
    wide: '560px',
    body: h('div', null,
      h('div', { class: 'section-title', style: { marginTop: 0 } }, '比赛时间'),
      h('div', { class: 'form-grid', style: { gridTemplateColumns: '70px 1fr' } },
        field('开始', h('div', { class: 'row' }, start, clearTime)),
        field('结束', end)),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, '可不设置。比赛中不能查看成绩和代码，只显示提交情况和评测进度。'),
      h('div', { class: 'section-title', style: { marginTop: '20px', textTransform: 'none' } }, 'down.zip'),
      down,
      h('div', { class: 'hint', style: { marginTop: '8px' } }, '可不设置，备用。上传的文件保存为比赛文件夹中的 down.zip。'),
      zipList),
    buttons: [{ label: '取消' }, {
      label: '保存', primary: true, onClick: async () => {
        const s = fromLocalInput(start.value), e = fromLocalInput(end.value);
        if ((s === null) !== (e === null)) { toast('请同时填写开始和结束时间', 'error'); return false; }
        if (s !== null && e <= s) { toast('结束时间必须晚于开始时间', 'error'); return false; }
        if (start.value !== toLocalInput(c.startTime) || end.value !== toLocalInput(c.endTime)) { await api('PUT', cpath(), { startTime: s, endTime: e }); changed = true; }
      },
    }],
    onClose: () => { if (changed) route(); },
  });
}

// ---------------------------------------- tasks tab (SummaryTree + TaskEditWidget) -----------
function renderTasksTab(page) {
  const treeList = h('div', { class: 'tree-list' });
  const editor = h('div', { class: 'editor' });
  const judging = S.contest.judging;
  const noTask = S.sel.task < 0;
  const onCase = S.sel.testCase >= 0;
  page.appendChild(h('div', { class: 'split' },
    h('div', { class: 'tree' },
      h('div', { class: 'tree-head' }, '试题', h('span', { class: 'right muted small-text', style: { fontWeight: 400 } }, '总分 ' + S.contest.totalScore)),
      treeList,
      h('div', { class: 'tree-actions' },
        h('button', { class: 'small', onclick: addTask, disabled: judging }, '新建试题'),
        h('button', { class: 'small', onclick: autoAddTasks, disabled: judging }, '自动添加'),
        h('button', { class: 'small', onclick: () => addTestCase(), disabled: judging || noTask }, '新建测试点'),
        h('button', { class: 'small', onclick: () => addTestCasesWizard(), disabled: judging || noTask }, '批量添加测试点'),
        h('button', { class: 'small', onclick: () => openTestCaseManager(S.sel.task), disabled: judging || noTask }, '管理测试点'),
        h('button', { class: 'small', onclick: () => moveTask(-1), disabled: judging || S.sel.task <= 0 || onCase, title: '上移' }, '↑'),
        h('button', { class: 'small', onclick: () => moveTask(1), disabled: judging || noTask || onCase || S.sel.task >= S.contest.tasks.length - 1, title: '下移' }, '↓'),
        h('button', { class: 'small danger', onclick: deleteSelected, disabled: judging || noTask }, '删除'))),
    editor));

  const tasks = S.contest.tasks;
  if (!tasks.length) treeList.appendChild(h('div', { class: 'empty' }, '暂无试题'));
  tasks.forEach((t, i) => {
    const open = S.sel.expanded.has(i) || S.sel.task === i;
    treeList.appendChild(h('div', {
      class: 'tree-item' + (S.sel.task === i && S.sel.testCase < 0 ? ' selected' : ''),
      onclick: () => { S.sel.task = i; S.sel.testCase = -1; S.sel.expanded.add(i); rerenderTasks(); },
    }, h('span', {
      class: 'twisty', onclick: (e) => { e.stopPropagation(); if (S.sel.expanded.has(i)) S.sel.expanded.delete(i); else S.sel.expanded.add(i); rerenderTasks(); },
    }, open ? '▼' : '▶'), h('span', { class: 'label' }, t.problemTitle || '(未命名)'), h('span', { class: 'score' }, t.totalScore)));
    if (open) {
      t.testCases.forEach((tc, j) => {
        treeList.appendChild(h('div', {
          class: 'tree-item child' + (S.sel.task === i && S.sel.testCase === j ? ' selected' : ''),
          onclick: () => { S.sel.task = i; S.sel.testCase = j; rerenderTasks(); },
        }, h('span', { class: 'label' }, '#' + (j + 1)), h('span', { class: 'score' }, tc.fullScore + (tc.inputFiles.length > 1 ? ` · ${tc.inputFiles.length} 组` : ''))));
      });
    }
  });

  if (S.sel.task >= 0 && tasks[S.sel.task]) {
    if (onCase && tasks[S.sel.task].testCases[S.sel.testCase]) renderTestCaseEditor(editor, S.sel.task, S.sel.testCase);
    else renderTaskEditor(editor, S.sel.task);
  } else {
    editor.appendChild(h('div', { class: 'empty' }, '把数据放到 data/<题目名>/ 后点“自动添加”，或手动新建试题。'));
  }
}

function rerenderTasks() {
  const page = $('.tabpage');
  page.innerHTML = '';
  renderTasksTab(page);
}

async function saveTask(i, patch) {
  const t = await api('PUT', cpath() + '/tasks/' + i, patch);
  S.contest.tasks[i] = t;
  S.contest.totalScore = S.contest.tasks.reduce((a, x) => a + x.totalScore, 0);
  return t;
}

async function addTask() {
  try {
    const r = await api('POST', cpath() + '/tasks', {});
    await reloadContest();
    S.sel.task = r.index; S.sel.testCase = -1;
    rerenderTasks();
  } catch (e) { fail(e); }
}

async function addTestCase() {
  const i = S.sel.task;
  const t = S.contest.tasks[i];
  const tc = { fullScore: S.settings.defaultFullScore, timeLimit: S.settings.defaultTimeLimit, memoryLimit: S.settings.defaultMemoryLimit, inputFiles: [], outputFiles: [], dependenceSubtask: [] };
  try {
    await saveTask(i, { testCases: [...t.testCases, tc] });
    S.sel.testCase = S.contest.tasks[i].testCases.length - 1;
    S.sel.expanded.add(i);
    rerenderTasks();
  } catch (e) { fail(e); }
}

async function moveTask(d) {
  try {
    const r = await api('POST', cpath() + '/tasks/' + S.sel.task + '/move', { direction: d < 0 ? 'up' : 'down' });
    await reloadContest();
    S.sel.task = r.index;
    rerenderTasks();
  } catch (e) { fail(e); }
}

async function deleteSelected() {
  const i = S.sel.task;
  const t = S.contest.tasks[i];
  try {
    if (S.sel.testCase >= 0) {
      if (!await confirmDlg(`删除测试点 #${S.sel.testCase + 1}？`, '删除')) return;
      const cases = t.testCases.filter((_, j) => j !== S.sel.testCase).map((tc) => ({ ...tc, dependenceSubtask: [] }));
      await saveTask(i, { testCases: cases });
      S.sel.testCase = -1;
    } else {
      if (!await confirmDlg(`删除试题“${t.problemTitle}”？数据文件会保留。`, '删除')) return;
      await api('DELETE', cpath() + '/tasks/' + i);
      await reloadContest();
      S.sel.task = Math.min(i, S.contest.tasks.length - 1);
    }
    rerenderTasks();
  } catch (e) { fail(e); }
}

async function autoAddTasks() {
  let found;
  try { found = await api('GET', cpath() + '/scan-tasks'); } catch (e) { return fail(e); }
  if (!found.length) {
    return modal({
      title: '自动添加试题',
      body: h('div', { style: { maxWidth: '420px', lineHeight: 1.6 } }, 'data 中没有发现新的试题。每道题放在 ', h('code', null, 'data/<题目名>/'), '，输入输出文件同名配对。'),
      buttons: [{ label: '去上传', onClick: () => go('#/contest/' + enc(S.contest.name) + '/files') }, { label: '好', primary: true }],
    });
  }
  const rows = found.map((t) => ({
    t, use: h('input', { type: 'checkbox', checked: true }),
    score: h('input', { type: 'number', value: t.fullScore, style: { width: '80px' } }),
    time: h('input', { type: 'number', value: t.timeLimit, style: { width: '90px' } }),
    mem: h('input', { type: 'number', value: t.memoryLimit, style: { width: '90px' } }),
  }));
  modal({
    title: '自动添加试题',
    body: h('table', { class: 'grid' },
      h('tr', null, h('th', null, ''), h('th', null, '试题'), h('th', null, '测试点'), h('th', null, '总分'), h('th', null, '时限 ms'), h('th', null, '内存 MiB')),
      rows.map((r) => h('tr', null, h('td', null, r.use), h('td', null, r.t.name), h('td', { class: 'center' }, r.t.testCases.length), h('td', null, r.score), h('td', null, r.time), h('td', null, r.mem)))),
    buttons: [{ label: '取消' }, {
      label: '添加', primary: true, onClick: async () => {
        const tasks = rows.filter((r) => r.use.checked).map((r) => ({ name: r.t.name, fullScore: +r.score.value, timeLimit: +r.time.value, memoryLimit: +r.mem.value }));
        if (!tasks.length) return;
        const res = await api('POST', cpath() + '/add-tasks', { tasks });
        toast(`已添加 ${res.added} 道试题`);
        await reloadContest();
        rerenderTasks();
      },
    }],
  });
}

function renderTaskEditor(editor, i) {
  const t = JSON.parse(JSON.stringify(S.contest.tasks[i]));
  const status = h('span', { class: 'status-saved' });
  const disabled = S.contest.judging;
  const pending = {};
  const save = debounce(async (patch) => {
    status.textContent = '保存中…';
    try {
      await saveTask(i, patch);
      status.textContent = '已保存';
      const label = document.querySelectorAll('.tree-item:not(.child) .label')[i];
      if (label) label.textContent = S.contest.tasks[i].problemTitle || '(未命名)';
    } catch (e) { status.textContent = ''; fail(e); }
  }, 500);
  const set = (k, v) => { t[k] = v; pending[k] = v; save({ ...pending }); };
  const saveNow = async (patch) => {
    try { await saveTask(i, { ...pending, ...patch }); rerenderEditor(); } catch (e) { fail(e); }
  };
  function rerenderEditor() { editor.innerHTML = ''; renderTaskEditor(editor, i); }

  const text = (k, attrs = {}) => h('input', { type: 'text', value: t[k] ?? '', disabled, oninput: (e) => set(k, e.target.value), ...attrs });
  const num = (k, attrs = {}) => h('input', { type: 'number', value: t[k], disabled, oninput: (e) => set(k, +e.target.value), ...attrs });
  const check = (k, label) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: t[k], disabled, onchange: (e) => set(k, e.target.checked) }), label);
  const dataPath = (k) => text(k, { list: 'datafiles', placeholder: 'data 中的路径' });

  const typeSeg = h('div', { class: 'segmented' }, TASK_TYPES.map((label, v) => h('div', {
    class: t.taskType === v ? 'active' : '', onclick: () => { if (!disabled && t.taskType !== v) saveNow({ taskType: v }); },
  }, label)));
  const cmpSelect = h('select', { disabled, onchange: (e) => saveNow({ comparisonMode: +e.target.value }) },
    COMPARISON_MODES.map((label, v) => h('option', { value: v, selected: t.comparisonMode === v }, label)));

  const isProgram = t.taskType !== 1;
  const isComm = t.taskType === 3 || t.taskType === 4;
  const titleInput = text('problemTitle', {
    oninput: (e) => {
      const old = t.problemTitle;
      set('problemTitle', e.target.value);
      // keep the source file name following the title while they matched (TaskEditWidget)
      if (/^\w*$/.test(e.target.value) && t.sourceFileName === old) {
        set('sourceFileName', e.target.value);
        const src = $('#f-src');
        if (src) src.value = e.target.value;
      }
    },
  });

  const grid = h('div', { class: 'form-grid' },
    field('名称', titleInput),
    field('类型', typeSeg),
    isProgram && !isComm ? field('源程序名', text('sourceFileName', { id: 'f-src', placeholder: '不含扩展名' })) : null,
    isProgram ? field('', check('subFolderCheck', '源程序在选手的同名子文件夹中')) : null,
    isProgram ? field('输入文件', h('div', { class: 'row' }, h('div', { style: { flex: '0 1 260px' } }, text('inputFileName')), check('standardInputCheck', '标准输入'))) : null,
    isProgram ? field('输出文件', h('div', { class: 'row' }, h('div', { style: { flex: '0 1 260px' } }, text('outputFileName')), check('standardOutputCheck', '标准输出'))) : null,
    !isProgram ? field('答案扩展名', text('answerFileExtension')) : null,
    field('比较方式', cmpSelect),
    t.comparisonMode === 2 ? field('diff 参数', text('diffArguments')) : null,
    t.comparisonMode === 3 ? field('精度（位）', num('realPrecision', { min: 0, max: 18 })) : null,
    t.comparisonMode >= 4 ? field('校验器', dataPath('specialJudge')) : null,
    t.taskType === 2 ? field('交互库', dataPath('interactor')) : null,
    t.taskType === 2 ? field('交互库文件名', text('interactorName')) : null,
    t.taskType === 2 ? field('Grader', dataPath('grader')) : null,
  );

  const pairTable = (pathKey, nameKey, label, pathHeader) => {
    const rows = t[pathKey].map((p, j) => [p, t[nameKey][j] || '']);
    const update = () => { set(pathKey, rows.map((r) => r[0])); set(nameKey, rows.map((r) => r[1])); };
    const body = h('tbody');
    const draw = () => {
      body.innerHTML = '';
      rows.forEach((r, j) => body.appendChild(h('tr', null,
        h('td', null, h('input', { type: 'text', value: r[0], list: pathKey.startsWith('grader') ? 'datafiles' : null, style: { width: '100%' }, oninput: (e) => { r[0] = e.target.value; update(); } })),
        h('td', null, h('input', { type: 'text', value: r[1], style: { width: '100%' }, oninput: (e) => { r[1] = e.target.value; update(); } })),
        h('td', { style: { width: '40px' } }, h('button', { class: 'small danger', disabled, onclick: () => { rows.splice(j, 1); update(); draw(); } }, '✕')))));
    };
    draw();
    return h('div', { class: 'section' }, h('div', { class: 'section-title' }, label),
      h('table', { class: 'grid boxed' }, h('tr', null, h('th', null, pathHeader), h('th', null, '编译时文件名'), h('th', null, '')), body),
      h('button', { class: 'small plain', disabled, style: { marginTop: '6px' }, onclick: () => { rows.push(['', '']); draw(); } }, '＋ 添加'));
  };

  editor.appendChild(h('div', { class: 'editor-head' }, h('h2', null, t.problemTitle || '试题'), status,
    disabled ? h('span', { class: 'error-text small-text' }, '评测中，暂不可修改') : null));
  editor.appendChild(grid);
  if (isComm) {
    editor.appendChild(pairTable('sourceFilesPath', 'sourceFilesName', '选手源文件', '选手目录中的文件'));
    editor.appendChild(pairTable('graderFilesPath', 'graderFilesName', 'Grader 文件', 'data 中的路径'));
  }
  if (isProgram) {
    editor.appendChild(h('div', { class: 'section' }, h('div', { class: 'section-title' }, '编译器'),
      S.compilers.length ? h('div', { class: 'group' }, h('div', { class: 'form-grid', style: { gridTemplateColumns: '116px 1fr' } }, S.compilers.map((c) => field(c.compilerName,
        h('select', {
          disabled, onchange: (e) => set('compilerConfiguration', { ...t.compilerConfiguration, [c.compilerName]: e.target.value }),
        }, h('option', { value: 'disable', selected: t.compilerConfiguration[c.compilerName] === 'disable' }, '禁用'),
        c.configurationNames.map((n) => h('option', { value: n, selected: (t.compilerConfiguration[c.compilerName] || 'default') === n }, n))))))) :
        h('div', { class: 'muted' }, '尚未配置编译器 · ', h('a', { href: '#/settings/compilers' }, '去设置'))));
  }
  editor.appendChild(h('div', { class: 'section' }, h('div', { class: 'section-title' }, '测试点'),
    h('div', { class: 'row' },
      h('span', null, `${t.testCases.length} 个，共 ${t.totalScore} 分`),
      h('button', { class: 'small primary', disabled, onclick: () => openTestCaseManager(i) }, '测试点管理器'),
      h('button', { class: 'small', disabled, onclick: () => addTestCasesWizard() }, '批量添加'))));
}

function renderTestCaseEditor(editor, i, j) {
  const t = S.contest.tasks[i];
  const tc = JSON.parse(JSON.stringify(t.testCases[j]));
  const status = h('span', { class: 'status-saved' });
  const disabled = S.contest.judging;
  const save = debounce(async () => {
    status.textContent = '保存中…';
    try {
      const cases = S.contest.tasks[i].testCases.map((x, k) => (k === j ? tc : x));
      await saveTask(i, { testCases: cases });
      status.textContent = '已保存';
      const sel = $('.tree-item.child.selected .score');
      if (sel) sel.textContent = tc.fullScore + (tc.inputFiles.length > 1 ? ` · ${tc.inputFiles.length} 组` : '');
    } catch (e) { status.textContent = ''; fail(e); }
  }, 500);
  const num = (k) => h('input', { type: 'number', value: tc[k], disabled, oninput: (e) => { tc[k] = +e.target.value; save(); } });
  const deps = h('input', {
    type: 'text', value: tc.dependenceSubtask.join(', '), disabled: disabled || j === 0, placeholder: j === 0 ? '—' : '如 1, 2',
    oninput: (e) => {
      const list = e.target.value.split(/[\s,，;]+/).filter(Boolean).map(Number);
      if (list.every((x) => Number.isInteger(x) && x >= 1 && x <= j)) { tc.dependenceSubtask = [...new Set(list)]; e.target.style.borderColor = ''; save(); } else e.target.style.borderColor = 'var(--danger)';
    },
  });
  const body = h('tbody');
  const draw = () => {
    body.innerHTML = '';
    tc.inputFiles.forEach((_, k) => body.appendChild(h('tr', null,
      h('td', { class: 'center muted', style: { width: '36px' } }, k + 1),
      h('td', null, h('input', { type: 'text', list: 'datafiles', value: tc.inputFiles[k], disabled, style: { width: '100%' }, oninput: (e) => { tc.inputFiles[k] = e.target.value; save(); } })),
      h('td', null, h('input', { type: 'text', list: 'datafiles', value: tc.outputFiles[k], disabled, style: { width: '100%' }, oninput: (e) => { tc.outputFiles[k] = e.target.value; save(); } })),
      h('td', { style: { width: '40px' } }, h('button', { class: 'small danger', disabled, onclick: () => { tc.inputFiles.splice(k, 1); tc.outputFiles.splice(k, 1); draw(); save(); } }, '✕')))));
  };
  draw();
  editor.appendChild(h('div', { class: 'editor-head' }, h('h2', null, `${t.problemTitle} · #${j + 1}`), status));
  editor.appendChild(h('div', { class: 'form-grid' },
    field('满分', num('fullScore')),
    field('时限 (ms)', num('timeLimit')),
    field('内存 (MiB)', num('memoryLimit')),
    field('依赖', deps, '依赖的测试点未通过时跳过本测试点')));
  editor.appendChild(h('div', { class: 'section' }, h('div', { class: 'section-title' }, '数据（取最低分）'),
    h('table', { class: 'grid boxed' }, h('tr', null, h('th', { class: 'center' }, '#'), h('th', null, '输入文件'), h('th', null, '输出文件'), h('th', null, '')), body),
    h('button', { class: 'small plain', disabled, style: { marginTop: '6px' }, onclick: () => { tc.inputFiles.push(''); tc.outputFiles.push(''); draw(); } }, '＋ 添加一组')));
}

function addTestCasesWizard() {
  // AddTestCasesWizard
  const i = S.sel.task;
  const t = S.contest.tasks[i];
  const base = t.sourceFileName || t.problemTitle;
  const score = h('input', { type: 'number', value: S.settings.defaultFullScore });
  const time = h('input', { type: 'number', value: S.settings.defaultTimeLimit });
  const mem = h('input', { type: 'number', value: S.settings.defaultMemoryLimit });
  const inPat = h('input', { type: 'text', value: `${base}/${base}<1>.${S.settings.defaultInputFileExtension}`, class: 'mono' });
  const outPat = h('input', { type: 'text', value: `${base}/${base}<1>.${S.settings.defaultOutputFileExtension}`, class: 'mono' });
  const newArg = () => ({ re: h('input', { type: 'text', value: '\\d+', class: 'mono', oninput: () => search() }), key: h('input', { type: 'checkbox', checked: true, onchange: () => search() }) });
  const args = [newArg()];
  const argBody = h('tbody');
  const drawArgs = () => {
    argBody.innerHTML = '';
    args.forEach((a, k) => argBody.appendChild(h('tr', null, h('td', { class: 'center mono' }, `<${k + 1}>`), h('td', null, a.re), h('td', { class: 'center' }, a.key),
      h('td', null, args.length > 1 ? h('button', { class: 'small danger', onclick: () => { args.splice(k, 1); drawArgs(); search(); } }, '✕') : null))));
  };
  drawArgs();
  const preview = h('div', { style: { maxHeight: '240px', overflow: 'auto', marginTop: '10px' } });
  let matched = [];
  const escape = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const build = (pattern) => {
    const order = [];
    const re = escape(pattern).replace(/<([1-9])>/g, (m, d) => {
      const k = +d - 1;
      if (!args[k]) throw new Error(`参数 <${d}> 未定义`);
      order.push(k);
      return '(' + args[k].re.value + ')';
    });
    return { re: new RegExp('^' + re + '$'), order };
  };
  function search() {
    preview.innerHTML = '';
    matched = [];
    let inR, outR;
    try { inR = build(inPat.value); outR = build(outPat.value); } catch (e) { preview.appendChild(h('div', { class: 'error-text' }, e.message)); return; }
    const parts = (file, r) => {
      const m = r.re.exec(file);
      if (!m) return null;
      const vals = args.map(() => '');
      r.order.forEach((k, idx) => { vals[k] = m[idx + 1]; });
      return vals;
    };
    const inputs = new Map();
    for (const f of S.dataFiles) { const p = parts(f, inR); if (p) inputs.set(p.join('*'), f); }
    const groups = new Map();
    for (const f of S.dataFiles.slice().sort(lessFileName)) {
      const p = parts(f, outR);
      if (!p || !inputs.has(p.join('*'))) continue;
      const key = args.map((a, k) => (a.key.checked ? p[k] : null)).filter((x) => x !== null).join('*');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ input: inputs.get(p.join('*')), output: f });
    }
    matched = [...groups.keys()].sort(lessFileName).map((k) => groups.get(k));
    if (!matched.length) { preview.appendChild(h('div', { class: 'muted' }, '没有匹配的文件')); return; }
    preview.appendChild(h('table', { class: 'grid boxed' }, h('tr', null, h('th', null, '测试点'), h('th', null, '输入'), h('th', null, '输出')),
      matched.map((g, n) => g.map((s, m) => h('tr', null, m === 0 ? h('td', { rowspan: g.length }, '#' + (t.testCases.length + n + 1)) : null, h('td', { class: 'mono' }, s.input), h('td', { class: 'mono' }, s.output))))));
  }
  inPat.addEventListener('input', debounce(search, 250));
  outPat.addEventListener('input', debounce(search, 250));
  modal({
    title: '批量添加测试点',
    wide: '720px',
    body: h('div', null,
      h('div', { class: 'form-grid', style: { gridTemplateColumns: '100px 1fr' } },
        field('每点满分', score), field('时限 ms', time), field('内存 MiB', mem),
        field('输入文件', inPat, 'data 中的路径，<1> <2> … 为参数'),
        field('输出文件', outPat)),
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, '参数'),
        h('table', { class: 'grid boxed' }, h('tr', null, h('th', null, ''), h('th', null, '正则'), h('th', { class: 'center' }, '区分测试点'), h('th', null, '')), argBody),
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', { class: 'small plain', onclick: () => { if (args.length < 9) { args.push(newArg()); drawArgs(); } } }, '＋ 参数'),
          h('span', { class: 'hint' }, '不区分的参数会把文件合并到同一测试点'))),
      h('div', { class: 'section-title' }, '预览'), preview),
    buttons: [{ label: '取消' }, {
      label: '添加', primary: true, onClick: async () => {
        search();
        if (!matched.length) return false;
        const cases = matched.map((g) => ({ fullScore: +score.value, timeLimit: +time.value, memoryLimit: +mem.value, inputFiles: g.map((s) => s.input), outputFiles: g.map((s) => s.output), dependenceSubtask: [] }));
        await saveTask(i, { testCases: [...S.contest.tasks[i].testCases, ...cases] });
        toast(`已添加 ${cases.length} 个测试点`);
        S.sel.expanded.add(i);
        rerenderTasks();
      },
    }],
  });
  search();
}

// ---------------------------------------- test case manager (ExtTestCaseModifier) ----------
function openTestCaseManager(taskIndex) {
  const task = S.contest.tasks[taskIndex];
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let cases = clone(task.testCases);
  const original = JSON.stringify(cases);
  const undo = [], redo = [];
  let sel = { subs: new Set(), cases: new Set() };   // cases: "i:k"
  let anchor = null;
  const dataSet = new Set(S.dataFiles);
  const D = S.settings;

  const snapshot = () => { undo.push(JSON.stringify(cases)); if (undo.length > 200) undo.shift(); redo.length = 0; };
  const commit = (fn) => { snapshot(); fn(); draw(); };
  const doUndo = () => { if (!undo.length) return; redo.push(JSON.stringify(cases)); cases = JSON.parse(undo.pop()); sel = { subs: new Set(), cases: new Set() }; draw(); };
  const doRedo = () => { if (!redo.length) return; undo.push(JSON.stringify(cases)); cases = JSON.parse(redo.pop()); sel = { subs: new Set(), cases: new Set() }; draw(); };

  // Rebuild the list keeping dependencies consistent. items: [{tc, from:[old indices]}]
  const rebuild = (items) => {
    const where = new Map();
    items.forEach((it, j) => it.from.forEach((o) => { if (!where.has(o)) where.set(o, []); where.get(o).push(j); }));
    return items.map((it, j) => {
      const tc = clone(it.tc);
      if (it.from.length) {
        const deps = new Set();
        for (const o of it.from) for (const d of cases[o].dependenceSubtask) for (const m of (where.get(d - 1) || [])) if (m < j) deps.add(m + 1);
        tc.dependenceSubtask = [...deps].sort((a, b) => a - b);
      }
      return tc;
    });
  };
  const keep = () => cases.map((tc, i) => ({ tc, from: [i] }));
  const selectedSubs = () => [...sel.subs].sort((a, b) => a - b);
  const newCase = () => ({ fullScore: D.defaultFullScore, timeLimit: D.defaultTimeLimit, memoryLimit: D.defaultMemoryLimit, inputFiles: [], outputFiles: [], dependenceSubtask: [] });

  // ---------- operations ----------
  const moveSubs = (dir) => {
    const s = selectedSubs();
    if (!s.length) return moveCases(dir);
    if (dir < 0 ? s[0] === 0 : s[s.length - 1] === cases.length - 1) return;
    commit(() => {
      const items = keep();
      const order = dir < 0 ? s : s.slice().reverse();
      for (const i of order) [items[i], items[i + dir]] = [items[i + dir], items[i]];
      cases = rebuild(items);
      sel.subs = new Set(s.map((i) => i + dir));
    });
  };
  const moveCases = (dir) => {
    const list = [...sel.cases].map((x) => x.split(':').map(Number));
    if (!list.length) return;
    const sub = list[0][0];
    if (list.some(([i]) => i !== sub)) return toast('只能在同一个测试点内移动数据', 'error');
    const ks = list.map(([, k]) => k).sort((a, b) => a - b);
    const tc = cases[sub];
    if (dir < 0 ? ks[0] === 0 : ks[ks.length - 1] === tc.inputFiles.length - 1) return;
    commit(() => {
      for (const k of dir < 0 ? ks : ks.slice().reverse()) {
        for (const key of ['inputFiles', 'outputFiles']) [tc[key][k], tc[key][k + dir]] = [tc[key][k + dir], tc[key][k]];
      }
      sel.cases = new Set(ks.map((k) => `${sub}:${k + dir}`));
    });
  };
  const removeSel = () => {
    if (!sel.subs.size && !sel.cases.size) return;
    commit(() => {
      const byCase = new Map();
      for (const x of sel.cases) { const [i, k] = x.split(':').map(Number); if (!byCase.has(i)) byCase.set(i, new Set()); byCase.get(i).add(k); }
      const items = keep().filter((_, i) => !sel.subs.has(i)).map((it) => {
        const drop = byCase.get(it.from[0]);
        if (!drop) return it;
        const tc = clone(it.tc);
        tc.inputFiles = tc.inputFiles.filter((_, k) => !drop.has(k));
        tc.outputFiles = tc.outputFiles.filter((_, k) => !drop.has(k));
        return { tc, from: it.from };
      });
      cases = rebuild(items);
      sel = { subs: new Set(), cases: new Set() };
    });
  };
  const merge = () => {
    const s = selectedSubs();
    if (s.length < 2) return toast('请选择至少两个测试点', 'error');
    commit(() => {
      const first = s[0];
      const merged = clone(cases[first]);
      for (const i of s.slice(1)) {
        merged.fullScore += cases[i].fullScore;
        merged.inputFiles.push(...cases[i].inputFiles);
        merged.outputFiles.push(...cases[i].outputFiles);
      }
      const items = [];
      cases.forEach((tc, i) => {
        if (i === first) items.push({ tc: merged, from: s });
        else if (!sel.subs.has(i)) items.push({ tc, from: [i] });
      });
      cases = rebuild(items);
      sel = { subs: new Set([first]), cases: new Set() };
    });
  };
  const split = () => {
    const s = selectedSubs().filter((i) => cases[i].inputFiles.length > 1);
    if (!s.length) return toast('请选择包含多组数据的测试点', 'error');
    commit(() => {
      const items = [];
      const newSel = new Set();
      cases.forEach((tc, i) => {
        if (!s.includes(i)) { items.push({ tc, from: [i] }); return; }
        const n = tc.inputFiles.length;
        const base = n - (tc.fullScore % n);   // first `base` pieces get floor, the rest ceil (as in LemonLime)
        tc.inputFiles.forEach((f, k) => {
          newSel.add(items.length);
          items.push({ tc: { ...tc, fullScore: Math.floor(tc.fullScore / n) + (k >= base ? 1 : 0), inputFiles: [f], outputFiles: [tc.outputFiles[k]] }, from: [i] });
        });
      });
      cases = rebuild(items);
      sel = { subs: newSel, cases: new Set() };
    });
  };
  const addSub = () => commit(() => {
    const s = selectedSubs();
    const at = s.length ? s[s.length - 1] + 1 : cases.length;
    const items = keep();
    const tc = s.length ? { ...clone(cases[s[s.length - 1]]), inputFiles: [''], outputFiles: [''], dependenceSubtask: [] } : { ...newCase(), inputFiles: [''], outputFiles: [''] };
    items.splice(at, 0, { tc, from: [] });
    cases = rebuild(items);
    sel = { subs: new Set([at]), cases: new Set() };
  });
  const addCase = () => {
    const s = selectedSubs();
    const target = s.length ? s[s.length - 1] : [...sel.cases].length ? +[...sel.cases][0].split(':')[0] : -1;
    if (target < 0) return toast('请先选择一个测试点', 'error');
    commit(() => {
      cases[target].inputFiles.push('');
      cases[target].outputFiles.push('');
      sel = { subs: new Set(), cases: new Set([`${target}:${cases[target].inputFiles.length - 1}`]) };
    });
  };
  const moveCasesTo = (target) => {
    const list = [...sel.cases].map((x) => x.split(':').map(Number));
    if (!list.length) return;
    commit(() => {
      const moved = [];
      const drop = new Map();
      for (const [i, k] of list) { moved.push([cases[i].inputFiles[k], cases[i].outputFiles[k]]); if (!drop.has(i)) drop.set(i, new Set()); drop.get(i).add(k); }
      for (const [i, ks] of drop) {
        cases[i].inputFiles = cases[i].inputFiles.filter((_, k) => !ks.has(k));
        cases[i].outputFiles = cases[i].outputFiles.filter((_, k) => !ks.has(k));
      }
      const start = cases[target].inputFiles.length;
      for (const [a, b] of moved) { cases[target].inputFiles.push(a); cases[target].outputFiles.push(b); }
      sel = { subs: new Set(), cases: new Set(moved.map((_, n) => `${target}:${start + n}`)) };
    });
  };
  const moveSubsBefore = (target) => {
    const s = selectedSubs();
    if (!s.length || s.includes(target)) return;
    commit(() => {
      const items = keep();
      const moving = s.map((i) => items[i]);
      const rest = items.filter((_, i) => !sel.subs.has(i));
      let at = target === cases.length ? rest.length : rest.indexOf(items[target]);
      rest.splice(at, 0, ...moving);
      cases = rebuild(rest);
      sel.subs = new Set(moving.map((m) => rest.indexOf(m)));
    });
  };
  const batch = () => {
    const targets = sel.subs.size ? selectedSubs() : cases.map((_, i) => i);
    if (!targets.length) return;
    const mk = (label, value) => {
      const c = h('input', { type: 'checkbox' });
      const v = h('input', { type: 'number', value, oninput: () => { c.checked = true; } });
      return { c, v, row: field(label, h('div', { class: 'row' }, c, v)) };
    };
    const t0 = cases[targets[0]];
    const sc = mk('分值', t0.fullScore), tl = mk('时限 ms', t0.timeLimit), ml = mk('内存 MiB', t0.memoryLimit), tot = mk('总分平均分配', '');
    modal({
      title: sel.subs.size ? `修改选中的 ${targets.length} 个测试点` : `修改全部 ${targets.length} 个测试点`,
      body: h('div', { class: 'form-grid', style: { gridTemplateColumns: '110px 1fr' } }, sc.row, tl.row, ml.row, tot.row),
      buttons: [{ label: '取消' }, {
        label: '应用', primary: true, onClick: () => commit(() => {
          const total = +tot.v.value, n = targets.length, per = Math.floor(total / n);
          targets.forEach((i, j) => {
            if (sc.c.checked) cases[i].fullScore = +sc.v.value;
            if (tl.c.checked) cases[i].timeLimit = +tl.v.value;
            if (ml.c.checked) cases[i].memoryLimit = +ml.v.value;
            if (tot.c.checked) cases[i].fullScore = per + (j < total - per * n ? 1 : 0);
          });
        }),
      }],
    });
  };

  // Clicking a cell (not its input) only changes the row selection: with Shift/Ctrl the browser would
  // otherwise extend a text selection over the inputs in between.
  const noTextSelect = (e) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
    if (document.activeElement && document.activeElement.tagName === 'INPUT' && tbody.contains(document.activeElement)) document.activeElement.blur();
    const s = window.getSelection();
    if (s && s.rangeCount) s.removeAllRanges();
  };

  // ---------- selection ----------
  const flatCases = () => cases.flatMap((tc, i) => tc.inputFiles.map((_, k) => `${i}:${k}`));
  const clickSub = (i, e) => {
    sel.cases = new Set();
    if (e.shiftKey && anchor && anchor.type === 'sub') {
      const [a, b] = [Math.min(anchor.i, i), Math.max(anchor.i, i)];
      if (!(e.ctrlKey || e.metaKey)) sel.subs = new Set();
      for (let x = a; x <= b; x++) sel.subs.add(x);
    } else if (e.ctrlKey || e.metaKey) {
      if (sel.subs.has(i)) sel.subs.delete(i); else sel.subs.add(i);
      anchor = { type: 'sub', i };
    } else { sel.subs = new Set([i]); anchor = { type: 'sub', i }; }
    paint();
  };
  const clickCase = (key, e) => {
    sel.subs = new Set();
    const flat = flatCases();
    if (e.shiftKey && anchor && anchor.type === 'case') {
      const [a, b] = [flat.indexOf(anchor.key), flat.indexOf(key)].sort((x, y) => x - y);
      if (!(e.ctrlKey || e.metaKey)) sel.cases = new Set();
      for (let x = a; x <= b; x++) sel.cases.add(flat[x]);
    } else if (e.ctrlKey || e.metaKey) {
      if (sel.cases.has(key)) sel.cases.delete(key); else sel.cases.add(key);
      anchor = { type: 'case', key };
    } else { sel.cases = new Set([key]); anchor = { type: 'case', key }; }
    paint();
  };

  // ---------- rendering ----------
  const tbody = h('tbody');
  const info = h('span', { class: 'tcm-foot-info' });
  const btn = {};
  const mkBtn = (key, label, fn, title) => (btn[key] = h('button', { class: 'small', onclick: fn, title }, label));
  const toolbar = h('div', { class: 'tcm-toolbar' },
    mkBtn('addSub', '＋ 测试点', addSub), mkBtn('addCase', '＋ 数据', addCase, '向选中的测试点添加一组数据'),
    h('div', { class: 'sep' }),
    mkBtn('up', '上移', () => moveSubs(-1), 'Alt+↑'), mkBtn('down', '下移', () => moveSubs(1), 'Alt+↓'),
    mkBtn('merge', '合并', merge, '把选中的测试点合并为一个（捆绑）'), mkBtn('split', '拆分', split, '把测试点中的每组数据拆成单独的测试点'),
    mkBtn('batch', '批量修改', batch), mkBtn('moveTo', '移到测试点…', (e) => menuBelow(e.currentTarget, cases.map((tc, i) => ({ label: `#${i + 1}`, count: `${tc.inputFiles.length} 组`, onClick: () => moveCasesTo(i) })))),
    h('div', { class: 'sep' }),
    h('button', { class: 'small danger', onclick: removeSel, title: 'Delete' }, '删除'),
    h('div', { class: 'right row' }, mkBtn('undo', '↶ 撤销', doUndo, 'Ctrl+Z'), mkBtn('redo', '↷ 重做', doRedo, 'Ctrl+Y')));

  const numInput = (i, key, cls = 'num') => h('input', {
    type: 'number', class: cls, value: cases[i][key],
    onfocus: snapshotOnce, oninput: (e) => { cases[i][key] = +e.target.value; updateInfo(); },
  });
  let focusSnap = false;
  function snapshotOnce() { if (!focusSnap) { snapshot(); focusSnap = true; setTimeout(() => { focusSnap = false; }, 1500); } }
  const pathInput = (i, k, key) => {
    const inp = h('input', {
      type: 'text', class: 'path mono' + (cases[i][key][k] && !dataSet.has(cases[i][key][k]) ? ' missing' : ''), value: cases[i][key][k], list: 'datafiles',
      title: cases[i][key][k] && !dataSet.has(cases[i][key][k]) ? 'data 中没有这个文件' : '',
      onfocus: snapshotOnce,
      oninput: (e) => { cases[i][key][k] = e.target.value; e.target.classList.toggle('missing', !!e.target.value && !dataSet.has(e.target.value)); updateInfo(); },
    });
    return inp;
  };
  const depInput = (i) => h('input', {
    type: 'text', class: 'num', value: cases[i].dependenceSubtask.join(','), placeholder: i ? '—' : '', disabled: i === 0, title: '依赖的测试点编号',
    onfocus: snapshotOnce,
    oninput: (e) => {
      const list = e.target.value.split(/[\s,，;]+/).filter(Boolean).map(Number);
      const ok = list.every((x) => Number.isInteger(x) && x >= 1 && x <= i);
      e.target.classList.toggle('missing', !ok);
      if (ok) cases[i].dependenceSubtask = [...new Set(list)].sort((a, b) => a - b);
    },
  });

  let dragInfo = null;
  function draw() {
    tbody.innerHTML = '';
    cases.forEach((tc, i) => {
      const n = Math.max(1, tc.inputFiles.length);
      const subCell = (content, extra = {}) => {
        const td = h('td', { class: 'sub', rowspan: n, 'data-sub': i, ...extra }, content);
        td.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'INPUT') { noTextSelect(e); clickSub(i, e); } });
        return td;
      };
      for (let k = 0; k < n; k++) {
        const row = h('tr', { class: 'case' + (k === 0 ? ' group-start' : '') });
        if (k === 0) {
          const handle = subCell(h('div', { class: 'tcm-subhead' }, h('span', { class: 'idx' }, '#' + (i + 1)), h('span', { class: 'muted small-text' }, tc.inputFiles.length + ' 组')), { draggable: 'true', title: '拖动以调整顺序' });
          handle.addEventListener('dragstart', (e) => { if (!sel.subs.has(i)) clickSub(i, {}); dragInfo = { type: 'sub' }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'sub'); });
          row.append(handle, subCell(numInput(i, 'fullScore')), subCell(numInput(i, 'timeLimit')), subCell(numInput(i, 'memoryLimit')), subCell(depInput(i)));
          row.dataset.subStart = i;
        }
        const key = `${i}:${k}`;
        if (tc.inputFiles.length) {
          const idx = h('td', { class: 'c center muted', draggable: 'true' }, k + 1);
          idx.addEventListener('dragstart', (e) => { if (!sel.cases.has(key)) clickCase(key, {}); dragInfo = { type: 'case' }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'case'); });
          const c1 = h('td', { class: 'c' }, pathInput(i, k, 'inputFiles'));
          const c2 = h('td', { class: 'c' }, pathInput(i, k, 'outputFiles'));
          for (const td of [idx, c1, c2]) td.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'INPUT') { noTextSelect(e); clickCase(key, e); } });
          row.append(idx, c1, c2);
          row.dataset.case = key;
        } else row.append(h('td', { colspan: 3, class: 'muted small-text c' }, '（没有数据）'));
        row.addEventListener('dragover', (e) => { if (!dragInfo) return; e.preventDefault(); tbody.querySelectorAll('.tcm-drop-before').forEach((x) => x.classList.remove('tcm-drop-before')); const start = tbody.querySelector(`tr[data-sub-start="${i}"]`); if (start) start.classList.add('tcm-drop-before'); });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          tbody.querySelectorAll('.tcm-drop-before').forEach((x) => x.classList.remove('tcm-drop-before'));
          if (!dragInfo) return;
          if (dragInfo.type === 'sub') moveSubsBefore(i); else moveCasesTo(i);
          dragInfo = null;
        });
        tbody.appendChild(row);
      }
    });
    // drop zone at the end
    const end = h('tr', null, h('td', { colspan: 8, class: 'muted small-text center', style: { padding: '8px' } }, cases.length ? '拖到这里移到末尾' : '暂无测试点'));
    end.addEventListener('dragover', (e) => { if (dragInfo && dragInfo.type === 'sub') e.preventDefault(); });
    end.addEventListener('drop', (e) => { e.preventDefault(); if (dragInfo && dragInfo.type === 'sub') moveSubsBefore(cases.length); dragInfo = null; });
    tbody.appendChild(end);
    paint();
  }
  function paint() {
    tbody.querySelectorAll('td.sub').forEach((td) => td.classList.toggle('selected', sel.subs.has(+td.dataset.sub)));
    tbody.querySelectorAll('tr.case').forEach((tr) => tr.classList.toggle('selected', !!tr.dataset.case && sel.cases.has(tr.dataset.case)));
    const s = selectedSubs();
    btn.up.disabled = !(s.length ? s[0] > 0 : sel.cases.size);
    btn.down.disabled = !(s.length ? s[s.length - 1] < cases.length - 1 : sel.cases.size);
    btn.merge.disabled = s.length < 2;
    btn.split.disabled = !s.some((i) => cases[i].inputFiles.length > 1);
    btn.addCase.disabled = !s.length && !sel.cases.size;
    btn.moveTo.disabled = !sel.cases.size;
    btn.undo.disabled = !undo.length;
    btn.redo.disabled = !redo.length;
    btn.batch.textContent = s.length ? `批量修改（${s.length}）` : '批量修改（全部）';
    updateInfo();
  }
  function updateInfo() {
    const total = cases.reduce((a, tc) => a + (+tc.fullScore || 0), 0);
    const files = cases.reduce((a, tc) => a + tc.inputFiles.length, 0);
    const missing = cases.reduce((a, tc) => a + [...tc.inputFiles, ...tc.outputFiles].filter((f) => f && !dataSet.has(f)).length, 0);
    const empty = cases.reduce((a, tc) => a + [...tc.inputFiles, ...tc.outputFiles].filter((f) => !f).length, 0);
    info.textContent = `${cases.length} 个测试点 · ${files} 组数据 · 总分 ${total}` + (missing ? ` · ${missing} 个文件不存在` : '') + (empty ? ` · ${empty} 个路径为空` : '') + (JSON.stringify(cases) !== original ? ' · 未保存' : '');
  }

  const table = h('table', { class: 'tcm-table' },
    h('thead', null, h('tr', null, h('th', { style: { width: '74px' } }, '测试点'), h('th', null, '分值'), h('th', null, '时限 ms'), h('th', null, '内存 MiB'), h('th', null, '依赖'), h('th', { style: { width: '34px' } }, '#'), h('th', null, '输入文件'), h('th', null, '输出文件'))),
    tbody);
  const wrap = h('div', { class: 'tcm-wrap' }, table);
  const save = async () => {
    const empty = cases.some((tc) => tc.inputFiles.some((f, k) => !f || !tc.outputFiles[k]));
    if (empty && !await confirmDlg('有数据路径为空，仍要保存吗？', '保存', false)) return false;
    try {
      await saveTask(taskIndex, { testCases: cases });
      toast('测试点已保存');
      rerenderTasks();
      return true;
    } catch (e) { fail(e); return false; }
  };
  const keyHandler = (e) => {
    if (dlg && $('#modal-root').lastElementChild !== dlg.el.parentNode) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); save().then((ok) => ok && dlg.close(true)); return; }
    if (typing(e)) return;
    if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSel(); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveSubs(e.key === 'ArrowUp' ? -1 : 1); }
    else if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); sel = { subs: new Set(cases.map((_, i) => i)), cases: new Set() }; paint(); }
  };
  const dlg = modal({
    title: `测试点管理 · ${task.problemTitle}`,
    body: h('div', { class: 'tcm' }, toolbar, wrap,
      h('div', { class: 'row', style: { marginTop: '8px' } }, info, h('span', { class: 'right muted small-text' }, '单击选择 · Ctrl/Shift 多选 · 拖动 # 调整顺序 · Ctrl+Z 撤销 · Ctrl+S 保存'))),
    buttons: [{ label: '取消' }, { label: '保存', primary: true, onClick: save }],
    beforeClose: async () => JSON.stringify(cases) === original || confirmDlg('放弃对测试点的修改？', '放弃'),
    onClose: () => document.removeEventListener('keydown', keyHandler, true),
  });
  document.addEventListener('keydown', keyHandler, true);
  draw();
}

// ---------------------------------------- results tab (ResultViewer) ------------------------
function computeRanks(contestants) {
  const sorted = contestants.filter((c) => c.totalScore !== -1).map((c) => [-c.totalScore, c.name]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  const rank = {};
  sorted.forEach((x, i) => { rank[x[1]] = i > 0 && x[0] === sorted[i - 1][0] ? rank[sorted[i - 1][1]] : i; });
  return rank;
}

function renderResultsTab(page) {
  const c = S.contest;
  const judging = c.judging;
  const exportMenu = h('select', {
    onchange: async (e) => {
      const v = e.target.value;
      e.target.value = '';
      if (!v) return;
      if (v === 'save') {
        try { const r = await api('GET', cpath() + '/export' + qs({ format: 'html', save: 1 })); toast('已保存到 ' + r.file); } catch (err) { fail(err); }
      } else if (v === 'view') {
        const w = window.open('', '_blank');
        try { const html = await api('GET', cpath() + '/export' + qs({ format: 'html', inline: 1 })); w.document.write(html); w.document.close(); } catch (err) { w.close(); fail(err); }
      } else download(cpath() + '/export' + qs({ format: v }), 'result.' + v);
    },
  }, h('option', { value: '' }, '导出…'), h('option', { value: 'html' }, 'result.html'), h('option', { value: 'view' }, '在新窗口查看'),
  h('option', { value: 'htm' }, 'result.htm（精简）'), h('option', { value: 'csv' }, 'CSV'), h('option', { value: 'save' }, '保存到比赛文件夹'));

  const selectedList = () => {
    const map = new Map();
    for (const k of S.resultSel) {
      const [name, t] = k.split('|');
      if (!map.has(name)) map.set(name, new Set());
      if (t === '*') c.tasks.forEach((_, i) => map.get(name).add(i)); else map.get(name).add(+t);
    }
    return [...map.entries()].map(([contestant, set]) => ({ contestant, tasks: [...set] }));
  };

  const selBtn = h('button', { class: 'primary', disabled: judging || !S.resultSel.size, onclick: () => startJudge('selected', selectedList()) }, '评测选中');
  const delBtn = h('button', { class: 'danger', disabled: judging || !S.resultSel.size, onclick: () => deleteContestants(selectedList().map((x) => x.contestant)) }, '删除选中');
  if (c.running) return renderRunningResults(page, selBtn, delBtn);
  page.appendChild(h('div', { class: 'toolbar' },
    h('button', { onclick: refreshContestants, disabled: judging }, '刷新选手'),
    h('div', { class: 'sep' }),
    selBtn,
    h('button', { disabled: judging || !c.contestants.length, onclick: () => startJudge('all') }, '全部'),
    h('button', { disabled: judging, onclick: () => startJudge('unjudged') }, '未评测'),
    h('button', { disabled: judging || !c.contestants.length, onclick: (e) => rejudgeByStateMenu(e.currentTarget) }, '按状态重测 ▾'),
    h('div', { class: 'sep' }),
    delBtn,
    h('button', { disabled: judging, onclick: cleanupFiles }, '整理文件'),
    h('div', { class: 'right' }, exportMenu)));

  if (!c.contestants.length) {
    page.appendChild(h('div', { class: 'empty' }, '暂无选手。把程序放到 ', h('code', null, 'source/<选手>/'), ' 后点“刷新选手”。'));
    return;
  }

  const rank = computeRanks(c.contestants);
  const list = c.contestants.slice().sort((a, b) => ((rank[a.name] ?? 1e9) - (rank[b.name] ?? 1e9)) || (a.name < b.name ? -1 : 1));
  const nf = hslOf(theme().nf), ce = hslOf(theme().ce);
  const toggle = (key, el) => {
    if (S.resultSel.has(key)) { S.resultSel.delete(key); el.classList.remove('selected'); } else { S.resultSel.add(key); el.classList.add('selected'); }
    selBtn.disabled = delBtn.disabled = judging || !S.resultSel.size;
  };
  const table = h('table', { class: 'grid results' },
    h('tr', null, h('th', null, '排名'), h('th', null, '选手'), h('th', null, '总分'),
      c.tasks.map((t) => h('th', null, t.problemTitle, h('span', { class: 'muted', style: { fontWeight: 400, marginLeft: '4px' } }, t.totalScore))),
      h('th', null, '用时 (s)'), h('th', null, '评测时间')),
    list.map((ct) => {
      const nameKey = ct.name + '|*';
      const nameCell = h('td', { class: 'name' + (S.resultSel.has(nameKey) ? ' selected' : ''), title: '双击查看详情' }, ct.name);
      nameCell.addEventListener('click', () => toggle(nameKey, nameCell));
      nameCell.addEventListener('dblclick', () => showDetail(ct.name));
      return h('tr', null,
        h('td', null, rank[ct.name] !== undefined ? rank[ct.name] + 1 : '—'),
        nameCell,
        h('td', { class: 'total', style: { background: ct.totalScore >= 0 ? colorGrand(ct.totalScore, c.totalScore) : '' } }, ct.totalScore >= 0 ? ct.totalScore : '—'),
        ct.tasks.map((r, j) => {
          const key = ct.name + '|' + j;
          let bg = '';
          if (r.score !== -1) {
            if (c.tasks[j].taskType !== 1 && r.compileState !== 0) bg = r.compileState === 1 ? nf : ce;
            else bg = colorPer(r.score, c.tasks[j].totalScore);
          }
          const td = h('td', {
            class: 'cell' + (S.resultSel.has(key) ? ' selected' : ''), style: { background: bg },
            title: r.score === -1 ? '未评测' : (c.tasks[j].taskType !== 1 && r.compileState !== 0 ? COMPILE_STATE[r.compileState] : (r.sourceFile || '')),
          }, r.score !== -1 ? r.score : '—', r.score !== -1 && c.tasks[j].taskType !== 1 && r.compileState !== 0 ? h('span', { class: 'small-text', style: { opacity: 0.75, marginLeft: '5px' } }, COMPILE_ABBR[r.compileState]) : null);
          td.addEventListener('click', () => toggle(key, td));
          td.addEventListener('dblclick', () => showDetail(ct.name, j));
          return td;
        }),
        h('td', { class: 'muted' }, ct.totalScore >= 0 ? (ct.totalUsedTime / 1000).toFixed(3) : '—'),
        h('td', { class: 'muted' }, ct.totalScore >= 0 ? ct.judgingTime : '—'));
    }));
  page.appendChild(h('div', { class: 'results-wrap' }, table,
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: { background: nf } }), 'NS 未找到源程序'),
      h('span', null, h('i', { style: { background: ce } }), 'CE 等编译失败'),
      h('span', { class: 'right' }, '单击选择 · 双击查看详情'))));
}

// During the contest time the server hides scores and source code: show the submissions (code size)
// and whether each one has been judged.
function renderRunningResults(page, selBtn, delBtn) {
  const c = S.contest;
  const judging = c.judging;
  page.appendChild(h('div', { class: 'toolbar' },
    h('button', { onclick: refreshContestants, disabled: judging }, '刷新选手'),
    h('div', { class: 'sep' }),
    selBtn,
    h('button', { disabled: judging || !c.contestants.length, onclick: () => startJudge('all') }, '全部'),
    h('button', { disabled: judging, onclick: () => startJudge('unjudged') }, '未评测'),
    h('div', { class: 'sep' }),
    delBtn,
    h('button', { disabled: judging, onclick: cleanupFiles }, '整理文件'),
    h('div', { class: 'right muted small-text' }, `比赛中，${fmtDate(c.endTime)} 后显示成绩`)));
  if (!c.contestants.length) {
    page.appendChild(h('div', { class: 'empty' }, '暂无选手。把程序放到 ', h('code', null, 'source/<选手>/'), ' 后点“刷新选手”。'));
    return;
  }
  const toggle = (key, el) => {
    if (S.resultSel.has(key)) { S.resultSel.delete(key); el.classList.remove('selected'); } else { S.resultSel.add(key); el.classList.add('selected'); }
    selBtn.disabled = delBtn.disabled = judging || !S.resultSel.size;
  };
  const list = c.contestants.slice().sort((a, b) => lessFileName(a.name, b.name));
  let submitted = 0, judged = 0;
  const table = h('table', { class: 'grid results running' },
    h('tr', null, h('th', null, '选手'), c.tasks.map((t) => h('th', null, t.problemTitle)), h('th', null, '已提交'), h('th', null, '已评测')),
    list.map((ct) => {
      const nameKey = ct.name + '|*';
      const nameCell = h('td', { class: 'name' + (S.resultSel.has(nameKey) ? ' selected' : '') }, ct.name);
      nameCell.addEventListener('click', () => toggle(nameKey, nameCell));
      const sub = ct.tasks.filter((r) => r.submitted).length, jud = ct.tasks.filter((r) => r.judged).length;
      submitted += sub; judged += jud;
      return h('tr', null, nameCell,
        ct.tasks.map((r, j) => {
          const key = ct.name + '|' + j;
          const td = h('td', { class: 'cell' + (S.resultSel.has(key) ? ' selected' : ''), title: r.sourceFile || '' },
            r.submitted ? formatSize(r.codeSize) : h('span', { class: 'muted' }, '未提交'),
            h('span', { class: 'judge-mark ' + (r.judged ? 'done' : '') }, r.judged ? '已评测' : '未评测'));
          td.addEventListener('click', () => toggle(key, td));
          return td;
        }),
        h('td', { class: 'muted' }, `${sub} / ${c.tasks.length}`),
        h('td', { class: 'muted' }, `${jud} / ${c.tasks.length}`));
    }));
  const cells = list.length * c.tasks.length;
  page.appendChild(h('div', { class: 'results-wrap' }, table,
    h('div', { class: 'legend' },
      h('span', null, `${list.length} 名选手 · 提交 ${submitted} / ${cells} · 已评测 ${judged} / ${cells}`),
      h('span', { class: 'right' }, '格子中为代码长度 · 单击选择'))));
}

async function rejudgeByStateMenu(anchor) {
  let sum;
  try { sum = await api('GET', cpath() + '/state-summary'); } catch (e) { return fail(e); }
  const item = (abbr, text, count, payload) => ({
    label: h('span', null, h('b', { style: { display: 'inline-block', minWidth: '44px' } }, abbr), text),
    count: count || 0, disabled: !count, onClick: () => startJudge('state', undefined, payload),
  });
  menuBelow(anchor, [
    { head: '编译' },
    ...REJUDGE_COMPILE.map((s) => item(COMPILE_ABBR[s], COMPILE_STATE[s], sum.compile[s], { compileStates: [s] })),
    'sep',
    { head: '测试点结果（含有该结果的格子）' },
    ...REJUDGE_RESULT.map((s) => item(RESULT_ABBR[s], RESULT[s][0], sum.result[s], { resultStates: [s] })),
  ]);
}

async function refreshContestants() {
  try { S.contest = await api('POST', cpath() + '/refresh'); route(); toast(`${S.contest.contestants.length} 名选手`); } catch (e) { fail(e); }
}

async function deleteContestants(names) {
  const box = h('input', { type: 'checkbox' });
  let ok = false;
  await new Promise((resolve) => modal({
    title: `删除 ${names.length} 名选手`,
    body: h('div', null, h('p', { class: 'muted', style: { marginTop: 0 } }, names.join('、')), h('label', { class: 'inline' }, box, '同时删除选手文件夹')),
    buttons: [{ label: '取消' }, { label: '删除', danger: true, onClick: () => { ok = true; } }],
    onClose: resolve,
  }));
  if (!ok) return;
  try {
    for (const n of names) await api('DELETE', cpath() + '/contestants/' + enc(n) + qs({ deleteFiles: box.checked ? 1 : 0 }));
    S.resultSel.clear();
    route();
  } catch (e) { fail(e); }
}

async function cleanupFiles() {
  const backup = h('input', { type: 'checkbox', checked: true });
  let ok = false;
  await new Promise((resolve) => modal({
    title: '整理选手文件',
    body: h('div', { style: { maxWidth: '420px', lineHeight: 1.6 } },
      h('p', { style: { marginTop: 0 } }, '删除可执行文件，并把源程序按试题归入子文件夹。'),
      h('label', { class: 'inline' }, backup, '先备份 source')),
    buttons: [{ label: '取消' }, { label: '整理', primary: true, onClick: () => { ok = true; } }],
    onClose: resolve,
  }));
  if (!ok) return;
  try {
    const r = await api('POST', cpath() + '/cleanup', { backup: backup.checked });
    toast(`已整理 ${r.contestants} 名选手` + (r.backupFolder ? `，备份于 ${r.backupFolder}` : ''));
  } catch (e) { fail(e); }
}

async function showDetail(name, focusTask) {
  // DetailDialog
  let d;
  try { d = await api('GET', cpath() + '/contestants/' + enc(name)); } catch (e) { return fail(e); }
  const c = S.contest;
  const body = h('div', { style: { minWidth: '700px' } });
  c.tasks.forEach((t, i) => {
    const det = d.details[i];
    const sec = h('div', { class: 'detail-task', id: 'detail-task-' + i });
    sec.appendChild(h('div', { class: 'row', style: { marginBottom: '8px' } }, h('h3', null, t.problemTitle),
      h('span', { class: 'muted' }, det.judged ? `${det.taskScore} / ${t.totalScore}` : '未评测'),
      det.sourceFile ? h('span', { class: 'muted small-text' }, det.sourceFile) : null,
      h('div', { class: 'right row' },
        t.taskType !== 1 ? h('button', { class: 'small', onclick: () => showSource(name, i) }, '源程序') : null,
        h('button', { class: 'small', disabled: c.judging, onclick: () => { dlg.close(true); startJudge('selected', [{ contestant: name, tasks: [i] }]); } }, '重测'))));
    body.appendChild(sec);
    if (!det.judged) return;
    if (t.taskType !== 1 && det.compileState !== 0) {
      sec.appendChild(h('div', { class: 'error-text' }, COMPILE_STATE[det.compileState]));
      if (det.compileMessage) sec.appendChild(h('pre', { class: 'compile-msg' }, det.compileMessage));
      return;
    }
    const table = h('table', { class: 'grid boxed' },
      h('tr', null, h('th', { class: 'center' }, '#'), h('th', null, '输入'), h('th', null, '结果'), h('th', null, '用时'), h('th', null, '内存'), h('th', { class: 'center' }, '得分')));
    det.inputFiles.forEach((files, j) => {
      const scores = det.score[j] || [];
      const tc = t.testCases[j];
      const minv = Math.min(...scores.slice(0, files.length));
      const dep = scores.length !== files.length && scores.length ? scores[scores.length - 1] : null;
      files.forEach((f, k) => {
        const msg = (det.message[j] || [])[k];
        table.appendChild(h('tr', null,
          k === 0 ? h('td', { rowspan: files.length, class: 'center' }, j + 1, dep !== null ? h('div', { class: 'muted small-text' }, dep >= 1000000 ? 'Pure' : dep < 0 ? 'Lost' : (dep / 10000).toFixed(1) + '%') : null) : null,
          h('td', { class: 'mono' }, f),
          h('td', null, resultTag(det.result[j][k]), msg ? h('div', { class: 'muted small-text', style: { whiteSpace: 'pre-wrap', maxWidth: '340px', marginTop: '3px' } }, msg) : null),
          h('td', null, fmtTime(det.timeUsed[j][k])),
          h('td', null, fmtMem(det.memoryUsed[j][k])),
          k === 0 ? h('td', { rowspan: files.length, class: 'center' }, h('b', null, isFinite(minv) ? minv : 0), h('span', { class: 'muted' }, ' / ' + (tc ? tc.fullScore : '?'))) : null));
      });
    });
    sec.appendChild(table);
  });
  const dlg = modal({ title: `${name} · ${d.totalScore >= 0 ? d.totalScore + ' 分' : '未完成评测'}`, body, wide: '880px' });
  if (focusTask !== undefined) setTimeout(() => { const el = $('#detail-task-' + focusTask); if (el) el.scrollIntoView(); }, 50);
}

async function showSource(name, task) {
  try {
    const r = await api('GET', cpath() + '/contestants/' + enc(name) + '/source/' + task);
    modal({
      title: `${name} · ${S.contest.tasks[task].problemTitle}`,
      body: r.files.length ? r.files.map((f) => h('div', null, h('div', { class: 'section-title' }, f.name), h('pre', { class: 'source-view' }, f.content))) : h('div', { class: 'empty' }, '未找到源程序'),
    });
  } catch (e) { fail(e); }
}

// ---------------------------------------- statistics tab -----------------------------------
async function renderStatisticsTab(page) {
  if (S.contest.running) {
    page.appendChild(h('div', { class: 'empty' }, `比赛中，${fmtDate(S.contest.endTime)} 后可查看统计。`));
    return;
  }
  const html = await api('GET', cpath() + '/statistics');
  page.appendChild(h('div', { class: 'toolbar' },
    h('button', { onclick: () => route() }, '刷新'),
    h('button', { class: 'right', onclick: () => download(cpath() + '/statistics' + qs({ download: 1 }), 'statistics.html') }, '导出 statistics.html')));
  const css = `<style>:root{color-scheme:${isDark() ? 'dark' : 'light'}}body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:8px 22px;margin:0;${isDark() ? 'background:#1c1c1e;color:#f2f2f7' : ''}}table{border-collapse:collapse;margin:6px 0}th,td{border:1px solid ${isDark() ? '#48484a' : '#d1d1d6'};padding:4px 10px}h1{font-size:22px}h2{font-size:18px}h3{font-size:15px}</style>`;
  const frame = h('iframe', { class: 'statistics-frame' });
  frame.srcdoc = html.startsWith('<html') ? html.replace('<head>', '<head>' + css) : `<html><head>${css}</head><body>${html}</body></html>`;
  page.appendChild(frame);
}

// ---------------------------------------- files tab: in-browser file system ----------------
async function fsList(path) {
  const r = await api('GET', cpath() + '/files' + qs({ root: 'contest', path }));
  S.fs.cache.set(path, r.entries);
  return r.entries;
}

const fsDownload = (path, name) => download(cpath() + '/files/download' + qs({ root: 'contest', path }), name);

async function fsTransfer(mode, paths, to) {
  const r = await api('POST', cpath() + '/files/' + mode, { root: 'contest', paths, to });
  toast(`已${mode === 'copy' ? '复制' : '移动'} ${r.items.length} 项到 /${to}`);
  return r.items;
}

// Folder chooser used by "move to / copy to"
function pickFolder(title, initial, excluded) {
  return new Promise((resolve) => {
    let chosen = initial;
    let result = null;
    const box = h('div', { class: 'folder-picker' });
    const expanded = new Set(['', ...(initial ? initial.split('/').map((_, i, a) => a.slice(0, i + 1).join('/')) : [])]);
    const draw = async () => {
      box.innerHTML = '';
      const node = async (path, label, depth) => {
        const bad = excluded.some((x) => path === x || path.startsWith(x + '/'));
        const open = expanded.has(path);
        box.appendChild(h('div', {
          class: 'tree-item' + (path === chosen ? ' selected' : ''), style: { paddingLeft: (8 + depth * 14) + 'px', opacity: bad ? 0.4 : 1 },
          onclick: () => { if (!bad) { chosen = path; draw(); } },
          ondblclick: () => { if (!bad) { chosen = path; result = path; dlg.close(true); } },
        }, h('span', { class: 'twisty', onclick: (e) => { e.stopPropagation(); if (open) expanded.delete(path); else expanded.add(path); draw(); } }, open ? '▼' : '▶'),
        h('span', { class: 'label' }, (depth === 0 ? '🍋 ' : '📁 ') + label)));
        if (!open) return;
        let list = S.fs.cache.get(path);
        if (!list) { try { list = await fsList(path); } catch (e) { list = []; } }
        for (const d of list.filter((x) => x.dir)) await node(joinPath(path, d.name), d.name, depth + 1);
      };
      await node('', S.contest.name, 0);
    };
    const dlg = modal({
      title, body: box,
      buttons: [{ label: '取消' }, { label: '确定', primary: true, onClick: () => { result = chosen; } }],
      onClose: () => resolve(result),
    });
    draw();
  });
}

const FS_SHORTCUTS = [
  ['双击 / Enter', '打开文件夹或编辑文件'], ['Backspace / Alt+↑', '返回上一级'], ['↑ ↓（+Shift）', '移动选择（扩展选择）'],
  ['Ctrl/Shift + 单击', '多选 / 连续选择'], ['Ctrl+A', '全选'], ['Esc', '取消选择'],
  ['Ctrl+C / Ctrl+X / Ctrl+V', '复制 / 剪切 / 粘贴'], ['拖动到文件夹', '移动（按住 Ctrl 复制）'], ['M', '移动到…'],
  ['F2', '重命名'], ['Delete', '删除'], ['Ctrl+B', '用 Testlib for Lemons 编译选中的源文件'], ['Alt+N / Alt+Shift+N', '新建文件 / 文件夹'], ['Alt+U', '上传文件'],
  ['Ctrl+F 或 /', '筛选当前文件夹'], ['右键', '更多操作'],
];

async function renderFilesTab(page) {
  const F = S.fs;
  F.sort = F.sort || { key: 'name', dir: 1 };
  F.filter = F.filter || '';
  let entries;
  try { entries = await fsList(F.path); } catch (e) {
    if (e.status === 404 && F.path) { F.path = parentPath(F.path); return renderFilesTab(page); }
    throw e;
  }
  const names = new Set(entries.map((e) => e.name));
  F.selected = new Set([...(F.selected || [])].filter((n) => names.has(n)));
  const reload = async (keep) => {
    F.cache.clear();
    if (keep !== undefined) F.selected = new Set(keep);
    page.innerHTML = '';
    await renderFilesTab(page);
    loadDataFiles();
  };
  const go = (path) => { F.path = path; F.expanded.add(path); F.selected = new Set(); F.anchor = -1; F.filter = ''; reload(); };
  const full = (name) => joinPath(F.path, name);
  const isInternalDrag = (e) => [...e.dataTransfer.types].includes('application/x-lemonserver-paths');

  // ---------- visible rows ----------
  const sortKey = { name: (e) => e.name.toLowerCase(), size: (e) => e.size, modified: (e) => e.modified };
  const visible = entries
    .filter((e) => !F.filter || e.name.toLowerCase().includes(F.filter.toLowerCase()))
    .sort((a, b) => (b.dir - a.dir) || (sortKey[F.sort.key](a) < sortKey[F.sort.key](b) ? -1 : sortKey[F.sort.key](a) > sortKey[F.sort.key](b) ? 1 : 0) * F.sort.dir);

  // ---------- operations ----------
  const selectedPaths = () => visible.filter((e) => F.selected.has(e.name)).map((e) => full(e.name));
  const openEntry = (e) => {
    if (e.dir) go(full(e.name));
    else if (e.size < EDIT_LIMIT) openEditor(full(e.name), false, () => reload([e.name]));
    else fsDownload(full(e.name), e.name);
  };
  const remove = async () => {
    const paths = selectedPaths();
    if (!paths.length) return;
    if (!await confirmDlg(paths.length === 1 ? `删除 ${paths[0].split('/').pop()}？` : `删除选中的 ${paths.length} 项？`, '删除')) return;
    try { await api('POST', cpath() + '/files/delete', { root: 'contest', paths }); reload([]); } catch (err) { fail(err); }
  };
  const rename = async () => {
    const sel = visible.filter((e) => F.selected.has(e.name));
    if (sel.length !== 1) return;
    const old = sel[0].name;
    const n = await promptDlg('重命名', old);
    if (!n || n === old) return;
    try { await api('POST', cpath() + '/files/rename', { root: 'contest', from: full(old), to: full(n) }); reload([n]); } catch (err) { fail(err); }
  };
  const setClip = (mode) => {
    const paths = selectedPaths();
    if (!paths.length) return;
    F.clip = { mode, paths };
    toast(`已${mode === 'cut' ? '剪切' : '复制'} ${paths.length} 项，在目标文件夹按 Ctrl+V 粘贴`);
    paint();
  };
  const paste = async (dest = F.path) => {
    if (!F.clip) return;
    const { mode, paths } = F.clip;
    try {
      const items = await fsTransfer(mode === 'cut' ? 'move' : 'copy', paths, dest);
      if (mode === 'cut') F.clip = null;
      reload(dest === F.path ? items.filter((p) => parentPath(p) === F.path).map((p) => p.split('/').pop()) : undefined);
    } catch (err) { fail(err); }
  };
  const moveTo = async (copy = false) => {
    const paths = selectedPaths();
    if (!paths.length) return;
    const dest = await pickFolder(`${copy ? '复制' : '移动'} ${paths.length} 项到…`, F.path, copy ? [] : paths);
    if (dest === null) return;
    try { await fsTransfer(copy ? 'copy' : 'move', paths, dest); reload([]); } catch (err) { fail(err); }
  };
  const newFile = async () => {
    const n = await promptDlg('新建文件', '', '文件名，如 checker.cpp');
    if (n) openEditor(full(n), true, () => reload([n]));
  };
  const newFolder = async () => {
    const n = await promptDlg('新建文件夹', '', '文件夹名');
    if (!n) return;
    try { await api('POST', cpath() + '/files/mkdir', { root: 'contest', path: full(n) }); F.expanded.add(F.path); reload([n]); } catch (err) { fail(err); }
  };
  const compilable = (e) => e && !e.dir && /\.(cpp|cc|cxx|c)$/i.test(e.name);
  const compileSelected = () => {
    const sel = visible.filter((x) => F.selected.has(x.name));
    if (sel.length === 1 && compilable(sel[0])) compileDialog(full(sel[0].name), (exe) => reload([exe.split('/').pop()]));
    else toast('请选择一个 C/C++ 源文件', 'error');
  };
  const fromTemplate = async () => {
    const name = await chooseTemplate();
    if (!name) return;
    try {
      const r = await api('POST', cpath() + '/files/template', { root: 'contest', path: F.path, template: name });
      toast('已创建 ' + r.name);
      reload([r.name]);
    } catch (err) { fail(err); }
  };
  const showHelp = () => modal({
    title: '快捷键',
    body: h('table', { class: 'grid' }, FS_SHORTCUTS.map(([k, v]) => h('tr', null, h('td', null, k.split(' / ').map((x, i) => [i ? ' / ' : '', h('kbd', null, x)])), h('td', { class: 'muted' }, v)))),
  });

  // ---------- upload ----------
  const uploadTo = async (dir, items) => {
    if (!items.length) return;
    const label = h('div', null, '准备上传…');
    const bar = h('div', { style: { width: '0%' } });
    const dlg = modal({ title: '上传到 /' + dir, body: h('div', { style: { width: '420px' } }, h('div', { class: 'progress' }, bar), h('div', { class: 'progress-label' }, label)), closable: false });
    let n = 0;
    try {
      for (const it of items) {
        label.textContent = `${++n} / ${items.length} · ${it.rel}`;
        bar.style.width = (n / items.length * 100) + '%';
        await api('PUT', cpath() + '/files/upload' + qs({ root: 'contest', path: joinPath(dir, it.rel) }), undefined, { raw: it.file });
      }
      toast(`已上传 ${items.length} 个文件`);
    } catch (e) { fail(e); } finally {
      dlg.close(true);
      F.expanded.add(dir);
      reload(dir === F.path ? [...new Set(items.map((it) => it.rel.split('/')[0]))] : undefined);
    }
  };
  const unzipTo = async (dir, file) => {
    const strip = h('input', { type: 'checkbox', checked: true });
    let ok = false;
    await new Promise((resolve) => modal({
      title: '解压 ' + file.name,
      body: h('div', null, h('div', { class: 'muted', style: { marginBottom: '10px' } }, '解压到 /' + dir), h('label', { class: 'inline' }, strip, '去掉唯一的顶层文件夹')),
      buttons: [{ label: '取消' }, { label: '解压', primary: true, onClick: () => { ok = true; } }],
      onClose: resolve,
    }));
    if (!ok) return;
    const dlg = modal({ title: '正在解压…', body: h('div', { class: 'progress', style: { width: '360px' } }, h('div', { style: { width: '100%' } })), closable: false });
    try {
      const r = await api('POST', cpath() + '/files/unzip' + qs({ root: 'contest', path: dir, stripTop: strip.checked ? 1 : 0 }), undefined, { raw: file });
      toast(`已解压 ${r.files} 个文件`);
    } catch (e) { fail(e); } finally { dlg.close(true); reload(); }
  };
  const pick = (attrs, cb) => {
    const inp = h('input', { type: 'file', ...attrs, style: { display: 'none' } });
    inp.addEventListener('change', () => { cb([...inp.files]); inp.remove(); });
    document.body.appendChild(inp);
    inp.click();
  };
  const uploadFiles = (dir = F.path) => pick({ multiple: true }, (fs) => uploadTo(dir, fs.map((f) => ({ file: f, rel: f.name }))));
  const uploadFolder = (dir = F.path) => pick({ webkitdirectory: true, multiple: true }, (fs) => uploadTo(dir, fs.map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }))));
  const uploadZip = (dir = F.path) => pick({ accept: '.zip' }, (fs) => fs.length && unzipTo(dir, fs[0]));
  const collectDrop = async (e) => {
    const items = [];
    const walk = (entry, prefix) => new Promise((resolve) => {
      if (entry.isFile) entry.file((f) => { items.push({ file: f, rel: prefix + f.name }); resolve(); }, () => resolve());
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const batch = () => reader.readEntries(async (ents) => {
          if (!ents.length) { for (const x of all) await walk(x, prefix + entry.name + '/'); resolve(); } else { all.push(...ents); batch(); }
        }, () => resolve());
        batch();
      } else resolve();
    });
    const roots = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (roots.length) for (const r of roots) await walk(r, '');
    else for (const f of e.dataTransfer.files) items.push({ file: f, rel: f.name });
    return items;
  };
  // Folder drop target: internal drags move/copy, external files upload.
  const dropTarget = (el, dirFn, cls = 'drop') => {
    el.addEventListener('dragover', (e) => {
      const internal = isInternalDrag(e);
      if (internal && S.fsDragPaths && S.fsDragPaths.some((p) => dirFn() === p || dirFn().startsWith(p + '/'))) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = internal ? (e.ctrlKey || e.altKey ? 'copy' : 'move') : 'copy';
      el.classList.add(cls);
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove(cls); });
    el.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.remove(cls);
      const dir = dirFn();
      if (isInternalDrag(e)) {
        const paths = JSON.parse(e.dataTransfer.getData('application/x-lemonserver-paths') || '[]');
        const copy = e.ctrlKey || e.altKey;
        if (!copy && paths.every((p) => parentPath(p) === dir)) return;
        try { await fsTransfer(copy ? 'copy' : 'move', paths, dir); reload(dir === F.path ? undefined : []); } catch (err) { fail(err); }
        return;
      }
      const items = await collectDrop(e);
      if (items.length === 1 && /\.zip$/i.test(items[0].file.name)) {
        if (await confirmDlg(`解压 ${items[0].file.name}？选择“取消”则直接上传 zip 文件。`, '解压', false)) return unzipTo(dir, items[0].file);
      }
      uploadTo(dir, items);
    });
  };

  // ---------- folder tree ----------
  const tree = h('div', { class: 'fs-tree' });
  const drawTree = async () => {
    const frag = document.createDocumentFragment();
    const node = async (path, label, depth) => {
      const open = F.expanded.has(path);
      const item = h('div', {
        class: 'tree-item' + (path === F.path ? ' selected' : ''), style: { paddingLeft: (8 + depth * 14) + 'px' },
        onclick: () => go(path),
        oncontextmenu: (e) => { e.preventDefault(); folderMenu(e.clientX, e.clientY, path); },
      }, h('span', {
        class: 'twisty', onclick: (e) => { e.stopPropagation(); if (open) F.expanded.delete(path); else F.expanded.add(path); drawTree(); },
      }, open ? '▼' : '▶'), h('span', { class: 'label' }, (depth === 0 ? '🍋 ' : '📁 ') + label));
      dropTarget(item, () => path);
      frag.appendChild(item);
      if (!open) return;
      let list = F.cache.get(path);
      if (!list) { try { list = await fsList(path); } catch (e) { list = []; } }
      for (const d of list.filter((x) => x.dir).sort((a, b) => a.name.localeCompare(b.name))) await node(joinPath(path, d.name), d.name, depth + 1);
    };
    await node('', S.contest.name, 0);
    tree.innerHTML = '';
    tree.appendChild(frag);
  };

  // ---------- context menus ----------
  const folderMenu = (x, y, dir) => showMenu(x, y, [
    { label: '新建文件', kbd: 'Alt+N', onClick: () => { if (dir !== F.path) { F.path = dir; } newFile(); } },
    { label: '新建文件夹', kbd: 'Alt+Shift+N', onClick: () => { if (dir !== F.path) { F.path = dir; } newFolder(); } },
    'sep',
    { label: '上传文件…', kbd: 'Alt+U', onClick: () => uploadFiles(dir) },
    { label: '上传文件夹…', onClick: () => uploadFolder(dir) },
    { label: '上传 zip 并解压…', onClick: () => uploadZip(dir) },
    'sep',
    { label: F.clip ? `粘贴 ${F.clip.paths.length} 项` : '粘贴', kbd: 'Ctrl+V', disabled: !F.clip, onClick: () => paste(dir) },
    { label: '下载为 zip', onClick: () => fsDownload(dir, (dir.split('/').pop() || S.contest.name) + '.zip') },
  ]);
  const itemMenu = (x, y) => {
    const sel = visible.filter((e) => F.selected.has(e.name));
    const one = sel.length === 1 ? sel[0] : null;
    showMenu(x, y, [
      one ? { label: one.dir ? '打开' : one.size < EDIT_LIMIT ? '编辑' : '下载', kbd: 'Enter', onClick: () => openEntry(one) } : null,
      compilable(one) ? { label: '编译（Testlib for Lemons）…', kbd: 'Ctrl+B', onClick: compileSelected } : null,
      { label: sel.length > 1 ? `下载 ${sel.length} 项…` : '下载', onClick: () => sel.forEach((e) => fsDownload(full(e.name), e.dir ? e.name + '.zip' : e.name)) },
      'sep',
      { label: '复制', kbd: 'Ctrl+C', onClick: () => setClip('copy') },
      { label: '剪切', kbd: 'Ctrl+X', onClick: () => setClip('cut') },
      one && one.dir && F.clip ? { label: `粘贴到 ${one.name}`, onClick: () => paste(full(one.name)) } : null,
      { label: '移动到…', kbd: 'M', onClick: () => moveTo(false) },
      { label: '复制到…', onClick: () => moveTo(true) },
      'sep',
      { label: '重命名', kbd: 'F2', disabled: !one, onClick: rename },
      { label: '删除', kbd: 'Delete', danger: true, onClick: remove },
    ]);
  };

  // ---------- breadcrumbs ----------
  const crumbs = h('div', { class: 'crumbs' });
  const addCrumb = (label, path) => {
    const a = h('a', { onclick: () => go(path) }, label);
    dropTarget(a, () => path);
    crumbs.appendChild(a);
  };
  addCrumb(S.contest.name, '');
  let acc = '';
  for (const part of (F.path ? F.path.split('/') : [])) {
    acc = joinPath(acc, part);
    crumbs.appendChild(h('span', { class: 'slash' }, '/'));
    addCrumb(part, acc);
  }

  const filterInput = h('input', {
    type: 'search', class: 'fs-filter', placeholder: '筛选', value: F.filter,
    oninput: debounce((e) => { F.filter = e.target.value; reload([...F.selected]); }, 200),
    onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.target.value = ''; F.filter = ''; reload([...F.selected]); } if (e.key === 'ArrowDown') { e.preventDefault(); e.target.blur(); } },
  });
  const toolbar = h('div', { class: 'toolbar' }, crumbs,
    h('div', { class: 'right row' }, filterInput,
      h('button', { onclick: (e) => menuBelow(e.currentTarget, [
        { label: '上传文件…', kbd: 'Alt+U', onClick: () => uploadFiles() },
        { label: '上传文件夹…', onClick: () => uploadFolder() },
        { label: '上传 zip 并解压…', onClick: () => uploadZip() },
      ]) }, '上传 ▾'),
      h('button', { onclick: (e) => menuBelow(e.currentTarget, [
        { label: '新建文件', kbd: 'Alt+N', onClick: newFile },
        { label: '新建文件夹', kbd: 'Alt+Shift+N', onClick: newFolder },
        'sep',
        { label: '从 Testlib 模板新建…', onClick: fromTemplate },
      ]) }, '新建 ▾'),
      h('button', { onclick: () => fsDownload(F.path, (F.path.split('/').pop() || S.contest.name) + '.zip'), title: '打包下载当前文件夹' }, '下载'),
      h('button', { onclick: showHelp, title: '快捷键' }, '?')));

  // ---------- listing ----------
  const sortTh = (key, label, style) => h('th', {
    class: 'sortable', style,
    onclick: () => { F.sort = { key, dir: F.sort.key === key ? -F.sort.dir : 1 }; reload([...F.selected]); },
  }, label, F.sort.key === key ? (F.sort.dir > 0 ? ' ↑' : ' ↓') : '');
  const rows = [];
  const status = h('div', { class: 'fs-status' });
  const paint = () => {
    rows.forEach(({ e, row }) => {
      row.classList.toggle('selected', F.selected.has(e.name));
      row.classList.toggle('cut', !!(F.clip && F.clip.mode === 'cut' && F.clip.paths.includes(full(e.name))));
    });
    const sel = visible.filter((e) => F.selected.has(e.name));
    const size = sel.reduce((a, e) => a + (e.dir ? 0 : e.size), 0);
    status.innerHTML = '';
    status.append(...[
      h('span', null, `${visible.length} 项` + (F.filter ? `（已筛选，共 ${entries.length} 项）` : '')),
      sel.length ? h('span', null, `已选 ${sel.length} 项` + (size ? ` · ${formatSize(size)}` : '')) : null,
      F.clip ? h('span', null, `剪贴板：${F.clip.paths.length} 项（${F.clip.mode === 'cut' ? '剪切' : '复制'}）`, h('a', { style: { marginLeft: '6px' }, onclick: () => paste() }, '粘贴到这里'), h('a', { style: { marginLeft: '6px' }, onclick: () => { F.clip = null; paint(); } }, '清除')) : null,
      h('span', { class: 'right' }, '右键查看更多操作 · ', h('a', { onclick: showHelp }, '快捷键'))].filter(Boolean));
  };
  const selectIndex = (i, e) => {
    const item = visible[i];
    if (!item) return;
    if (e && e.shiftKey && F.anchor >= 0) {
      const [a, b] = [Math.min(F.anchor, i), Math.max(F.anchor, i)];
      if (!(e.ctrlKey || e.metaKey)) F.selected = new Set();
      for (let k = a; k <= b; k++) F.selected.add(visible[k].name);
    } else if (e && (e.ctrlKey || e.metaKey)) {
      if (F.selected.has(item.name)) F.selected.delete(item.name); else F.selected.add(item.name);
      F.anchor = i;
    } else {
      F.selected = new Set([item.name]);
      F.anchor = i;
    }
    F.cursor = i;
    paint();
    rows[i] && rows[i].row.scrollIntoView({ block: 'nearest' });
  };

  const table = h('table', { class: 'grid files' },
    h('tr', null, sortTh('name', '名称'), sortTh('size', '大小', { width: '110px' }), sortTh('modified', '最后修改', { width: '170px' })),
    F.path ? h('tr', { class: 'file-row', ondblclick: () => go(parentPath(F.path)) }, h('td', { class: 'name' }, h('span', { class: 'icon' }, '↩'), '..'), h('td'), h('td')) : null,
    visible.map((e, i) => {
      const row = h('tr', { class: 'file-row', draggable: 'true' },
        h('td', { class: 'name', title: e.dir ? '' : e.size < EDIT_LIMIT ? '双击编辑' : '双击下载' }, h('span', { class: 'icon' }, e.dir ? '📁' : fileIcon(e.name)), e.name),
        h('td', { class: 'muted' }, e.dir ? '' : formatSize(e.size)),
        h('td', { class: 'muted' }, e.modified));
      row.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        // keep a multi-selection when starting to drag it
        if (!(ev.ctrlKey || ev.metaKey || ev.shiftKey) && F.selected.has(e.name) && F.selected.size > 1) return;
        selectIndex(i, ev);
      });
      row.addEventListener('click', (ev) => {
        if (!(ev.ctrlKey || ev.metaKey || ev.shiftKey) && F.selected.size > 1) selectIndex(i, ev);
      });
      row.addEventListener('dblclick', () => openEntry(e));
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!F.selected.has(e.name)) selectIndex(i);
        itemMenu(ev.clientX, ev.clientY);
      });
      row.addEventListener('dragstart', (ev) => {
        if (!F.selected.has(e.name)) selectIndex(i);
        const paths = selectedPaths();
        S.fsDragPaths = paths;
        ev.dataTransfer.setData('application/x-lemonserver-paths', JSON.stringify(paths));
        ev.dataTransfer.setData('text/plain', paths.join('\n'));
        ev.dataTransfer.effectAllowed = 'copyMove';
      });
      row.addEventListener('dragend', () => { S.fsDragPaths = null; });
      if (e.dir) dropTarget(row, () => full(e.name));
      rows.push({ e, row });
      return row;
    }));
  const list = h('div', { class: 'fs-list', tabindex: '-1' }, visible.length || F.path ? table : null,
    !visible.length ? h('div', { class: 'empty' }, F.filter ? '没有匹配的项目' : '空文件夹 · 拖入文件即可上传') : null);
  list.addEventListener('mousedown', (e) => { if (e.target === list || e.target.classList.contains('empty')) { F.selected = new Set(); paint(); } });
  list.addEventListener('contextmenu', (e) => { e.preventDefault(); F.selected = new Set(); paint(); folderMenu(e.clientX, e.clientY, F.path); });
  dropTarget(list, () => F.path, 'drag');

  const root = h('div', { class: 'fs' }, tree, h('div', { class: 'fs-main' }, toolbar, list, status));
  page.appendChild(root);
  paint();
  drawTree();

  // ---------- keyboard ----------
  S.fsView = {
    root,
    keydown: (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key;
      const cur = F.cursor >= 0 && F.cursor < visible.length ? F.cursor : visible.findIndex((x) => F.selected.has(x.name));
      if (ctrl && k.toLowerCase() === 'f' || (k === '/' && !ctrl)) { e.preventDefault(); filterInput.focus(); filterInput.select(); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        if (e.altKey && k === 'ArrowUp') { if (F.path) go(parentPath(F.path)); return; }
        const next = cur < 0 ? 0 : Math.max(0, Math.min(visible.length - 1, cur + (k === 'ArrowDown' ? 1 : -1)));
        selectIndex(next, e.shiftKey ? { shiftKey: true } : null);
        return;
      }
      if (k === 'Home' || k === 'End') { e.preventDefault(); selectIndex(k === 'Home' ? 0 : visible.length - 1, e.shiftKey ? { shiftKey: true } : null); return; }
      if (k === 'Enter') { const sel = visible.filter((x) => F.selected.has(x.name)); if (sel.length === 1) { e.preventDefault(); openEntry(sel[0]); } return; }
      if (k === 'Backspace') { e.preventDefault(); if (F.path) go(parentPath(F.path)); return; }
      if (k === 'Delete') { e.preventDefault(); remove(); return; }
      if (k === 'F2') { e.preventDefault(); rename(); return; }
      if (k === 'Escape') { if (F.selected.size) { F.selected = new Set(); paint(); } return; }
      if (ctrl && k.toLowerCase() === 'a') { e.preventDefault(); F.selected = new Set(visible.map((x) => x.name)); paint(); return; }
      if (ctrl && k.toLowerCase() === 'c') { e.preventDefault(); setClip('copy'); return; }
      if (ctrl && k.toLowerCase() === 'x') { e.preventDefault(); setClip('cut'); return; }
      if (ctrl && k.toLowerCase() === 'v') { e.preventDefault(); paste(); return; }
      if (e.altKey && k.toLowerCase() === 'n') { e.preventDefault(); if (e.shiftKey) newFolder(); else newFile(); return; }
      if (e.altKey && k.toLowerCase() === 'u') { e.preventDefault(); uploadFiles(); return; }
      if (ctrl && k.toLowerCase() === 'b') { e.preventDefault(); compileSelected(); return; }
      if (!ctrl && !e.altKey && k.toLowerCase() === 'm') { e.preventDefault(); moveTo(false); return; }
      if (k === '?') { e.preventDefault(); showHelp(); }
    },
  };
}

document.addEventListener('keydown', (e) => {
  const v = S.fsView;
  if (!v || !document.body.contains(v.root)) return;
  if (S.menu || $('#modal-root').childElementCount || typing(e)) return;
  v.keydown(e);
});

async function chooseTemplate() {
  let names;
  try { names = await api('GET', '/api/testlib/templates'); } catch (e) { fail(e); return null; }
  return new Promise((resolve) => {
    let result = null;
    const groups = { checkers: '校验器 (checker)', interactors: '交互器', validators: '数据校验器', generators: '数据生成器' };
    const body = h('div', { style: { width: '460px', maxHeight: '56vh', overflow: 'auto' } },
      h('div', { class: 'tree-item', ondblclick: () => { result = 'testlib.h'; dlg.close(true); }, onclick: (e) => pickRow(e, 'testlib.h') }, '📝 testlib.h', h('span', { class: 'score' }, 'Testlib for Lemons')));
    let current = null;
    const pickRow = (e, name) => {
      body.querySelectorAll('.tree-item.selected').forEach((x) => x.classList.remove('selected'));
      e.currentTarget.classList.add('selected');
      current = name;
    };
    for (const [dir, label] of Object.entries(groups)) {
      const list = names.filter((n) => n.startsWith(dir + '/'));
      if (!list.length) continue;
      body.appendChild(h('div', { class: 'section-title', style: { marginTop: '12px' } }, label));
      for (const n of list) body.appendChild(h('div', { class: 'tree-item', onclick: (e) => pickRow(e, n), ondblclick: () => { result = n; dlg.close(true); } }, '📝 ' + n.split('/').pop()));
    }
    const dlg = modal({
      title: '从 Testlib for Lemons 模板新建', body,
      buttons: [{ label: '取消' }, { label: '创建', primary: true, onClick: () => { if (!current) return false; result = current; } }],
      onClose: () => resolve(result),
    });
  });
}

// Compile a source file on the server with Testlib for Lemons, optionally using it as a task's checker.
function compileDialog(path, onDone) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const out = h('input', { type: 'text', class: 'mono', value: path.replace(/\.[^./]+$/, ''), style: { maxWidth: 'none' } });
  const typical = S.compilers.filter((c) => c.compilerType === 0);
  const comp = h('select', null, h('option', { value: '' }, '自动（按扩展名）'), typical.map((c) => h('option', { value: c.compilerName }, c.compilerName)));
  const args = h('input', { type: 'text', class: 'mono', value: ext === 'c' ? '-O2 -std=c11 -lm' : '-O2 -std=c++17', style: { maxWidth: 'none' } });
  const bundled = h('input', { type: 'checkbox', checked: true });
  const status = h('div', { class: 'small-text', style: { minHeight: '18px' } });
  const log = h('pre', { class: 'compile-msg hidden', style: { maxHeight: '300px' } });
  const after = h('div');
  let built = null;
  const run = async (btn) => {
    if (btn) btn.disabled = true;
    status.textContent = '编译中…';
    status.className = 'small-text muted';
    after.innerHTML = '';
    try {
      const r = await api('POST', cpath() + '/files/compile', { root: 'contest', path, output: out.value.trim(), compiler: comp.value || undefined, arguments: args.value, bundledTestlib: bundled.checked });
      log.classList.remove('hidden');
      log.textContent = r.output.trim() || '(无输出)';
      if (r.ok) {
        built = r.executable;
        status.className = 'small-text status-saved';
        status.textContent = `✓ 已生成 ${r.executable} · ${r.compiler} · ${r.seconds.toFixed(1)} s`;
        if (built.startsWith('data/') && S.contest.tasks.length) after.appendChild(useAsChecker(built.slice(5)));
        if (onDone) onDone(built);
      } else {
        status.className = 'small-text error-text';
        status.textContent = r.timedOut ? '✗ 编译超时' : `✗ 编译失败（退出码 ${r.exitCode}）`;
      }
    } catch (e) { status.className = 'small-text error-text'; status.textContent = '✗ ' + e.message; } finally { if (btn) btn.disabled = false; }
  };
  const body = h('div', { style: { width: '640px' } },
    h('div', { class: 'form-grid', style: { gridTemplateColumns: '90px 1fr' } },
      field('源文件', h('span', { class: 'mono' }, '/' + path)),
      field('输出', out, 'Windows 下会自动加上 .exe'),
      field('编译器', comp),
      field('参数', args),
      field('', h('label', { class: 'inline' }, bundled, '使用内置的 Testlib for Lemons（testlib.h）'))),
    h('div', { style: { marginTop: '12px' } }, status, log, after));
  const dlg = modal({
    title: '编译', body,
    buttons: [{ label: '关闭' }, { label: '编译', primary: true, onClick: async () => { await run(dlg.foot.lastChild); return false; } }],
  });
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target.tagName === 'INPUT')) { e.preventDefault(); run(dlg.foot.lastChild); } });
}

function useAsChecker(dataPath) {
  const task = h('select', null, S.contest.tasks.map((t, i) => h('option', { value: i, selected: i === Math.max(0, S.sel.task) }, t.problemTitle)));
  const mode = h('select', null, h('option', { value: 5 }, 'Testlib 校验器'), h('option', { value: 4 }, 'Lemon 校验器'));
  return h('div', { class: 'row', style: { marginTop: '12px' } },
    h('span', null, '设为'), task, h('span', null, '的'), mode,
    h('button', {
      class: 'small primary', onclick: async () => {
        try {
          await saveTask(+task.value, { specialJudge: dataPath, comparisonMode: +mode.value });
          toast(`已设为 ${S.contest.tasks[+task.value].problemTitle} 的校验器`);
        } catch (e) { fail(e); }
      },
    }, '应用'));
}

function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'py', 'java', 'pas'].includes(ext)) return '📝';
  if (['in', 'out', 'ans', 'txt'].includes(ext)) return '📄';
  if (ext === 'zip') return '🗜';
  if (ext === 'cdf') return '🍋';
  if (['html', 'htm', 'csv'].includes(ext)) return '📊';
  if (ext === 'exe') return '⚙️';
  return '📄';
}

async function openEditor(path, isNew, onSaved) {
  let info = { content: '', encoding: 'utf-8', eol: 'lf', modified: '', modifiedMs: undefined, size: 0, editable: true };
  if (!isNew) {
    try { info = await api('GET', cpath() + '/files/download' + qs({ root: 'contest', path, text: 1 })); } catch (e) { return fail(e); }
    if (info.binary) return toast('二进制文件无法在线编辑', 'error');
    if (!info.editable) return toast('只能在线编辑 100 KiB 以下的文件', 'error');
  }
  const area = h('textarea', { class: 'code-editor', spellcheck: 'false' });
  area.value = info.content;
  let saved = info.content;
  const meta = h('span', { class: 'muted small-text' });
  const drawMeta = () => {
    const bytes = new TextEncoder().encode(area.value).length;
    meta.textContent = [info.modified ? '最后修改 ' + info.modified : '新文件', formatSize(bytes), info.encoding === 'local' ? '本地编码' : 'UTF-8', info.eol.toUpperCase()].join(' · ');
    meta.style.color = bytes >= EDIT_LIMIT ? 'var(--danger)' : '';
  };
  drawMeta();
  const dirtyMark = h('span', { class: 'muted' });
  const updateDirty = () => { dirtyMark.textContent = area.value !== saved ? '● 未保存' : ''; drawMeta(); };
  area.addEventListener('input', updateDirty);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
      updateDirty();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });
  const save = async (force = false) => {
    try {
      const r = await api('PUT', cpath() + '/files/text', {
        root: 'contest', path, content: area.value, encoding: info.encoding, eol: info.eol,
        expectedModifiedMs: force || isNew ? undefined : info.modifiedMs,
      });
      info.modified = r.modified;
      info.modifiedMs = r.modifiedMs;
      isNew = false;
      saved = area.value;
      updateDirty();
      toast('已保存');
      if (onSaved) onSaved();
      return true;
    } catch (e) {
      if (e.status === 409 && await confirmDlg(e.message + '。仍要覆盖吗？', '覆盖')) return save(true);
      fail(e);
      return false;
    }
  };
  const dlg = modal({
    title: h('span', { class: 'row' }, h('span', { class: 'mono' }, '/' + path), dirtyMark),
    body: h('div', null, area, h('div', { class: 'row', style: { marginTop: '8px' } }, meta, h('span', { class: 'right muted small-text' }, 'Ctrl+S 保存 · Esc 关闭'))),
    buttons: [
      { label: '下载', onClick: () => { fsDownload(path, path.split('/').pop()); return false; } },
      { label: '关闭' },
      { label: '保存', primary: true, onClick: async () => { await save(); return false; } },
    ],
    beforeClose: async () => area.value === saved || confirmDlg('放弃未保存的修改？', '放弃'),
  });
  dlg.foot.firstChild.style.marginRight = 'auto';
  setTimeout(() => area.focus(), 50);
}

// ------------------------------------------------------------------------------------------------
// Judging: progress and log live in a side panel of the contest page (JudgingDialog)
// ------------------------------------------------------------------------------------------------
async function startJudge(mode, items, extra = {}) {
  try {
    const st = await api('POST', cpath() + '/judge', { mode, items, ...extra });
    S.judge.contest = S.contest.name;
    S.judge.since = st.lastEventId;
    S.judge.log = st.events.slice();   // a new run starts with a fresh log
    S.judge.status = st;
    S.judge.panelOpen = true;
    S.contest.judging = true;
    if (location.hash.includes('/contest/')) route(); else renderJudgePanel();
    startJudgePolling();
  } catch (e) { fail(e); }
}

function stopJudgePolling() {
  if (S.judge.timer) clearInterval(S.judge.timer);
  S.judge.timer = null;
}

function startJudgePolling() {
  stopJudgePolling();
  S.judge.timer = setInterval(pollJudge, 700);
  pollJudge();
}

async function checkJudgeStatus() {
  try {
    const list = await api('GET', '/api/contests');
    if (list.judging && list.current) {
      if (S.judge.contest !== list.current) { S.judge.contest = list.current; S.judge.since = 0; S.judge.log = []; }
      if (!S.judge.timer) startJudgePolling();
    }
  } catch (e) { /* ignore */ }
}

let pollBusy = false;
async function pollJudge() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const st = await api('GET', cpath(S.judge.contest) + '/judge/status' + qs({ since: S.judge.since }));
    S.judge.status = st;
    for (const e of st.events) {
      S.judge.since = Math.max(S.judge.since, e.id);
      S.judge.log.push(e);
    }
    if (S.judge.log.length > 5000) S.judge.log.splice(0, S.judge.log.length - 5000);
    appendJudgeLog(st.events);
    updateJudgeBadge();
    if (st.events.some((e) => e.type === 'taskFinished') && S.contest && S.contest.name === S.judge.contest && location.hash.includes('/results')) {
      refreshResultsQuietly();
    }
    if (!st.judging) {
      stopJudgePolling();
      if (S.contest && S.contest.name === S.judge.contest) {
        await reloadContest();
        if (location.hash.includes('/contest/')) route();
      }
      toast(st.stopRequested ? '评测已停止' : '评测完成');
    }
  } catch (e) {
    if (e.status === 401) stopJudgePolling();
  } finally { pollBusy = false; }
}

const refreshResultsQuietly = debounce(async () => {
  try {
    await reloadContest();
    const page = $('.tabpage');
    if (page && location.hash.includes('/results')) {
      const y = page.querySelector('.results-wrap')?.scrollTop;
      page.innerHTML = '';
      renderResultsTab(page);
      const w = page.querySelector('.results-wrap');
      if (w && y) w.scrollTop = y;
    }
  } catch (e) { /* ignore */ }
}, 800);

function updateJudgeBadge() {
  const b = $('#judge-badge');
  if (!b) return;
  const st = S.judge.status;
  if (st && st.judging) {
    b.classList.remove('hidden');
    b.textContent = `评测中 ${st.tasksDone}/${st.tasksTotal}`;
  } else b.classList.add('hidden');
  renderJudgeProgress();
}

function openJudgeDialog() {
  // badge click: show the side panel of the contest being judged
  S.judge.panelOpen = true;
  if (S.contest && S.contest.name === S.judge.contest && location.hash.includes('/contest/')) renderJudgePanel();
  else go('#/contest/' + enc(S.judge.contest) + '/results');
}

function judgeLine(e) {
  const meta = (s) => h('span', { class: 'meta' }, s);
  switch (e.type) {
    case 'start': return h('div', { class: 'l1' }, `开始评测 · ${e.tasks} 项`, meta('  ' + (e.time || '')));
    case 'taskStarted': return h('div', { class: 'l2' }, h('b', null, e.contestant || ''), e.contestant ? h('span', { class: 'muted' }, ' · ') : null, e.task);
    case 'case':
      // during the contest time the server leaves out the result of each case
      if (e.result === undefined) return h('div', { class: 'l3 muted' }, `${e.contestant} #${e.testCase + 1}.${e.subCase + 1}  已评测`);
      return h('div', { class: 'l3' }, h('span', { class: 'muted' }, e.contestant + ' '), `#${e.testCase + 1}.${e.subCase + 1}  `, resultTag(e.result),
        e.timeUsed >= 0 ? meta(`  ${e.timeUsed} ms`) : null, e.memoryUsed >= 0 ? meta(`  ${(e.memoryUsed / 1048576).toFixed(2)} MiB`) : null,
        e.score > 0 ? h('span', { class: 'pts' }, `  +${e.score}`) : null);
    case 'dependence': return h('div', { class: 'l3 muted' }, `#${e.testCase + 1} 依赖 #${e.dependence}：`, e.status >= 1000000 ? 'Pure' : e.status < 0 ? 'Lost' : (e.status / 10000).toFixed(1) + '%');
    case 'compile': return e.state === 0 || e.state === undefined ? null : h('div', { class: 'l3' }, h('span', { class: 'muted' }, (e.contestant || '') + ' '), h('span', { class: 'error-text' }, COMPILE_ABBR[e.state] + ' · ' + COMPILE_STATE[e.state]));
    case 'stopping': return h('div', { class: 'l1 error-text' }, '正在停止…');
    case 'finished': return h('div', { class: 'l1' }, e.stopped ? '已停止' : '完成', meta('  ' + (e.time || '')));
    default: return null;
  }
}

function renderJudgePanel() {
  const slot = $('#judge-panel-slot');
  if (!slot) return;
  slot.innerHTML = '';
  const show = S.judge.panelOpen && S.contest && S.judge.contest === S.contest.name;
  const toggle = $('#judge-panel-toggle');
  if (toggle) toggle.classList.toggle('hidden', show || S.judge.contest !== (S.contest && S.contest.name) || !S.judge.log.length);
  if (!show) return;
  const log = h('div', { class: 'judge-log', id: 'judge-log' });
  if (!S.judge.log.length) log.appendChild(h('div', { class: 'empty' }, '暂无评测日志'));
  for (const e of S.judge.log) { const l = judgeLine(e); if (l) log.appendChild(l); }
  const stopBtn = h('button', { class: 'danger', id: 'judge-stop', onclick: async () => { try { await api('POST', cpath(S.judge.contest) + '/judge/stop'); } catch (e) { fail(e); } } }, '停止评测');
  slot.appendChild(h('div', { class: 'judge-panel' },
    h('div', { class: 'jp-head' }, h('b', null, '评测'), h('span', { class: 'muted small-text', id: 'judge-label' }),
      h('button', { class: 'x', title: '收起', onclick: () => { S.judge.panelOpen = false; renderJudgePanel(); } }, '✕')),
    h('div', { class: 'jp-progress' }, h('div', { class: 'progress' }, h('div', { id: 'judge-bar' }))),
    log,
    h('div', { class: 'jp-foot' }, stopBtn,
      h('button', { class: 'right', onclick: () => { S.judge.log = []; renderJudgePanel(); } }, '清空'))));
  log.scrollTop = log.scrollHeight;
  renderJudgeProgress();
}

function appendJudgeLog(events) {
  const log = $('#judge-log');
  if (!log || !events.length) return;
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  for (const e of events) { const l = judgeLine(e); if (l) log.appendChild(l); }
  while (log.childNodes.length > 5000) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderJudgeProgress() {
  const st = S.judge.status;
  const bar = $('#judge-bar'), label = $('#judge-label'), stop = $('#judge-stop');
  if (!bar || !st) { if (stop) stop.disabled = true; return; }
  const pct = st.progressMaximum > 0 ? Math.min(100, (st.progress / st.progressMaximum) * 100) : 0;
  bar.style.width = (st.judging ? pct : 100) + '%';
  label.textContent = st.judging ? `${st.tasksDone} / ${st.tasksTotal} · ${pct.toFixed(0)}%` : '已结束';
  stop.disabled = !st.judging || st.stopRequested;
}

// ------------------------------------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------------------------------------
async function renderSettings(section) {
  await loadSettings();
  const sections = [['general', '常规'], ['compilers', '编译器'], ['appearance', '外观'], ['security', '令牌与 API Key'], ['folder', '比赛位置']];
  const content = h('div', { class: 'editor' });
  shell(h('div', { class: 'tabpage', style: { marginTop: '14px' } }, h('div', { class: 'split' },
    h('div', { class: 'tree settings-nav' }, h('div', { class: 'tree-head' }, '设置'), h('div', { class: 'tree-list' },
      sections.map(([k, label]) => h('div', { class: 'tree-item' + (k === section ? ' selected' : ''), onclick: () => go('#/settings/' + k) }, label)))),
    content)), '设置');
  if (section === 'general') renderGeneralSettings(content);
  else if (section === 'compilers') renderCompilerSettings(content);
  else if (section === 'appearance') renderAppearanceSettings(content);
  else if (section === 'security') await renderSecuritySettings(content);
  else if (section === 'folder') await renderFolderSettings(content);
  checkJudgeStatus();
}

function saveButton(onClick) {
  return h('div', { class: 'row', style: { marginTop: '20px', maxWidth: '860px' } }, h('button', { class: 'primary', onclick: onClick }, '保存'));
}

function renderGeneralSettings(el) {
  const s = { ...S.settings };
  const num = (k, attrs = {}) => h('input', { type: 'number', value: s[k], ...attrs, oninput: (e) => { s[k] = +e.target.value; } });
  const text = (k) => h('input', { type: 'text', value: Array.isArray(s[k]) ? s[k].join(';') : s[k], oninput: (e) => { s[k] = e.target.value; } });
  el.appendChild(h('h2', null, '常规'));
  el.appendChild(h('div', { class: 'section-title' }, '默认值'));
  el.appendChild(h('div', { class: 'form-grid' },
    field('满分', num('defaultFullScore')),
    field('时限 (ms)', num('defaultTimeLimit')),
    field('内存 (MiB)', num('defaultMemoryLimit')),
    field('输入扩展名', text('defaultInputFileExtension')),
    field('输出扩展名', text('defaultOutputFileExtension')),
    field('识别输入扩展名', text('inputFileExtensions'), '分号分隔'),
    field('识别输出扩展名', text('outputFileExtensions'), '分号分隔')));
  el.appendChild(h('div', { class: 'section-title', style: { marginTop: '22px' } }, '评测'));
  el.appendChild(h('div', { class: 'form-grid' },
    field('编译时限 (ms)', num('compileTimeLimit')),
    field('校验器时限 (ms)', num('specialJudgeTimeLimit')),
    field('源程序上限 (KiB)', num('fileSizeLimit')),
    field('重测次数', num('rejudgeTimes')),
    field('额外时间比例', num('defaultExtraTimeRatio', { step: 0.05 })),
    field('评测线程', num('maxJudgingThreads', { min: 1 })),
    field('', h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: s.preventSleepWhileJudging, onchange: (e) => { s.preventSleepWhileJudging = e.target.checked; } }), '评测时阻止休眠'))));
  el.appendChild(saveButton(async () => {
    try { S.settings = await api('PUT', '/api/settings', s); toast('已保存'); } catch (e) { fail(e); }
  }));
}

function renderAppearanceSettings(el) {
  const s = S.settings;
  const names = { zh_CN: '简体中文', zh_TW: '繁體中文', en_US: 'English' };
  const lang = h('select', null, (s.languages || []).map((l) => h('option', { value: l, selected: l === s.uiLanguage }, names[l] || l)));
  const themeSel = h('select', null, s.colorThemes.map((n, i) => h('option', { value: i, selected: i === s.currentColorTheme }, n)));
  const modeSeg = h('div', { class: 'segmented' }, [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([k, label]) => h('div', {
    class: themeMode() === k ? 'active' : '', onclick: () => setThemeMode(k),
  }, label)));
  el.appendChild(h('h2', null, '外观'));
  el.appendChild(h('div', { class: 'form-grid' },
    field('显示模式', modeSeg, '仅对当前浏览器生效'),
    field('评测语言', lang, '用于 result.html、统计和评测信息'),
    field('成绩配色', themeSel)));
  el.appendChild(saveButton(async () => {
    try { S.settings = await api('PUT', '/api/settings', { uiLanguage: lang.value, currentColorTheme: +themeSel.value }); toast('已保存'); } catch (e) { fail(e); }
  }));
}

function renderCompilerSettings(el) {
  // CompilerSettings + AdvancedCompilerSettingsDialog + AddCompilerWizard
  const list = JSON.parse(JSON.stringify(S.compilers));
  let cur = list.length ? 0 : -1;
  const listBox = h('div');
  const editBox = h('div');
  const dirty = h('span', { class: 'muted small-text' });
  const markDirty = () => { dirty.textContent = '● 未保存'; };

  const drawList = () => {
    listBox.innerHTML = '';
    if (!list.length) { listBox.appendChild(h('div', { class: 'empty' }, '暂无编译器')); return; }
    listBox.appendChild(h('div', { class: 'segmented', style: { flexWrap: 'wrap' } }, list.map((c, i) => h('div', {
      class: i === cur ? 'active' : '', onclick: () => { cur = i; drawList(); drawEdit(); },
    }, c.compilerName || '(未命名)'))));
  };

  const drawEdit = () => {
    editBox.innerHTML = '';
    if (cur < 0) return;
    const c = list[cur];
    const text = (k, attrs = {}) => h('input', { type: 'text', value: c[k], style: { maxWidth: 'none' }, ...attrs, oninput: (e) => { c[k] = e.target.value; markDirty(); if (k === 'compilerName') drawListSoon(); } });
    const arr = (k) => h('input', { type: 'text', value: c[k].join(';'), oninput: (e) => { c[k] = e.target.value.split(/[;,\s]+/).filter(Boolean); markDirty(); } });
    const num = (k) => h('input', { type: 'number', step: 0.1, value: c[k], oninput: (e) => { c[k] = +e.target.value; markDirty(); } });
    const chk = (k, label) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: c[k], onchange: (e) => { c[k] = e.target.checked; markDirty(); } }), label);
    const typeSel = h('select', { onchange: (e) => { c.compilerType = +e.target.value; markDirty(); drawEdit(); } }, COMPILER_TYPES.map((t, i) => h('option', { value: i, selected: i === c.compilerType }, t)));
    const env = h('textarea', { rows: 2, class: 'mono', placeholder: 'PATH=C:\\mingw64\\bin', oninput: (e) => { c.environment = e.target.value.split('\n').map((x) => x.trim()).filter((x) => x.includes('=')); markDirty(); } });
    env.value = c.environment.join('\n');
    const confBody = h('tbody');
    const drawConf = () => {
      confBody.innerHTML = '';
      c.configurationNames.forEach((n, i) => confBody.appendChild(h('tr', null,
        h('td', { style: { width: '150px' } }, h('input', { type: 'text', value: n, disabled: i === 0, style: { width: '100%' }, oninput: (e) => { c.configurationNames[i] = e.target.value; markDirty(); } })),
        c.compilerType !== 2 ? h('td', null, h('input', { type: 'text', value: c.compilerArguments[i], style: { width: '100%' }, class: 'mono', oninput: (e) => { c.compilerArguments[i] = e.target.value; markDirty(); } })) : null,
        c.compilerType !== 0 ? h('td', null, h('input', { type: 'text', value: c.interpreterArguments[i], style: { width: '100%' }, class: 'mono', oninput: (e) => { c.interpreterArguments[i] = e.target.value; markDirty(); } })) : null,
        h('td', { style: { width: '40px' } }, i > 0 ? h('button', { class: 'small danger', onclick: () => { ['configurationNames', 'compilerArguments', 'interpreterArguments'].forEach((k) => c[k].splice(i, 1)); markDirty(); drawConf(); } }, '✕') : null))));
    };
    drawConf();
    editBox.appendChild(h('div', { class: 'section' },
      h('div', { class: 'form-grid' },
        field('名称', text('compilerName')),
        field('类型', typeSel),
        c.compilerType !== 2 ? field('编译器', text('compilerLocation', { class: 'mono' })) : null,
        c.compilerType !== 0 ? field('解释器', text('interpreterLocation', { class: 'mono' })) : null,
        field('源文件扩展名', arr('sourceExtensions'), '分号分隔'),
        c.compilerType === 1 ? field('字节码扩展名', arr('bytecodeExtensions')) : null,
        field('时限倍率', num('timeLimitRatio')),
        field('内存倍率', num('memoryLimitRatio')),
        field('', h('div', null, chk('disableMemoryLimitCheck', '不限制内存'), chk('interpreterAsWatcher', '解释器作为监视器'))),
        field('环境变量', env, '每行一个，如 PATH=…')),
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, '编译配置'),
        h('table', { class: 'grid boxed' }, h('tr', null, h('th', null, '名称'), c.compilerType !== 2 ? h('th', null, '编译参数') : null, c.compilerType !== 0 ? h('th', null, '解释器参数') : null, h('th', null, '')), confBody),
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', { class: 'small plain', onclick: () => { c.configurationNames.push('配置' + c.configurationNames.length); c.compilerArguments.push(c.compilerArguments[0] || ''); c.interpreterArguments.push(c.interpreterArguments[0] || ''); markDirty(); drawConf(); } }, '＋ 配置'),
          h('span', { class: 'hint' }, h('code', null, '%s'), ' 源程序名，', h('code', null, '%s.*'), ' 源文件'))),
      h('div', { class: 'row' },
        h('button', { class: 'small', disabled: cur === 0, onclick: () => { [list[cur - 1], list[cur]] = [list[cur], list[cur - 1]]; cur--; markDirty(); drawList(); drawEdit(); } }, '前移'),
        h('button', { class: 'small', disabled: cur === list.length - 1, onclick: () => { [list[cur + 1], list[cur]] = [list[cur], list[cur + 1]]; cur++; markDirty(); drawList(); drawEdit(); } }, '后移'),
        h('button', { class: 'small danger', onclick: () => { list.splice(cur, 1); cur = Math.min(cur, list.length - 1); markDirty(); drawList(); drawEdit(); } }, '删除此编译器'))));
  };
  const drawListSoon = debounce(drawList, 300);

  const addCustom = () => {
    list.push({ compilerType: 0, compilerName: '新编译器', compilerLocation: '', interpreterLocation: '', sourceExtensions: [], bytecodeExtensions: [], configurationNames: ['default'], compilerArguments: ['-o %s %s.*'], interpreterArguments: [''], timeLimitRatio: 1, memoryLimitRatio: 1, disableMemoryLimitCheck: false, interpreterAsWatcher: false, environment: [] });
    cur = list.length - 1; markDirty(); drawList(); drawEdit();
  };
  const addDetected = async () => {
    let det;
    try { det = await api('GET', '/api/compilers/detect'); } catch (e) { return fail(e); }
    if (!det.length) return toast('未在服务器 PATH 中找到编译器', 'error');
    const boxes = det.map((d) => ({ d, cb: h('input', { type: 'checkbox', checked: !list.some((c) => c.compilerName === d.compilerName) }) }));
    modal({
      title: '自动检测', body: h('table', { class: 'grid' },
        boxes.map(({ d, cb }) => h('tr', null, h('td', null, cb), h('td', null, h('b', null, d.compilerName)), h('td', { class: 'mono muted' }, d.compilerLocation || d.interpreterLocation)))),
      buttons: [{ label: '取消' }, {
        label: '添加', primary: true, onClick: () => {
          for (const { d, cb } of boxes) {
            if (!cb.checked) continue;
            const idx = list.findIndex((c) => c.compilerName === d.compilerName);
            if (idx >= 0) list[idx] = d; else list.push(d);
          }
          cur = list.length - 1; markDirty(); drawList(); drawEdit();
        },
      }],
    });
  };

  el.appendChild(h('div', { class: 'editor-head' }, h('h2', null, '编译器'), dirty,
    h('div', { class: 'right row' },
      h('button', { onclick: addDetected }, '自动检测'),
      h('button', { onclick: addCustom }, '自定义'),
      h('button', {
        class: 'primary', onclick: async () => {
          try { S.compilers = await api('PUT', '/api/compilers', list); dirty.textContent = ''; toast('已保存'); } catch (e) { fail(e); }
        },
      }, '保存'))));
  el.appendChild(listBox);
  el.appendChild(editBox);
  drawList();
  drawEdit();
}

async function renderSecuritySettings(el) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  el.appendChild(h('h2', null, '访问令牌'));
  if (S.status && S.status.tokenIsDefault) el.appendChild(h('p', { class: 'error-text small-text' }, '正在使用默认令牌 123456'));
  el.appendChild(h('div', { class: 'form-grid' },
    field('当前令牌', cur), field('新令牌', n1), field('确认新令牌', n2),
    field('', h('div', null, h('button', {
      class: 'primary', onclick: async () => {
        if (n1.value !== n2.value) return toast('两次输入不一致', 'error');
        try {
          const r = await api('PUT', '/api/auth/token', { currentToken: cur.value, newToken: n1.value });
          S.session = r.session; localStorage.setItem('lemonserver.session', r.session);
          S.status.tokenIsDefault = n1.value === '123456';
          cur.value = n1.value = n2.value = '';
          toast('令牌已修改');
        } catch (e) { fail(e); }
      },
    }, '修改')))));

  el.appendChild(h('h2', { style: { marginTop: '30px' } }, 'API Key'));
  let keys = [];
  try { keys = await api('GET', '/api/apikeys'); } catch (e) { fail(e); }
  const name = h('input', { type: 'text', placeholder: '名称' });
  const custom = h('input', { type: 'text', placeholder: '自定义 Key（可选）', style: { width: '260px' } });
  el.appendChild(h('div', { class: 'row', style: { marginBottom: '12px' } }, name, custom, h('button', {
    class: 'primary', onclick: async () => {
      try {
        const r = await api('POST', '/api/apikeys', { name: name.value, key: custom.value });
        modal({
          title: 'API Key 已创建',
          body: h('div', { style: { maxWidth: '520px' } }, h('div', { class: 'keybox mono' }, r.key), h('p', { class: 'hint' }, '关闭后无法再次查看，请妥善保存。')),
          buttons: [{ label: '复制', onClick: async () => { try { await navigator.clipboard.writeText(r.key); toast('已复制'); } catch (e) { toast('复制失败，请手动复制', 'error'); } return false; } }, { label: '完成', primary: true }],
          onClose: () => route(),
        });
      } catch (e) { fail(e); }
    },
  }, '创建')));
  el.appendChild(keys.length ? h('table', { class: 'grid boxed', style: { maxWidth: '860px' } }, h('tr', null, h('th', null, '名称'), h('th', null, 'Key'), h('th', null, '创建'), h('th', null, '最近使用'), h('th', null, '')),
    keys.map((k) => h('tr', null, h('td', null, k.name), h('td', { class: 'mono muted' }, k.preview), h('td', { class: 'muted' }, k.created), h('td', { class: 'muted' }, k.lastUsed || '—'),
      h('td', null, h('button', {
        class: 'small danger', onclick: async () => {
          if (!await confirmDlg(`删除 API Key “${k.name}”？`, '删除')) return;
          try { await api('DELETE', '/api/apikeys/' + k.id); route(); } catch (e) { fail(e); }
        },
      }, '删除'))))) : h('div', { class: 'muted' }, '暂无'));
  el.appendChild(h('p', { class: 'hint', style: { marginTop: '10px' } }, '请求时携带 ', h('code', null, 'Authorization: Bearer <key>'), ' · ', h('a', { href: '#/api' }, '接口文档')));
}

async function renderFolderSettings(el) {
  const setup = await api('GET', '/api/setup');
  const root = h('input', { type: 'text', value: setup.contestRoot, style: { maxWidth: 'none' } });
  el.appendChild(h('h2', null, '比赛位置'));
  el.appendChild(h('div', { class: 'form-grid' }, field('默认比赛位置', root, '服务器上的绝对路径'), field('配置文件', h('span', { class: 'mono muted' }, setup.configFile))));
  el.appendChild(saveButton(async () => {
    try { await api('PUT', '/api/setup', { contestRoot: root.value.trim() }); toast('已保存'); S.contest = null; } catch (e) { fail(e); }
  }));
}

// ------------------------------------------------------------------------------------------------
// API documentation
// ------------------------------------------------------------------------------------------------
function renderApiDoc() {
  const C = '/api/contests/{name}';
  const rows = [
    ['认证', ''],
    ['GET /api/auth/status', '服务器状态（无需认证）'],
    ['POST /api/auth/login', '{"token"} → {"session"}'],
    ['PUT /api/auth/token', '{"currentToken","newToken"}（仅网页会话）'],
    ['GET · POST /api/apikeys', '列出 / 创建 {"name","key"?}（仅网页会话）'],
    ['DELETE /api/apikeys/{id}', '删除 API Key（仅网页会话）'],
    ['设置', ''],
    ['GET · PUT /api/setup', '{"contestRoot"}'],
    ['GET · PUT /api/settings', '评测设置'],
    ['GET · PUT /api/compilers', '编译器（PUT 完整数组）'],
    ['GET /api/compilers/detect', '检测服务器上的编译器'],
    ['比赛', ''],
    ['GET /api/contests', '比赛列表'],
    ['POST /api/contests', '{"name","title"?} 新建'],
    ['GET · PUT · DELETE ' + C, '打开（试题与成绩）/ 修改 {"title"?,"startTime"?,"endTime"?,"downZip"?} / 删除'],
    ['比赛时间', 'startTime、endTime 为毫秒时间戳或 ISO 8601，null 表示不设置；比赛中（running）不返回成绩，详细结果、源程序、导出、统计、source 下的文件返回 403'],
    ['GET · PUT · DELETE ' + C + '/down-zip', '下载 / 上传（请求体为 zip，保存为 down.zip）/ 清除（&deleteFile=1 同时删除文件）；PUT ' + C + ' {"downZip":"路径"} 指定已有文件'],
    ['POST /api/import-contest?name=&overwrite=1', '请求体为比赛 zip（含 .cdf，可带一层顶层文件夹），导入为新比赛'],
    ['PUT /api/import-contest/file?id=&path=', '逐个上传比赛文件（id 自定，4–64 位字母数字）'],
    ['POST /api/import-contest/finish?id=&name=&overwrite=1', '完成逐个上传的导入；DELETE /api/import-contest?id= 放弃'],
    ['POST ' + C + '/save', '保存 .cdf'],
    ['试题', ''],
    ['POST ' + C + '/tasks', '新建试题'],
    ['GET · PUT · DELETE ' + C + '/tasks/{i}', 'PUT 只需传要改的字段，testCases 为完整数组'],
    ['POST ' + C + '/tasks/{i}/move', '{"direction":"up"|"down"}'],
    ['GET ' + C + '/scan-tasks', '扫描 data 中的新试题'],
    ['POST ' + C + '/add-tasks', '{"tasks":[{"name","fullScore","timeLimit","memoryLimit"}]}，省略则全部添加'],
    ['选手与评测', ''],
    ['POST ' + C + '/refresh', '刷新选手'],
    ['GET · DELETE ' + C + '/contestants/{who}', '详细结果 / 删除（?deleteFiles=1）'],
    ['GET ' + C + '/contestants/{who}/source/{i}', '源程序'],
    ['POST ' + C + '/cleanup', '{"backup":true} 整理文件'],
    ['POST ' + C + '/judge', '{"mode":"all|unjudged|grey|magenta|selected","items":[{"contestant","tasks":[0]}]}'],
    ['GET ' + C + '/judge/status?since=N', '进度与 id > N 的事件'],
    ['POST ' + C + '/judge/stop', '停止评测'],
    ['GET ' + C + '/export?format=html|htm|csv', '导出结果；&save=1 保存到比赛文件夹'],
    ['GET ' + C + '/statistics', '统计 HTML'],
    ['文件（root = data | source | contest）', ''],
    ['GET ' + C + '/files?root=&path=&recursive=', '列目录'],
    ['GET ' + C + '/files/download?root=&path=', '下载（文件夹为 zip，&text=1 返回 JSON 文本）'],
    ['PUT ' + C + '/files/upload?root=&path=', '请求体为文件内容'],
    ['PUT ' + C + '/files/text', '{"root","path","content","encoding","eol","expectedModifiedMs"?} 保存文本（< 100 KiB）'],
    ['POST ' + C + '/files/unzip?root=&path=&stripTop=1', '请求体为 zip'],
    ['POST ' + C + '/files/mkdir · delete · rename', '{"root","path"} · {"root","paths"} · {"root","from","to"}'],
    ['POST ' + C + '/files/move · copy', '{"root","paths":[...],"to":"dir","overwrite"?}'],
    ['Testlib for Lemons', ''],
    ['POST ' + C + '/files/compile', '{"root","path","output"?,"compiler"?,"arguments"?,"bundledTestlib"?:true} 在服务器上编译，返回编译输出'],
    ['GET /api/testlib/templates', '内置模板列表（checkers/wcmp.cpp 等）'],
    ['POST ' + C + '/files/template', '{"root","path":"目录","template","name"?} 从模板创建文件'],
    ['GET /api/testlib/testlib.h', '下载 testlib.h'],
  ];
  const o = location.origin;
  shell(h('div', { class: 'page' }, h('div', { class: 'narrow' }, h('div', { class: 'card' },
    h('h2', null, 'REST API'),
    h('p', { class: 'muted', style: { marginTop: 0 } }, '认证：', h('code', null, 'Authorization: Bearer <key>'), ' 或 ', h('code', null, 'X-API-Key'), ' 或 ', h('code', null, '?access_token='), '。错误返回 ', h('code', null, '{"error"}'), '。'),
    h('pre', { class: 'source-view', style: { minWidth: 0 } },
      `K="Authorization: Bearer lsk_xxx"; C=${o}/api/contests/NOIP2026\ncurl -H "$K" -d '{"name":"NOIP2026"}' ${o}/api/contests\ncurl -H "$K" --data-binary @data.zip "$C/files/unzip?root=data&stripTop=1"\ncurl -H "$K" -X POST $C/add-tasks\ncurl -H "$K" --data-binary @source.zip "$C/files/unzip?root=source&stripTop=1"\ncurl -H "$K" -X POST $C/refresh\ncurl -H "$K" -d '{"mode":"all"}' $C/judge\ncurl -H "$K" "$C/judge/status"\ncurl -H "$K" -o result.html "$C/export?format=html"`),
    h('table', { class: 'grid api-doc', style: { marginTop: '16px' } },
      rows.map(([a, b]) => (b ? h('tr', null, h('td', null, a), h('td', { class: 'muted' }, b)) : h('tr', null, h('th', { colspan: 2 }, a)))))))), 'API');
}

boot();
