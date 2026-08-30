import { $, toast } from './core/dom.js';
import { dateStr, ymCn } from './core/format.js';
import { cur } from './core/state.js';
import { esc, toCN, todayStr } from './core/text.js';
import { calcsOf, curRows, optText } from './engine.js';
import { periodEnd } from './period.js';
import { doPrint, printUnitName, signRow } from './print.js';

/* ================= 通用打印：设施摊销 ================= */
/* 月度摊销表：按类别分组小计，附成本对象汇总 */
export function printTfaMonthly(rows, calcs){
  if(!rows.length){ toast('暂无数据可打印'); return; }
  var pe = periodEnd();
  var cols = 14;   // 序号/单位/类别/名称/成本对象/入账/启用/原值/残值率/净残值/期限/本期月/开累月/截至上期/本月/开累/净值 → 见表头实际列数
  function rowHtml(r, i){
    var c = calcs[r._id];
    return '<tr><td>' + (i + 1) + '</td>' +
      '<td>' + esc(r['单位'] || '') + '</td>' +
      '<td>' + esc(this.optText('设施类别', r['设施类别'])) + '</td>' +
      '<td style="text-align:left">' + esc(r['设施名称']) + '</td>' +
      '<td>' + esc(r['成本对象'] || '') + '</td>' +
      '<td>' + dateStr(r['入账日期'] || r['启用日期']) + '</td>' +
      '<td>' + dateStr(r['启用日期']) + '</td>' +
      '<td class="num">' + ((Number(r['原值(元)']) || 0)).toFixed(2) + '</td>' +
      '<td>' + (Number(r['残值率(%)']) || 0) + '%</td>' +
      '<td class="num">' + c.residualAmt.toFixed(2) + '</td>' +
      '<td>' + (Number(r['摊销期限(月)']) || 0) + '</td>' +
      '<td>' + c.cur + '</td>' +
      '<td>' + c.k + '</td>' +
      '<td class="num">' + c.accruedPrev.toFixed(2) + '</td>' +
      '<td class="num">' + c.curAmt.toFixed(2) + '</td>' +
      '<td class="num">' + c.accrued.toFixed(2) + '</td>' +
      '<td class="num">' + c.net.toFixed(2) + '</td></tr>';
  }
  var groups = {};
  rows.forEach(function(r){
    var g = this.optText('设施类别', r['设施类别']) || '未分类';
    (groups[g] = groups[g] || []).push(r);
  }, this);
  var body = '', grand = { cost: 0, res: 0, prev: 0, cur: 0, acc: 0, net: 0 }, sn = 0;
  Object.keys(groups).sort().forEach(function(g){
    var s = { cost: 0, res: 0, prev: 0, cur: 0, acc: 0, net: 0 };
    var trs = groups[g].map(function(r){
      var c = calcs[r._id];
      sn++; s.cost += Number(r['原值(元)']) || 0; s.res += c.residualAmt; s.prev += c.accruedPrev;
      s.cur += c.curAmt; s.acc += c.accrued; s.net += c.net;
      return rowHtml.call(this, r, sn - 1);
    }, this).join('');
    grand.cost += s.cost; grand.res += s.res; grand.prev += s.prev; grand.cur += s.cur; grand.acc += s.acc; grand.net += s.net;
    body += trs +
      '<tr><th colspan="7">' + esc(g) + '小计</th><th class="num">' + s.cost.toFixed(2) + '</th><th>—</th><th class="num">' + s.res.toFixed(2) + '</th><th>—</th><th>—</th><th>—</th><th class="num">' + s.prev.toFixed(2) + '</th><th class="num">' + s.cur.toFixed(2) + '</th><th class="num">' + s.acc.toFixed(2) + '</th><th class="num">' + s.net.toFixed(2) + '</th></tr>';
  }, this);
  /* 成本对象汇总：并入主表，置于总计上方（其中：××） */
  var byObj = {};
  rows.forEach(function(r){
    var c = calcs[r._id];
    var k2 = r['成本对象'] || '未分摊';
    if(!byObj[k2]) byObj[k2] = { cost: 0, res: 0, prev: 0, cur: 0, acc: 0, net: 0 };
    var o = byObj[k2];
    o.cost += Number(r['原值(元)']) || 0; o.res += c.residualAmt; o.prev += c.accruedPrev;
    o.cur += c.curAmt; o.acc += c.accrued; o.net += c.net;
  });
  body += Object.keys(byObj).sort().map(function(k2){
    var o = byObj[k2];
    return '<tr><th colspan="7">其中：' + esc(k2) + '</th><th class="num">' + o.cost.toFixed(2) + '</th><th>—</th><th class="num">' + o.res.toFixed(2) + '</th><th>—</th><th>—</th><th>—</th><th class="num">' + o.prev.toFixed(2) + '</th><th class="num">' + o.cur.toFixed(2) + '</th><th class="num">' + o.acc.toFixed(2) + '</th><th class="num">' + o.net.toFixed(2) + '</th></tr>';
  }).join('');
  $('#printArea').innerHTML = '<div class="p-doc">' +
    '<h1>' + ymCn(pe) + '设施摊销表</h1>' +
    '<div class="p-meta"><span>单位：' + esc(printUnitName()) + '</span><span></span><span>单位：元</span></div>' +
    '<table><thead><tr><th>序号</th><th>单位</th><th>设施类别</th><th>设施名称</th><th>成本对象</th><th>入账日期</th><th>启用日期</th><th>原 值</th><th>残值率</th><th>预计净残值</th><th>应摊销月份</th><th>本期摊销月份</th><th>开累摊销月份</th><th>截至上期摊销金额</th><th>本月摊销金额</th><th>开累摊销金额</th><th>本月末账面净值</th></tr></thead>' +
    '<tbody>' + body + '</tbody>' +
    '<tfoot><tr><th colspan="7">总　计</th><th class="num">' + grand.cost.toFixed(2) + '</th><th>—</th><th class="num">' + grand.res.toFixed(2) + '</th><th>—</th><th>—</th><th>—</th><th class="num">' + grand.prev.toFixed(2) + '</th><th class="num">' + grand.cur.toFixed(2) + '</th><th class="num">' + grand.acc.toFixed(2) + '</th><th class="num">' + grand.net.toFixed(2) + '</th></tr></tfoot>' +
    '</table>' +
    signRow(['项目经理', '分管领导', '相关部门', '财务部长', '制表']) +
    '</div>';
}
/* 全量台账 */
export function printTfaLedger(rows, calcs){
  if(!rows.length){ toast('暂无数据可打印'); return; }
  var pe = periodEnd();
  var trs = rows.map(function(r, i){
    var c = calcs[r._id];
    return '<tr><td>' + (i + 1) + '</td>' +
      '<td>' + esc(r['单位'] || '') + '</td>' +
      '<td>' + esc(this.optText('设施类别', r['设施类别'])) + '</td>' +
      '<td style="text-align:left">' + esc(r['设施名称']) + '</td>' +
      '<td>' + esc(r['成本对象'] || '') + '</td>' +
      '<td>' + dateStr(r['入账日期'] || r['启用日期']) + '</td>' +
      '<td>' + dateStr(r['启用日期']) + '</td>' +
      '<td>' + (Number(r['摊销期限(月)']) || 0) + '</td>' +
      '<td>' + c.k + '/' + (Number(r['摊销期限(月)']) || 0) + '</td>' +
      '<td class="num">' + ((Number(r['原值(元)']) || 0)).toFixed(2) + '</td>' +
      '<td class="num">' + c.monthly.toFixed(2) + '</td>' +
      '<td class="num">' + c.accrued.toFixed(2) + '</td>' +
      '<td class="num">' + c.curAmt.toFixed(2) + '</td>' +
      '<td class="num">' + c.net.toFixed(2) + '</td>' +
      '<td>' + esc(this.optText('状态', r['状态'])) + '</td></tr>';
  }, this).join('');
  $('#printArea').innerHTML = '<div class="p-doc">' +
    '<h1>设施台账（全量）</h1>' +
    '<div class="p-meta"><span>单位：' + esc(printUnitName()) + '</span><span>截至 ' + ymCn(pe) + '</span><span>单位：元</span></div>' +
    '<table><thead><tr><th>序号</th><th>单位</th><th>设施类别</th><th>设施名称</th><th>成本对象</th><th>入账日期</th><th>启用日期</th><th>期限(月)</th><th>已摊/共(月)</th><th>原值</th><th>月摊销额</th><th>开累摊销</th><th>本月摊销</th><th>账面净值</th><th>状态</th></tr></thead>' +
    '<tbody>' + trs + '</tbody></table>' +
    signRow(['项目经理', '设备部门', '财务部长', '制表']) +
    '</div>';
}
export function printTfaVoucher(id){
  var r = null, idx = -1;
  var rows = curRows();
  for(var i = 0; i < rows.length; i++){ if(rows[i]._id === id){ r = rows[i]; idx = i; break; } }
  if(!r){ toast('记录不存在'); return; }
  var c = calcsOf(rows)[id];
  var months = Number(r['摊销期限(月)']) || 0;
  var pe = periodEnd();
  var no = 'TFA-' + todayStr().replace(/-/g, '') + '-' + ('0' + (idx + 1)).slice(-2);
  $('#printArea').innerHTML = '<div class="p-doc">' +
    '<h1>设施摊销计算单</h1>' +
    '<div class="p-meta"><span>凭证编号：' + no + '</span><span>' + ymCn(pe) + '</span><span>单位：元</span></div>' +
    '<table><tbody>' +
      '<tr><th style="width:16%">设施名称</th><td style="text-align:left">' + esc(r['设施名称']) + '</td><th style="width:16%">设施类别</th><td>' + esc(optText('设施类别', r['设施类别'])) + '</td></tr>' +
      '<tr><th>入账日期</th><td>' + dateStr(r['入账日期'] || r['启用日期']) + '</td><th>启用日期</th><td>' + dateStr(r['启用日期']) + '</td></tr>' +
      '<tr><th>摊销方法</th><td>' + esc(optText('摊销方法', r['摊销方法'])) + '</td><th>摊销期限</th><td>' + months + ' 个月</td></tr>' +
      '<tr><th>当前状态</th><td>' + esc(optText('状态', r['状态'])) + '</td><th>成本对象</th><td>' + esc(r['成本对象'] || '') + '</td></tr>' +
    '</tbody></table>' +
    '<table style="margin-top:10px"><thead><tr><th style="width:26%">项目</th><th style="width:34%">金额（小写）</th><th style="width:40%">金额（大写）</th></tr></thead><tbody>' +
      '<tr><th>原值</th><td class="num">' + ((Number(r['原值(元)']) || 0)).toFixed(2) + '</td><td>' + esc(toCN(Number(r['原值(元)']) || 0)) + '</td></tr>' +
      '<tr><th>预计净残值</th><td class="num">' + c.residualAmt.toFixed(2) + '</td><td>' + esc(toCN(c.residualAmt)) + '</td></tr>' +
      '<tr><th>应摊总额</th><td class="num">' + c.total.toFixed(2) + '</td><td>' + esc(toCN(c.total)) + '</td></tr>' +
      '<tr><th>月摊销额</th><td class="num">' + c.monthly.toFixed(2) + '</td><td>' + esc(toCN(c.monthly)) + '</td></tr>' +
      '<tr><th>截至上期摊销金额</th><td class="num">' + c.accruedPrev.toFixed(2) + '</td><td>' + esc(toCN(c.accruedPrev)) + '</td></tr>' +
      '<tr><th>本月摊销金额</th><td class="num">' + c.curAmt.toFixed(2) + '</td><td>' + esc(toCN(c.curAmt)) + '</td></tr>' +
      '<tr><th>开累摊销金额</th><td class="num">' + c.accrued.toFixed(2) + '</td><td>' + esc(toCN(c.accrued)) + '</td></tr>' +
      '<tr><th>期末账面净值</th><td class="num">' + c.net.toFixed(2) + '</td><td>' + esc(toCN(c.net)) + '</td></tr>' +
    '</tbody></table>' +
    '<div style="font-size:12px;margin:12px 0 2px;">摊销情况：截至 ' + ymCn(pe) + '，开累已计提 ' + c.k + ' 个月 / 共 ' + months + ' 个月，剩余 ' + c.remain + ' 个月。</div>' +
    signRow(['编制人', '复核人', '财务负责人']) +
    '</div>';
  doPrint(false);
}

/* 固定资产单项明细：屏显主表保持紧凑，完整计算结果从此处查看/打印 */
export function printAssetVoucher(id){
  var rows = curRows(), r = null, idx = -1;
  for(var i = 0; i < rows.length; i++){ if(rows[i]._id === id){ r = rows[i]; idx = i; break; } }
  if(!r){ toast('记录不存在'); return; }
  var c = calcsOf(rows)[id], pe = periodEnd();
  var no = 'ZC-' + todayStr().replace(/-/g, '') + '-' + ('0' + (idx + 1)).slice(-2);
  $('#printArea').innerHTML = '<div class="p-doc">' +
    '<h1>固定资产折旧明细单</h1>' +
    '<div class="p-meta"><span>明细编号：' + no + '</span><span>' + ymCn(pe) + '</span><span>单位：元</span></div>' +
    '<table><tbody>' +
      '<tr><th style="width:16%">资产名称</th><td style="text-align:left">' + esc(r['资产名称']) + '</td><th style="width:16%">资产编号</th><td>' + esc(r['固定资产编号'] || '') + '</td></tr>' +
      '<tr><th>单位</th><td>' + esc(r['单位'] || '') + '</td><th>资产类型</th><td>' + esc(optText('资产类型', r['资产类型'])) + '</td></tr>' +
      '<tr><th>启用日期</th><td>' + dateStr(r['启用日期']) + '</td><th>转移至项目日期</th><td>' + (dateStr(r['转移至项目日期']) || '—') + '</td></tr>' +
      '<tr><th>预计使用年限</th><td>' + (Number(r['预计使用年限(年)']) || 0) + ' 年</td><th>残值率</th><td>' + (Number(r['残值率(%)']) || 0) + '%</td></tr>' +
    '</tbody></table>' +
    '<table style="margin-top:10px"><thead><tr><th>项目</th><th>金额/数量</th><th>说明</th></tr></thead><tbody>' +
      '<tr><th>原值</th><td class="num">' + (Number(r['原值(元)']) || 0).toFixed(2) + '</td><td>资产入账原值</td></tr>' +
      '<tr><th>预计残值</th><td class="num">' + c.residualAmt.toFixed(2) + '</td><td>原值 × 残值率</td></tr>' +
      '<tr><th>本次折旧</th><td class="num">' + c.curAmt.toFixed(2) + '</td><td>当前期间计提</td></tr>' +
      '<tr><th>开累折旧额</th><td class="num">' + c.accrued.toFixed(2) + '</td><td>截至当前期间</td></tr>' +
      '<tr><th>本项目承担折旧</th><td class="num">' + (c.bear == null ? '—' : c.bear.toFixed(2)) + '</td><td>按转移日期计算</td></tr>' +
      '<tr><th>账面余额</th><td class="num">' + c.net.toFixed(2) + '</td><td>原值 - 开累折旧额</td></tr>' +
    '</tbody></table>' + signRow(['编制人','复核人','财务负责人']) + '</div>';
  doPrint(false);
}

