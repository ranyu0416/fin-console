/**
 * 研发费用台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   rnd.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   rnd.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   rnd.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   rnd.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';
import { amt } from '../core/format.js';
import { esc } from '../core/text.js';

export const rnd = makeModule({
  key: 'rnd',
  name: '研发费用台账',
  entity: '研发费用记录',
  periodField: '会计期间',
  sortField: '会计期间',
  /* 工具栏两个下拉：课题选项从数据里自动取（distinct），大类用 schema 里的固定选项 */
  filters: [
    { el: 'fCat', field: '研发项目', all: '全部课题', distinct: true },
    { el: 'fStatus', field: '费用大类', all: '全部大类' },
  ],
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '项目', type: 'text' },
    { name: '费用大类', type: 'select', options: ['人员人工', '直接投入', '折旧摊销', '设计试验', '其他'] },
    { name: '科目代码', type: 'text' },
    { name: '科目名称', type: 'text' },
    { name: '凭证字号', type: 'text' },
    { name: '凭证日期', type: 'date' },
    { name: '研发项目', type: 'text' },
    { name: '制单人', type: 'text' },
    { name: '单据', type: 'text' },
    { name: '摘要', type: 'text' },
    { name: '金额(元)', type: 'number' },
    { name: '备注', type: 'text' },
  ],
  /* 课题分布：随当前筛选联动（选中某大类后，占比按筛选后的范围重新计算） */
  groupStats: function (vis) {
    var total = 0;
    var g = {};
    vis.forEach(function (r) {
      var k = r['研发项目'] || '（未归集课题）';
      if (!g[k]) g[k] = { n: 0, amt: 0, byCat: {} };
      var o = g[k];
      var v = Number(r['金额(元)']) || 0;
      o.n += 1; o.amt += v; total += v;
      var cat = r['费用大类'] || '其他';
      o.byCat[cat] = (o.byCat[cat] || 0) + v;
    });
    function pct(x) { return total ? ((x / total) * 100).toFixed(1) + '%' : '—'; }
    var body = Object.keys(g).sort(function (a, b) { return g[b].amt - g[a].amt; }).map(function (k) {
      var o = g[k];
      var comp = Object.keys(o.byCat).sort(function (a, b) { return o.byCat[b] - o.byCat[a]; })
        .map(function (c) { return esc(c) + ' ' + amt(o.byCat[c]) + '（' + pct(o.byCat[c]) + '）'; })
        .join('；');
      return '<tr><td>' + esc(k) + '</td><td>' + o.n + '</td><td class="num">' + amt(o.amt) + '</td><td class="num">' + pct(o.amt) + '</td><td>' + comp + '</td></tr>';
    }).join('');
    body += '<tr><td><b>合计</b></td><td>' + vis.length + '</td><td class="num">' + amt(total) + '</td><td class="num">' + (total ? '100%' : '—') + '</td><td>—</td></tr>';
    return '<table><thead><tr><th>研发课题</th><th>笔数</th><th class="num">净额</th><th class="num">占比</th><th>费用大类构成</th></tr></thead><tbody>' + body + '</tbody></table>';
  },
});

/* —— 系统整理（2026-08-30）：分组口径 ———— */
rnd.groupBy = '研发项目';
