/**
 * 人工费台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   labor.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   labor.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   labor.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   labor.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';
import { amt } from '../core/format.js';
import { esc } from '../core/text.js';

export const labor = makeModule({
  key: 'labor',
  name: '人工费台账',
  entity: '人工费记录',
  periodField: '会计期间',
  sortField: '会计期间',
  filters: [{ el: 'fCat', field: '费用性质', all: '全部性质' }],
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '项目', type: 'text' },
    { name: '费用性质', type: 'select', options: ['职工薪酬', '社保公积金', '劳务费', '其他'] },
    { name: '科目代码', type: 'text' },
    { name: '科目名称', type: 'text' },
    { name: '凭证字号', type: 'text' },
    { name: '凭证日期', type: 'date' },
    { name: '制单人', type: 'text' },
    { name: '单据', type: 'text' },
    { name: '摘要', type: 'text' },
    { name: '借方发生(元)', type: 'number' },
    { name: '贷方发生(元)', type: 'number' },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选与按性质汇总 ———— */
labor.groupBy = '费用性质';
labor.groupStats = function (vis) {
  var g = {};
  vis.forEach(function (r) {
    var k = r['费用性质'] || '（未分类）';
    if (!g[k]) g[k] = { n: 0, d: 0, c: 0 };
    var o = g[k]; o.n += 1;
    o.d += Number(r['借方发生(元)']) || 0; o.c += Number(r['贷方发生(元)']) || 0;
  });
  var tot = { n: vis.length, d: 0, c: 0 };
  var body = Object.keys(g).sort(function (a, b) { return g[b].d - g[a].d; }).map(function (k) {
    var o = g[k]; tot.d += o.d; tot.c += o.c;
    return '<tr><td>' + esc(k) + '</td><td>' + o.n + '</td><td class="num">' + amt(o.d) + '</td><td class="num">' + amt(o.c) + '</td></tr>';
  }).join('');
  body += '<tr><td><b>合计</b></td><td>' + tot.n + '</td><td class="num">' + amt(tot.d) + '</td><td class="num">' + amt(tot.c) + '</td></tr>';
  return '<table><thead><tr><th>费用性质</th><th>笔数</th><th class="num">本期借方</th><th class="num">本期贷方</th></tr></thead><tbody>' + body + '</tbody></table>';
};
