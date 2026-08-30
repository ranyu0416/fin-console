/**
 * 合同台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   contract.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   contract.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   contract.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   contract.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';

export const contract = makeModule({
  key: 'contract',
  name: '合同台账',
  entity: '合同记录',
  periodField: null,
  sortField: '签订日期',
  fields: [
    { name: '合同编号', type: 'text' },
    { name: '合同名称', type: 'text', required: true },
    { name: '合同类别', type: 'select', options: ['劳务外包', '专业外包', '材料采购', '机械租赁', '其他'] },
    { name: '对方单位', type: 'text' },
    { name: '签订日期', type: 'date' },
    { name: '合同金额(元)', type: 'number' },
    { name: '变更后金额(元)', type: 'number' },
    { name: '累计计价(元)', type: 'number' },
    { name: '累计开票(元)', type: 'number' },
    { name: '累计付款(元)', type: 'number' },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选 ———— */
contract.filters = [
  { el: 'fCat', field: '合同类别', all: '全部类别' },
  { el: 'fStatus', field: '对方单位', all: '全部对方单位', distinct: true },
];
