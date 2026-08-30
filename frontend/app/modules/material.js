/**
 * 材料收发存台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   material.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   material.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   material.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   material.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule, flowCheckAttention } from './generic.js';

export const material = makeModule({
  key: 'material',
  name: '材料收发存台账',
  entity: '收发存记录',
  periodField: '会计期间',
  sortField: '会计期间',
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '材料类别', type: 'text', required: true },
    { name: '科目代码', type: 'text' },
    { name: '期初结存(元)', type: 'number' },
    { name: '本期入库(元)', type: 'number' },
    { name: '本期出库(元)', type: 'number' },
    { name: '期末结存(元)', type: 'number' },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选 ———— */
material.filters = [{ el: 'fCat', field: '材料类别', all: '全部类别', distinct: true }];

/* —— 勾稽提醒：期初结存 + 本期入库 − 本期出库 应等于期末结存 ———— */
material.attention = flowCheckAttention({
  periodField: '会计期间',
  entity: ['材料类别'],
  parts: [
    { field: '期初结存(元)', sign: 1 },
    { field: '本期入库(元)', sign: 1 },
    { field: '本期出库(元)', sign: -1 },
  ],
  close: '期末结存(元)',
  label: '期末结存勾稽不符',
});
