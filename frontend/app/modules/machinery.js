/**
 * 机械租赁台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   machinery.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   machinery.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   machinery.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   machinery.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';
import { amt } from '../core/format.js';
import { esc } from '../core/text.js';

export const machinery = makeModule({
  key: 'machinery',
  name: '机械租赁台账',
  entity: '机械租赁记录',
  periodField: '会计期间',
  sortField: '会计期间',
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '出租单位', type: 'text', required: true },
    { name: '设备/机具', type: 'text' },
    { name: '计价说明', type: 'text' },
    { name: '不含税计价(元)', type: 'number' },
    { name: '进项税额(元)', type: 'number' },
    { name: '含税合计(元)', type: 'number' },
    { name: '凭证字号', type: 'text' },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选与按出租单位汇总 ———— */
machinery.filters = [{ el: 'fCat', field: '出租单位', all: '全部出租单位', distinct: true }];
machinery.groupBy = '出租单位';
machinery.groupStats = function (vis) {
  var g = {};
  vis.forEach(function (r) {
    var k = r['出租单位'] || '（待补）';
    if (!g[k]) g[k] = { n: 0, v: 0 };
    var o = g[k]; o.n += 1; o.v += Number(r['不含税计价(元)']) || 0;
  });
  var body = Object.keys(g).sort(function (a, b) { return g[b].v - g[a].v; }).map(function (k) {
    var o = g[k];
    return '<tr><td>' + esc(k) + '</td><td>' + o.n + '</td><td class="num">' + amt(o.v) + '</td></tr>';
  }).join('');
  body += '<tr><td><b>合计（含红字冲销）</b></td><td>' + vis.length + '</td><td class="num">' + amt(Object.keys(g).reduce(function (a, k) { return a + g[k].v; }, 0)) + '</td></tr>';
  return '<table><thead><tr><th>出租单位</th><th>笔数</th><th class="num">不含税计价</th></tr></thead><tbody>' + body + '</tbody></table>';
};
