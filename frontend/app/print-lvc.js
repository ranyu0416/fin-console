import { $, toast } from './core/dom.js';
import { dateStr, ymCn, ymStr } from './core/format.js';
import { cur } from './core/state.js';
import { esc } from './core/text.js';
import { periodEnd } from './period.js';
import { printUnitName, signRow } from './print.js';

/* ================= 通用打印：低值易耗品（periodOnly=true 仅当期） ================= */
export function printLvc(rows, calcs, periodOnly){
  var pe = periodEnd();
  var vis = rows;
  if(periodOnly){
    var want = ymStr(pe);
    vis = rows.filter(function(r){ return dateStr(r['入账月份']).slice(0, 7) === want; });
    if(!vis.length){ toast('所选会计期间暂无低值易耗品记录'); return; }
  }
  var groups = {};
  vis.forEach(function(r){
    var g = (r['单位'] || '') + ' / ' + (r['成本对象'] || '未分摊');
    if(!groups[g]) groups[g] = [];
    groups[g].push(r);
  });
  var body = '', grand = { net: 0, tax: 0, gross: 0, cur: 0 }, sn = 0;
  Object.keys(groups).sort().forEach(function(g){
    var s = { net: 0, tax: 0, gross: 0, cur: 0 };
    var trs = groups[g].map(function(r){
      var c = calcs[r._id];
      sn++; s.net += c.netAmt; s.tax += c.tax; s.gross += c.grossAmt; s.cur += c.curAmt;
      return '<tr><td>' + sn + '</td>' +
        '<td>' + esc(r['单位'] || '') + '</td>' +
        '<td>' + dateStr(r['入账月份']).slice(0, 7) + '</td>' +
        '<td>' + esc(r['凭证号'] || '') + '</td>' +
        '<td>' + dateStr(r['开票日期']) + '</td>' +
        '<td style="text-align:left">' + esc(r['资产名称']) + '</td>' +
        '<td>' + esc(r['规格型号'] || '') + '</td>' +
        '<td>' + esc(r['计量单位'] || '') + '</td>' +
        '<td>' + (Number(r['数量']) || 0) + '</td>' +
        '<td class="num">' + ((Number(r['单价(元)']) || 0)).toFixed(2) + '</td>' +
        '<td class="num">' + c.netAmt.toFixed(2) + '</td>' +
        '<td class="num">' + c.tax.toFixed(2) + '</td>' +
        '<td class="num">' + c.grossAmt.toFixed(2) + '</td>' +
        '<td class="num">' + c.curAmt.toFixed(2) + '</td>' +
        '<td>' + esc(r['领用人'] || '') + '</td>' +
        '<td>' + esc(r['成本对象'] || '') + '</td></tr>';
    }).join('');
    grand.net += s.net; grand.tax += s.tax; grand.gross += s.gross; grand.cur += s.cur;
    body += trs +
      '<tr><th colspan="10">' + esc(g) + '小计</th><th class="num">' + s.net.toFixed(2) + '</th><th class="num">' + s.tax.toFixed(2) + '</th><th class="num">' + s.gross.toFixed(2) + '</th><th class="num">' + s.cur.toFixed(2) + '</th><th>—</th><th>—</th></tr>';
  });
  $('#printArea').innerHTML = '<div class="p-doc">' +
    '<h1>低值易耗品' + (periodOnly ? '摊销明细表' : '台账（全量）') + '</h1>' +
    '<div class="p-meta"><span>单位：' + esc(printUnitName()) + '</span><span>' + (periodOnly ? ymCn(pe) : '截至 ' + ymCn(pe)) + '</span><span>单位：元</span></div>' +
    '<table><thead><tr><th>序号</th><th>单位</th><th>入账月份</th><th>凭证号</th><th>开票日期</th><th>资产名称</th><th>规格型号</th><th>计量单位</th><th>数量</th><th>单价（不含税）</th><th>不含税总金额</th><th>可抵扣进项税额</th><th>含税金额</th><th>本期摊销</th><th>领用人</th><th>成本对象</th></tr></thead>' +
    '<tbody>' + body + '</tbody>' +
    '<tfoot><tr><th colspan="10">总　计</th><th class="num">' + grand.net.toFixed(2) + '</th><th class="num">' + grand.tax.toFixed(2) + '</th><th class="num">' + grand.gross.toFixed(2) + '</th><th class="num">' + grand.cur.toFixed(2) + '</th><th>—</th><th>—</th></tr></tfoot>' +
    '</table>' +
    signRow(['项目经理', '材料部门', '财务部长', '制表']) +
    '</div>';
}

