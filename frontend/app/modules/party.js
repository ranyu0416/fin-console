/**
 * 往来单位台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   party.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   party.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   party.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   party.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';
import { amt, dateStr } from '../core/format.js';
import { esc } from '../core/text.js';
import { viewYm } from '../period.js';

export const party = makeModule({
  key: 'party',
  name: '往来单位台账',
  entity: '往来记录',
  periodField: '会计期间',
  sortField: '会计期间',
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '往来单位', type: 'text', required: true },
    { name: '往来性质', type: 'select', options: ['应付购货款', '应付劳务款', '应付结算款', '应付固定资产款', '预付购货款', '应收账款', '保证金', '其他'] },
    { name: '科目代码', type: 'text' },
    { name: '期初余额(元)', type: 'number' },
    { name: '本期借方发生(元)', type: 'number' },
    { name: '本期贷方发生(元)', type: 'number' },
    { name: '期末余额(元)', type: 'number' },
    { name: '余额方向', type: 'select', options: ['借', '贷', '平'] },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选与按性质汇总 ———— */
party.filters = [{ el: 'fCat', field: '往来性质', all: '全部性质' }];
party.groupBy = '往来性质';

/*
 * 勾稽提醒（方向感知）：余额方向决定算式——
 *   借方余额：期初 + 本期借方 − 本期贷方 = 期末
 *   贷方余额：期初 + 本期贷方 − 本期借方 = 期末
 * 「平」与未填方向的行无法判断，跳过不打扰。整体逻辑与 flowCheckAttention 相同，
 * 但期望值依赖行内另一字段，所以单独写而不套工厂。
 */
party.attention = function (rows) {
  var ym = viewYm();
  var items = [];
  rows.forEach(function (r) {
    if (dateStr(r['会计期间']).slice(0, 7) !== ym) return;
    var d = r['余额方向'];
    if (d !== '借' && d !== '贷') return;
    var open = Number(r['期初余额(元)']) || 0;
    var dr = Number(r['本期借方发生(元)']) || 0;
    var cr = Number(r['本期贷方发生(元)']) || 0;
    var close = Math.round((Number(r['期末余额(元)']) || 0) * 100) / 100;
    var expect = Math.round((d === '借' ? open + dr - cr : open + cr - dr) * 100) / 100;
    if (Math.abs(expect - close) <= 0.01) return;
    items.push({
      row: r, level: 'check', action: null,
      text: '「' + String(r['往来单位'] || '') + '」' + ym + ' 期末余额勾稽不符（' + d + ' 方）：' +
        '应为 ' + amt(expect) + '，实为 ' + amt(close) + '（差 ' + amt(close - expect) + '）',
    });
  });
  if (items.length > 6) {
    var rest = items.length - 6;
    items = items.slice(0, 6);
    items.push({ row: null, level: 'check', action: null, text: '另有 ' + rest + ' 条勾稽不符，未逐条列出' });
  }
  return items;
};
party.groupStats = function (vis) {
  var g = {};
  vis.forEach(function (r) {
    var k = r['往来性质'] || '（未分类）';
    if (!g[k]) g[k] = { n: 0, d: 0, c: 0 };
    var o = g[k]; o.n += 1;
    o.d += Number(r['本期借方发生(元)']) || 0; o.c += Number(r['本期贷方发生(元)']) || 0;
  });
  var body = Object.keys(g).sort(function (a, b) { return g[b].c - g[a].c; }).map(function (k) {
    var o = g[k];
    return '<tr><td>' + esc(k) + '</td><td>' + o.n + '</td><td class="num">' + amt(o.d) + '</td><td class="num">' + amt(o.c) + '</td></tr>';
  }).join('');
  body += '<tr><td><b>合计</b></td><td>' + vis.length + '</td><td class="num">' + amt(Object.keys(g).reduce(function (a, k) { return a + g[k].d; }, 0)) + '</td><td class="num">' + amt(Object.keys(g).reduce(function (a, k) { return a + g[k].c; }, 0)) + '</td></tr>';
  return '<table><thead><tr><th>往来性质</th><th>家次</th><th class="num">本期借方</th><th class="num">本期贷方</th></tr></thead><tbody>' + body + '</tbody></table>';
};
