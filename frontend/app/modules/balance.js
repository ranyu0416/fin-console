/**
 * 科目余额表 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   balance.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   balance.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   balance.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   balance.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';
import { amt, dateStr } from '../core/format.js';
import { viewYm } from '../period.js';

export const balance = makeModule({
  key: 'balance',
  name: '科目余额表',
  entity: '余额记录',
  periodField: '会计期间',
  sortField: '科目代码',
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '科目代码', type: 'text', required: true },
    { name: '科目名称', type: 'text', required: true },
    { name: '期初借方(元)', type: 'number' },
    { name: '期初贷方(元)', type: 'number' },
    { name: '本期借方发生(元)', type: 'number' },
    { name: '本期贷方发生(元)', type: 'number' },
    { name: '期末借方余额(元)', type: 'number' },
    { name: '期末贷方余额(元)', type: 'number' },
    { name: '备注', type: 'text' },
  ],
});

/*
 * 试算平衡检查：按当前视图期间汇总三段数——期初余额、本期发生额、期末余额，
 * 借方合计与贷方合计必须相等。会计上这是「有借必有贷、借贷必相等」的硬约束，
 * 少录一个科目的半边、或金额贴错列，都会在这里现形。
 * 单行不需要检查（一行内借贷由业务决定），所以只在期间汇总层面验。
 */
balance.attention = function (rows) {
  var ym = viewYm();
  var vis = rows.filter(function (r) { return dateStr(r['会计期间']).slice(0, 7) === ym; });
  if (!vis.length) return [];
  var stages = [
    ['期初借方(元)', '期初贷方(元)', '期初余额'],
    ['本期借方发生(元)', '本期贷方发生(元)', '本期发生额'],
    ['期末借方余额(元)', '期末贷方余额(元)', '期末余额'],
  ];
  var items = [];
  stages.forEach(function (st) {
    var d = 0, c = 0;
    vis.forEach(function (r) {
      d += Number(r[st[0]]) || 0;
      c += Number(r[st[1]]) || 0;
    });
    d = Math.round(d * 100) / 100;
    c = Math.round(c * 100) / 100;
    if (Math.abs(d - c) > 0.01) {
      items.push({
        row: null, level: 'check', action: null,
        text: ym + ' ' + st[2] + '借贷不平衡：借方合计 ' + amt(d) + ' ≠ 贷方合计 ' + amt(c) +
          '（差 ' + amt(Math.abs(d - c)) + '），请核对「' + st[0] + ' / ' + st[1] + '」两列',
      });
    }
  });
  return items;
};
