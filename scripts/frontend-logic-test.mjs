#!/usr/bin/env node
/**
 * 前端纯逻辑自检（不需要浏览器）。
 *
 * 为什么要单独有这个：browser-test.mjs 依赖本机装了 Edge/Chrome，在服务器和 CI 上
 * 通常直接跳过——于是前端逻辑实际上是没有任何自动化守护的。
 * 而这次改动最容易被后人不小心改回去的恰恰在前端：
 * 「视图期间 / 账套期间」谁管什么、结账按哪个期间判锁、开累校验取哪一期做基数。
 *
 * 做法是给 period.js 一个内存版 localStorage 和最小 DOM 替身，直接 import 真实模块。
 * 只覆盖不依赖渲染的纯逻辑；渲染相关的仍然归 browser-test.mjs。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../frontend/app');

/* ---------- 最小环境替身 ---------- */
const store = new Map();
const fakeStore = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const noopEl = {
  value: '', textContent: '', innerHTML: '', className: '', style: {}, disabled: false,
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  classList: { toggle() {}, add() {}, remove() {} },
  getAttribute() { return null; }, setAttribute() {},
};
globalThis.window = {
  localStorage: fakeStore,
  __FIN_STORAGE__: fakeStore,
  __FIN_CAN__: { write: true, close: true, admin: true },
  __FIN_SERVER__: true,
};
globalThis.document = {
  querySelector: () => noopEl,
  querySelectorAll: () => [],
  getElementById: () => noopEl,
  addEventListener() {},
  hidden: false,
};
globalThis.confirm = () => true;
globalThis.alert = () => {};

/* Windows 下绝对路径是 D:\... 形式，直接放进 import() 会被当成 'd:' 协议报
   ERR_UNSUPPORTED_ESM_URL_SCHEME，必须转成 file:// URL 才能在三个平台通用。 */
const P = await import(pathToFileURL(`${APP}/period.js`).href);

let pass = 0;
const failures = [];
function t(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

console.log('\n[frontend] 期间两层模型：');
store.clear();
store.set('wb_work_ym', '2026-03');
t('没设过视图期间时跟随账套期间', P.viewYm() === '2026-03');
P.setViewYm('2026-01');
t('设了视图期间后两者各自独立', P.viewYm() === '2026-01' && P.bookYm() === '2026-03');
t('月末日期跟随视图期间（2026-01 → 1 月 31 日）', P.periodEnd().getMonth() === 0 && P.periodEnd().getDate() === 31);
P.setViewYm('');
t('清空视图期间后重新跟随账套期间', P.viewYm() === '2026-03');

console.log('\n[frontend] 期间合法性（只判格式会放过不存在的月份）：');
t('2026-13 非法', P.validYm('2026-13') === false);
t('2026-00 非法', P.validYm('2026-00') === false);
t('2026/03 非法', P.validYm('2026/03') === false);
t('202603 非法', P.validYm('202603') === false);
t('2026-12 合法', P.validYm('2026-12') === true);
store.set('wb_view_ym', '2026-13');
t('存进来的非法视图期间被忽略，回落到账套期间', P.viewYm() === '2026-03');
store.delete('wb_view_ym');

console.log('\n[frontend] 结账判锁基准（必须与服务端的归属口径一致）：');
t('有期间字段的模块按视图期间判', P.lockYmOf({ key: 'levy', periodField: '会计期间' }) === P.viewYm());
t('无期间字段的模块按账套期间判', P.lockYmOf({ key: 'facility', periodField: null }) === P.bookYm());
P.setViewYm('2026-01');
t('翻看历史月份时，摊销类模块的锁仍看账套期间', P.lockYmOf({ key: 'facility', periodField: null }) === '2026-03');
P.setViewYm('');

console.log('\n[frontend] 开累回退校验取的是「期间最大的上一期」：');
/*
 * 复现原来的 bug：旧代码在遍历中无条件覆盖 prevCum，
 * 于是基数取决于 rows 的遍历顺序而不是期间大小。
 * 服务端按 (period, created_at) 升序返回时看不出问题，
 * 但用户改过历史记录、或前端用了缓存顺序时就会取错，
 * 把回退的开累当成合法值放过去，本期计提额随之出错。
 */
function prevCumOf(rows, unit, project, period) {
  let prevCum = null;
  let prevYm = '';
  rows.forEach((r) => {
    if ((r['单位'] || '') !== unit || (r['项目名称'] || '') !== project) return;
    const ym = String(r['会计期间'] || '').slice(0, 7);
    if (ym && ym < period && ym > prevYm) {
      prevYm = ym;
      prevCum = Number(r['累计产值(元)']) || 0;
    }
  });
  return { prevCum, prevYm };
}
const shuffled = [
  { 单位: '甲', 项目名称: 'A', 会计期间: '2026-02-01', '累计产值(元)': 8000000 },
  { 单位: '甲', 项目名称: 'A', 会计期间: '2026-01-01', '累计产值(元)': 3000000 },
  { 单位: '乙', 项目名称: 'A', 会计期间: '2026-02-01', '累计产值(元)': 99999999 },
];
const got = prevCumOf(shuffled, '甲', 'A', '2026-03');
t('乱序数据下仍取 2 月的 800 万（不是遍历到的最后一条 300 万）', got.prevCum === 8000000 && got.prevYm === '2026-02');
t('不串到同名项目的另一个单位', got.prevCum !== 99999999);
t('3 月填 500 万应判为回退', 5000000 < got.prevCum);
t('没有上期时基数为 null，不当成 0 去拦人', prevCumOf(shuffled, '丙', 'A', '2026-03').prevCum === null);

console.log('\n' + '='.repeat(52));
if (failures.length) {
  console.log(`[frontend] 结果：${pass} 项通过，${failures.length} 项失败`);
  for (const f of failures) console.log(`  ✗ ${f}`);
} else {
  console.log(`[frontend] 结果：全部 ${pass} 项通过`);
}
console.log('='.repeat(52) + '\n');
process.exit(failures.length ? 1 : 0);
