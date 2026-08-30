/**
 * 周转物资台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   consumable.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   consumable.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   consumable.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   consumable.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';

export const consumable = makeModule({
  key: 'consumable',
  name: '周转物资台账',
  entity: '周转物资记录',
  periodField: '会计期间',
  sortField: '会计期间',
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '物资名称', type: 'text', required: true },
    { name: '规格型号', type: 'text' },
    { name: '数量', type: 'number' },
    { name: '原值(元)', type: 'number' },
    { name: '摊销方法', type: 'select', options: ['分次摊销', '一次性摊销'] },
    { name: '本期摊销(元)', type: 'number' },
    { name: '在用状态', type: 'select', options: ['在库', '在用', '已摊完', '已报废'] },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选 ———— */
consumable.filters = [
  { el: 'fCat', field: '在用状态', all: '全部状态' },
  { el: 'fStatus', field: '摊销方法', all: '全部方法' },
];
