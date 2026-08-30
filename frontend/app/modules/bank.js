/**
 * 银行资金台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   bank.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   bank.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   bank.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   bank.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule, flowCheckAttention } from './generic.js';

export const bank = makeModule({
  key: 'bank',
  name: '银行资金台账',
  entity: '资金记录',
  periodField: '会计期间',
  sortField: '会计期间',
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '账户', type: 'text' },
    { name: '期初余额(元)', type: 'number' },
    { name: '本期收入(元)', type: 'number' },
    { name: '本期支出(元)', type: 'number' },
    { name: '期末余额(元)', type: 'number' },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选 ———— */
bank.filters = [{ el: 'fCat', field: '账户', all: '全部账户', distinct: true }];

/* —— 勾稽提醒：期初 + 本期收入 − 本期支出 应等于期末余额 ———— */
bank.attention = flowCheckAttention({
  periodField: '会计期间',
  entity: ['账户'],
  parts: [
    { field: '期初余额(元)', sign: 1 },
    { field: '本期收入(元)', sign: 1 },
    { field: '本期支出(元)', sign: -1 },
  ],
  close: '期末余额(元)',
  label: '期末余额勾稽不符',
});
