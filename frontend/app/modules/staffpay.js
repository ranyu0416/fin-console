/**
 * 劳务工资台账 —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   staffpay.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   staffpay.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   staffpay.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   staffpay.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';

export const staffpay = makeModule({
  key: 'staffpay',
  name: '劳务工资台账',
  entity: '劳务工资记录',
  periodField: '会计期间',
  sortField: '会计期间',
  fields: [
    { name: '会计期间', type: 'date', required: true },
    { name: '劳务队/班组', type: 'text', required: true },
    { name: '在册人数', type: 'number' },
    { name: '应发工资(元)', type: 'number' },
    { name: '专户代发(元)', type: 'number' },
    { name: '其他支付(元)', type: 'number' },
    { name: '备注', type: 'text' },
  ],
});

/* —— 系统整理（2026-08-30）：筛选 ———— */
staffpay.filters = [{ el: 'fCat', field: '劳务队/班组', all: '全部班组', distinct: true }];
