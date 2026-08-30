/** 数值与日期格式化。纯函数，不碰 DOM。 */

/** 四舍五入到分 */
export function r2(n) {
  n = Number(n);
  if (isNaN(n)) n = 0;
  return Math.round(n * 100) / 100;
}

/** 随机整数（仅示例数据用） */
export function ri(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

/** 随机取一个（仅示例数据用） */
export function pick(a) { return a[ri(0, a.length - 1)]; }

/** 带币种符号的金额 */
export function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '¥0.00';
  return '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** fmt 的别名，保留历史调用点 */
export const fmt2 = fmt;

/** 纯数字金额（表格用，不带符号） */
export function amt(n) {
  if (n === null || n === undefined || isNaN(n)) n = 0;
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 取 YYYY-MM-DD */
export function dateStr(v) {
  if (!v) return '';
  return String(v).slice(0, 10);
}

/** Date -> YYYY-MM */
export function ymStr(pe) {
  return pe.getFullYear() + '-' + ('0' + (pe.getMonth() + 1)).slice(-2);
}

/** Date -> YYYY年MM月 */
export function ymCn(pe) {
  return pe.getFullYear() + '年' + ('0' + (pe.getMonth() + 1)).slice(-2) + '月';
}

/** 任意日期值 -> YYYY年MM月 */
export function ymLabel(v) {
  const s = dateStr(v).slice(0, 7);
  return s ? s.slice(0, 4) + '年' + s.slice(5, 7) + '月' : '';
}
