/**
 * 进项发票台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   invoice.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   invoice.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   invoice.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   invoice.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';

export const invoice = makeModule({
  key: 'invoice',
  name: '进项发票台账',
  entity: '发票记录',
  periodField: '会计期间',
  sortField: '会计期间',
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '发票类型', type: 'select', options: ['增值税专用发票', '增值税普通发票', '其他'] },
    { name: '发票号码', type: 'text' },
    { name: '开票方', type: 'text' },
    { name: '开票日期', type: 'date' },
    { name: '金额(元)', type: 'number' },
    { name: '税额(元)', type: 'number' },
    { name: '认证状态', type: 'select', options: ['已认证', '待认证', '待取得'] },
    { name: '关联凭证字号', type: 'text' },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选与分组 ———— */
invoice.filters = [{ el: 'fCat', field: '认证状态', all: '全部状态' }];
invoice.groupBy = '认证状态';
