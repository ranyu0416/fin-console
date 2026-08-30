import { $ } from '../core/dom.js';
import { amt, dateStr, fmt, fmt2, r2, ri } from '../core/format.js';
import { esc } from '../core/text.js';
import { fg, fgRow, numInput, unitField } from '../formkit.js';
import { viewYm } from '../period.js';
import { printLvc } from '../print-lvc.js';
import { doPrint } from '../print.js';

export const lvc = {
    key: 'lvc', name: '低值易耗品', entity: '低值易耗品', cardTitle: '低值易耗品台账',
    periodDisplay: true, periodField: '入账月份',
    cardHint: '',
    dbId: 'lvc',
    cacheKey: 'wb_fin_lvc_cache', formCacheKey: 'wb_fin_lvc_form',
    sortField: '入账月份',
    selectFields: [],
    defaultOptions: {},
    filters: [ {el: 'fCat', field: '成本对象', all: '全部成本对象', distinct: true} ],
    searchHay: function(r){ return String(r['资产名称'] || '') + String(r['规格型号'] || '') + String(r['领用人'] || '') + String(r['凭证号'] || '') + String(r['成本对象'] || '') + String(r['单位'] || ''); },
    rowCalc: function(r){
      var qty = Number(r['数量']) || 0;
      var price = Number(r['单价(元)']) || 0;
      var netAmt = r2(qty * price);
      var tax = Number(r['可抵扣进项税额(元)']) || 0;
      return { netAmt: netAmt, tax: tax, grossAmt: r2(netAmt + tax), curAmt: netAmt };  // 一次转销法
    },
    columns: [
      {h: '序号', v: function(r, c, i){ return i + 1; }},
      {h: '单位', v: function(r){ return esc(r['单位'] || ''); }},
      {h: '入账月份', v: function(r){ return dateStr(r['入账月份']).slice(0, 7); }},
      {h: '凭证号', v: function(r){ return esc(r['凭证号'] || ''); }},
      {h: '开票日期', v: function(r){ return dateStr(r['开票日期']); }},
      {h: '资产名称', v: function(r){ return '<strong>' + esc(r['资产名称'] || '') + '</strong>'; }},
      {h: '规格型号', v: function(r){ return esc(r['规格型号'] || ''); }},
      {h: '计量单位', v: function(r){ return esc(r['计量单位'] || ''); }},
      {h: '数量', v: function(r){ return r['数量'] || ''; }},
      {h: '单价（不含税）', v: function(r){ return amt(r['单价(元)']); }, num: true},
      {h: '不含税总金额', v: function(r, c){ return amt(c.netAmt); }, num: true},
      {h: '可抵扣进项税额', v: function(r, c){ return amt(c.tax); }, num: true},
      {h: '含税金额', v: function(r, c){ return amt(c.grossAmt); }, num: true},
      {h: '本期摊销', v: function(r, c){ return amt(c.curAmt); }, num: true},
      {h: '领用人', v: function(r){ return esc(r['领用人'] || ''); }},
      {h: '成本对象', v: function(r){ return esc(r['成本对象'] || ''); }}
    ],
    stats: function(rows, calcs){
      var gross = 0, net = 0, cur = 0;
      rows.forEach(function(r){
        var c = calcs[r._id];
        gross += c.grossAmt; net += c.netAmt; cur += c.curAmt;
      });
      return { labels: ['本期记录数（所选期间）', '本期含税金额合计', '本期不含税金额合计', '本期一次转销合计'],
               values: [rows.length, fmt(gross), fmt(net), fmt(cur)], sub: '' };
    },
    attention: function(){ return []; },
    formHTML: function(){
      return unitField() +
        fgRow(
          fg('资产名称 *', '<input name="name" type="text" required>'),
          fg('规格型号', '<input name="spec" type="text" placeholder="选填">')
        ) +
        fgRow(
          fg('入账月份 *', '<input name="period" type="month" required>'),
          fg('凭证号', '<input name="voucher" type="text" placeholder="选填">')
        ) +
        fgRow(
          fg('开票日期', '<input name="invdate" type="date">'),
          fg('计量单位', '<input name="unit2" type="text" placeholder="如：个 / 台 / 套">')
        ) +
        fgRow(
          fg('数量 *', '<input name="qty" type="text" inputmode="numeric" data-num placeholder="数量" required>'),
          fg('单价（不含税，元）*', numInput('price', '0.00'))
        ) +
        fg('可抵扣进项税额（元）', numInput('tax', '选填')) +
        fgRow(
          fg('领用人（保管人）', '<input name="keeper" type="text" placeholder="选填">'),
          fg('成本对象', '<input name="costobj" type="text" placeholder="如：xx项目部">')
        ) +
        '<div class="preview" id="preview">采用一次转销法：入账当期将不含税成本一次性计入费用</div>';
    },
    fillForm: function(r){
      $('[name="unit"]').value = r['单位'] || '';
      $('[name="name"]').value = r['资产名称'] || '';
      $('[name="spec"]').value = r['规格型号'] || '';
      $('[name="period"]').value = dateStr(r['入账月份']).slice(0, 7);
      $('[name="voucher"]').value = r['凭证号'] || '';
      $('[name="invdate"]').value = dateStr(r['开票日期']);
      $('[name="unit2"]').value = r['计量单位'] || '';
      $('[name="qty"]').value = r['数量'] != null ? r['数量'] : '';
      $('[name="price"]').value = r['单价(元)'] != null ? r['单价(元)'] : '';
      $('[name="tax"]').value = r['可抵扣进项税额(元)'] != null ? r['可抵扣进项税额(元)'] : '';
      $('[name="keeper"]').value = r['领用人'] || '';
      $('[name="costobj"]').value = r['成本对象'] || '';
    },
    defaults: function(){
      /* 预填「查看期间」：与专项费用模块同理，按今天预填会让记录落错期间 */
      return { period: viewYm() };
    },
    readForm: function(){
      var unit = $('[name="unit"]').value.trim();
      var name = $('[name="name"]').value.trim();
      var spec = $('[name="spec"]').value.trim();
      var period = $('[name="period"]').value;
      var voucher = $('[name="voucher"]').value.trim();
      var invdate = $('[name="invdate"]').value;
      var unit2 = $('[name="unit2"]').value.trim();
      var qty = parseFloat($('[name="qty"]').value);
      var price = parseFloat($('[name="price"]').value);
      var tax = parseFloat($('[name="tax"]').value);
      var keeper = $('[name="keeper"]').value.trim();
      var costobj = $('[name="costobj"]').value.trim();
      if(!unit || !name || !period || isNaN(qty) || isNaN(price)) return { err: '请完整填写必填项' };
      if(qty <= 0) return { err: '数量必须大于 0' };
      if(price < 0) return { err: '单价不能为负数' };
      if(!isNaN(tax) && tax < 0) return { err: '进项税额不能为负数' };
      var props = {
        '单位': { text: unit },
        '资产名称': { text: name },
        '入账月份': { date: period + '-01' },
        '数量': { number: qty },
        '单价(元)': { number: price }
      };
      if(spec) props['规格型号'] = { text: spec };
      if(voucher) props['凭证号'] = { text: voucher };
      if(invdate) props['开票日期'] = { date: invdate };
      if(unit2) props['计量单位'] = { text: unit2 };
      if(!isNaN(tax)) props['可抵扣进项税额(元)'] = { number: tax };
      if(keeper) props['领用人'] = { text: keeper };
      if(costobj) props['成本对象'] = { text: costobj };
      return { props: props };
    },
    onFormInput: function(){
      var pv = $('#preview'); if(!pv) return;
      var qty = parseFloat($('[name="qty"]').value) || 0;
      var price = parseFloat($('[name="price"]').value) || 0;
      var tax = parseFloat($('[name="tax"]').value) || 0;
      if(qty && price) pv.innerHTML = '不含税总金额 <strong>' + fmt2(r2(qty * price)) + '</strong> ｜ 含税金额 <strong>' + fmt2(r2(qty * price + tax)) + '</strong> ｜ 本期摊销（一次转销）<strong>' + fmt2(r2(qty * price)) + '</strong>';
      else pv.textContent = '采用一次转销法：入账当期将不含税成本一次性计入费用';
    },
    buildPrint: function(rows, calcs){ printLvc.call(this, rows, calcs, true); },
    print: function(rows, calcs){ this.buildPrint(rows, calcs); doPrint(true); },
    buildPrintAll: function(rows, calcs){ printLvc.call(this, rows, calcs, false); },
    printAll: function(rows, calcs){ this.buildPrintAll(rows, calcs); doPrint(true); },
    seed: function(){
      var items = [
        ['安全帽', 'ABS V型', '顶', 15, 60], ['反光背心', '标准款', '件', 12, 80],
        ['劳保手套', '浸胶加厚', '双', 3, 100], ['电线电缆', 'BV-4mm²', '卷', 210, 6],
        ['打印纸', 'A4 70g', '箱', 105, 10], ['硒鼓', '88A型', '支', 240, 4],
        ['办公椅', '人体工学', '把', 260, 6], ['文件柜', '铁皮两节', '组', 480, 3],
        ['活扳手', '12寸', '把', 45, 8], ['冲击电钻', '650W', '台', 420, 2],
        ['插排', '5米带开关', '个', 38, 12], ['记号笔', '黑色', '盒', 25, 10],
        ['对讲机', 'UV双段', '台', 260, 6], ['卷尺', '7.5m钢卷尺', '个', 12, 20],
        ['灭火器', '干粉4kg', '具', 75, 10], ['警示锥', '反光70cm', '个', 18, 40],
        ['水准尺', '5m铝合金', '根', 85, 4], ['组合工具箱', '46件套', '套', 160, 3]
      ];
      var objs = ['项目部', '示例项目C', '示例项目A'];
      var units = ['一分公司', '二分公司', '三分公司'];
      var keepers = ['保管员A', '保管员B', '保管员C', '保管员D', '保管员E'];
      return items.map(function(x, i){
        var qty = ri(Math.ceil(x[4] / 2), x[4]);
        var net = r2(qty * x[3]);
        var m = ri(6, 8);
        return { '单位': units[i % units.length], '入账月份': '2026-0' + m + '-01',
          '凭证号': '记-2026-0' + m + '-' + ('0' + ri(1, 30)).slice(-2),
          '开票日期': '2026-0' + m + '-' + ('0' + ri(1, 28)).slice(-2),
          '资产名称': x[0], '规格型号': x[1], '计量单位': x[2], '数量': qty, '单价(元)': x[3],
          '可抵扣进项税额(元)': r2(net * 0.13), '领用人': keepers[i % keepers.length],
          '成本对象': objs[i % objs.length] };
      });
    }
  };

