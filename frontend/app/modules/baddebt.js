import { $, toast } from '../core/dom.js';
import { amt, dateStr, fmt, fmt2, r2, ri } from '../core/format.js';
import { esc, monthsElapsedTo, todayStr } from '../core/text.js';
import { fg, fgRow, numInput, unitField } from '../formkit.js';
import { periodEnd } from '../period.js';
import { doPrint, printUnitName, signRow } from '../print.js';

export const baddebt = {
    key: 'baddebt', name: '减值准备', entity: '减值准备记录', cardTitle: '减值准备计提台账',
    dbId: 'baddebt',
    cacheKey: 'wb_fin_baddebt_cache', formCacheKey: 'wb_fin_baddebt_form',
    sortField: '入账日期',
    selectFields: [],
    defaultOptions: {},
    filters: [],
    searchHay: function(r){ return String(r['科目名称'] || '') + String(r['往来单位名称'] || '') + String(r['单位'] || ''); },
    ageRates: { '1年以内': 0.5, '1-2年': 5, '2-3年': 10, '3年以上': 30 },
    /* 账龄由入账日期自动推算；计提比例默认取账龄对应比例，可手工调整 */
    ageOf: function(r, pe){
      var months = monthsElapsedTo(r['入账日期'], pe);
      return months < 12 ? '1年以内' : (months < 24 ? '1-2年' : (months < 36 ? '2-3年' : '3年以上'));
    },
    rowCalc: function(r, pe){
      var balance = Number(r['科目余额(元)']) || 0;
      var age = this.ageOf(r, pe);
      var storedRate = Number(r['计提比例(%)']);
      var defaultRates = Object.keys(this.ageRates).map(function(k){ return Number(this.ageRates[k]); }, this);
      /* 账龄比例随账面时间自动更新；只有填入非标准比例时才视为手工比例。 */
      var rate = (!isNaN(storedRate) && defaultRates.indexOf(storedRate) < 0) ? storedRate : this.ageRates[age];
      var due = r2(balance * rate / 100);
      var paid = Math.max(0, Number(r['已计提金额(元)']) || 0);
      return { balance: balance, age: age, rate: rate, due: due, paid: paid, cur: r2(due - paid) };
    },
    columns: [
      {h: '序号', v: function(r, c, i){ return i + 1; }},
      {h: '单位', v: function(r){ return esc(r['单位'] || ''); }},
      {h: '科目名称', v: function(r){ return '<strong>' + esc(r['科目名称'] || '') + '</strong>'; }},
      {h: '往来单位名称', v: function(r){ return esc(r['往来单位名称'] || ''); }},
      {h: '入账日期', v: function(r){ return dateStr(r['入账日期']); }},
      {h: '科目余额', v: function(r, c){ return amt(c.balance); }, num: true},
      {h: '账龄', v: function(r, c){ return c.age; }},
      {h: '计提比例', v: function(r, c){ return c.rate + '%'; }},
      {h: '应计提金额', v: function(r, c){ return amt(c.due); }, num: true},
      {h: '已计提金额', v: function(r, c){ return amt(c.paid); }, num: true},
      {h: '本期调整金额', v: function(r, c){ return amt(c.cur); }, num: true}
    ],
    stats: function(rows, calcs){
      var bal = 0, due = 0, cur = 0, paid = 0;
      rows.forEach(function(r){
        var c = calcs[r._id];
        bal += c.balance; due += c.due; cur += c.cur; paid += c.paid;
      });
      return { labels: ['记录条数（截至所选期间）', '科目余额合计', '本期需计提金额合计', '本期调整额（补提/冲回） / 已计提'],
               values: [rows.length, fmt(bal), fmt(due), fmt(cur)], sub: '/ 已计提 ' + fmt(paid) };
    },
    attention: function(){ return []; },
    formHTML: function(){
      return unitField() +
        fg('科目名称 *', '<input name="subject" type="text" placeholder="如：其他应收款-押金-租赁押金" required>') +
        fgRow(
          fg('往来单位名称', '<input name="partner" type="text" placeholder="选填">'),
          fg('入账日期 *', '<input name="in_date" type="date" required title="账龄按入账日期自动推算">')
        ) +
        fgRow(
          fg('科目余额（元）*', numInput('balance', '0.00')),
          fg('计提比例（%）', '<input name="rate" type="text" inputmode="decimal" data-num placeholder="默认按账龄比例">')
        ) +
        fg('已计提金额（元）', numInput('paid', '截至上期已计提')) +
        '<div class="preview" id="preview">填写入账日期后自动判定账龄；本期调整额＝应计提金额－已计提金额，负数表示需冲回</div>';
    },
    fillForm: function(r){
      $('[name="unit"]').value = r['单位'] || '';
      $('[name="subject"]').value = r['科目名称'] || '';
      $('[name="partner"]').value = r['往来单位名称'] || '';
      $('[name="in_date"]').value = dateStr(r['入账日期']);
      $('[name="balance"]').value = r['科目余额(元)'] != null ? r['科目余额(元)'] : '';
      var savedRate = Number(r['计提比例(%)']);
      var defaults = Object.keys(this.ageRates).map(function(k){ return Number(this.ageRates[k]); }, this);
      $('[name="rate"]').value = (!isNaN(savedRate) && defaults.indexOf(savedRate) < 0) ? savedRate : '';
      $('[name="paid"]').value = r['已计提金额(元)'] != null ? r['已计提金额(元)'] : '';
    },
    defaults: function(){ return {}; },
    readForm: function(){
      var unit = $('[name="unit"]').value.trim();
      var subject = $('[name="subject"]').value.trim();
      var partner = $('[name="partner"]').value.trim();
      var inDate = $('[name="in_date"]').value;
      var balance = parseFloat($('[name="balance"]').value);
      var rate = parseFloat($('[name="rate"]').value);
      var paid = parseFloat($('[name="paid"]').value);
      if(!unit || !subject || !inDate || isNaN(balance)) return { err: '请完整填写必填项' };
      if(balance <= 0) return { err: '科目余额必须大于 0' };
      if(!isNaN(rate) && (rate < 0 || rate > 100)) return { err: '计提比例需在 0～100% 之间' };
      if(!isNaN(paid) && paid < 0) return { err: '已计提金额不能为负数' };
      var props = {
        '单位': { text: unit },
        '科目名称': { text: subject },
        '入账日期': { date: inDate },
        '科目余额(元)': { number: balance }
      };
      if(!isNaN(rate)) props['计提比例(%)'] = { number: rate };
      if(partner) props['往来单位名称'] = { text: partner };
      if(!isNaN(paid)) props['已计提金额(元)'] = { number: paid };
      return { props: props };
    },
    onFormInput: function(){
      var pv = $('#preview'); if(!pv) return;
      var inDate = $('[name="in_date"]').value;
      var bal = parseFloat($('[name="balance"]').value) || 0;
      var rateEl = $('[name="rate"]');
      if(inDate){
        var age = this.ageOf({ '入账日期': inDate }, periodEnd());
        var def = this.ageRates[age];
        var rate = rateEl.value === '' ? def : (parseFloat(rateEl.value) || 0);
        if(bal) pv.innerHTML = '账龄 <strong>' + age + '</strong>（自动比例 ' + def + '%）｜ 应计提金额 ＝ <strong>' + fmt2(r2(bal * rate / 100)) + '</strong>';
        else pv.innerHTML = '账龄 <strong>' + age + '</strong>（默认比例 ' + def + '%，可手工调整）';
      } else pv.textContent = '填写入账日期后自动判定账龄并带出默认计提比例；本期调整额＝应计提金额－已计提金额';
    },
    buildPrint: function(rows, calcs){
      if(!rows.length){ toast('暂无数据可打印'); return; }
      var pe = periodEnd();
      var sums = { bal: 0, due: 0, paid: 0, cur: 0 };
      var trs = rows.map(function(r, i){
        var c = calcs[r._id];
        sums.bal += c.balance; sums.due += c.due; sums.paid += c.paid; sums.cur += c.cur;
        return '<tr><td>' + (i + 1) + '</td>' +
          '<td>' + esc(r['单位'] || '') + '</td>' +
          '<td style="text-align:left">' + esc(r['科目名称']) + '</td>' +
          '<td style="text-align:left">' + esc(r['往来单位名称'] || '') + '</td>' +
          '<td>' + dateStr(r['入账日期']) + '</td>' +
          '<td class="num">' + c.balance.toFixed(2) + '</td>' +
          '<td>' + c.age + '</td>' +
          '<td>' + c.rate + '%</td>' +
          '<td class="num">' + c.due.toFixed(2) + '</td>' +
          '<td class="num">' + c.paid.toFixed(2) + '</td>' +
          '<td class="num">' + c.cur.toFixed(2) + '</td></tr>';
      }, this).join('');
      $('#printArea').innerHTML = '<div class="p-doc">' +
        '<h1>其他应收款计提减值准备明细表</h1>' +
        '<div class="p-meta"><span>单位：' + esc(printUnitName()) + '</span><span>日期：' + todayStr() + '</span><span>单位：元</span></div>' +
        '<table><thead><tr><th>序号</th><th>单位</th><th>科目名称</th><th>往来单位名称</th><th>入账日期</th><th>科目余额</th><th>账龄</th><th>计提比例</th><th>应计提金额</th><th>已计提金额</th><th>本期计提金额</th></tr></thead>' +
        '<tbody>' + trs + '</tbody>' +
        '<tfoot><tr><th colspan="5">合　计</th><th class="num">' + sums.bal.toFixed(2) + '</th><th>—</th><th>—</th><th class="num">' + sums.due.toFixed(2) + '</th><th class="num">' + sums.paid.toFixed(2) + '</th><th class="num">' + sums.cur.toFixed(2) + '</th></tr></tfoot>' +
        '</table>' +
        signRow(['项目经理', '审核', '制表']) +
        '</div>';
    },
    print: function(rows, calcs){ this.buildPrint(rows, calcs); doPrint(true); },
    buildPrintAll: function(rows, calcs){ this.buildPrint(rows, calcs); },
    printAll: function(rows, calcs){ this.buildPrintAll(rows, calcs); doPrint(true); },
    seed: function(){
      var defs = [
        ['一分公司', '其他应收款-押金-租赁押金', '某设备租赁公司', ri(8, 30) * 10000, '2025-11-15'],
        ['一分公司', '其他应收款-备用金', '物资部（内部）', ri(5, 20) * 1000, '2026-03-01'],
        ['一分公司', '其他应收款-押金-租赁押金', '某机械设备租赁部', ri(3, 15) * 10000, '2026-06-10'],
        ['二分公司', '其他应收款-押金-履约保证金', '合作单位A', ri(20, 60) * 10000, '2025-03-20'],
        ['二分公司', '其他应收款-保证金-劳务工资保证金', '劳务工资专户', ri(10, 25) * 10000, '2024-12-05'],
        ['三分公司', '其他应收款-保证金-投标保证金', '某城建开发公司', ri(10, 40) * 10000, '2024-05-18'],
        ['三分公司', '其他应收款-其他-代垫费用', '某物流公司', ri(1, 8) * 1000, '2024-02-10'],
        ['三分公司', '其他应收款-其他-往来款', '某商贸公司', ri(2, 10) * 10000, '2023-07-22']
      ];
      return defs.map(function(x){
        var pe = new Date();
        var months = monthsElapsedTo(x[4], pe);
        var age = months < 12 ? '1年以内' : (months < 24 ? '1-2年' : (months < 36 ? '2-3年' : '3年以上'));
        var rate = { '1年以内': 0.5, '1-2年': 5, '2-3年': 10, '3年以上': 30 }[age];
        var due = r2(x[3] * rate / 100);
        return { '单位': x[0], '科目名称': x[1], '往来单位名称': x[2], '科目余额(元)': x[3],
                 '入账日期': x[4], '计提比例(%)': rate,
                 '已计提金额(元)': r2(due * (age === '1年以内' ? 0.6 : 0.8)) };
      });
    }
  };

