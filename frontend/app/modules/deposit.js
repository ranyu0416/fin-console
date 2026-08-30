/**
 * 保证金台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   deposit.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   deposit.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   deposit.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   deposit.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule, flowCheckAttention } from './generic.js';

export const deposit = makeModule({
  key: 'deposit',
  name: '保证金台账',
  entity: '保证金记录',
  periodField: '会计期间',
  sortField: '会计期间',
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '保证金类别', type: 'select', options: ['投标保证金', '履约保证金', '劳务工资保证金', '其他保证金'] },
    { name: '缴纳对象', type: 'text' },
    { name: '缴纳金额(元)', type: 'number' },
    { name: '已退还(元)', type: 'number' },
    { name: '余额(元)', type: 'number' },
    { name: '到期日', type: 'date' },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选 ———— */
deposit.filters = [{ el: 'fCat', field: '保证金类别', all: '全部类别' }];

/* —— 勾稽提醒：缴纳金额 − 已退还 应等于余额 ———— */
deposit.attention = flowCheckAttention({
  periodField: '会计期间',
  entity: ['缴纳对象'],
  parts: [
    { field: '缴纳金额(元)', sign: 1 },
    { field: '已退还(元)', sign: -1 },
  ],
  close: '余额(元)',
  label: '余额勾稽不符（缴纳 − 已退还 ≠ 余额）',
});
