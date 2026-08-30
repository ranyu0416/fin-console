import { $, toast } from '../core/dom.js';
import { amt, dateStr, fmt, fmt2, r2, ri, ymCn, ymLabel, ymStr } from '../core/format.js';
import { editingId } from '../core/state.js';
import { esc } from '../core/text.js';
import { fg, fgRow, numInput, unitField } from '../formkit.js';
import { periodEnd, viewYm } from '../period.js';
import { doPrint, printUnitName, signRow } from '../print.js';

export const union = {
    key: 'union', name: '工会·职工教育经费', entity: '经费记录',
    periodDisplay: true, periodField: '会计期间',
    cardHint: '',
    dbId: 'union',
    cacheKey: 'wb_fin_union_cache', formCacheKey: 'wb_fin_union_form',
    sortField: '会计期间',
    selectFields: [],
    defaultOptions: {},
    filters: [],
    searchHay: function(r){ return String(r['备注'] || '') + String(r['单位'] || ''); },
    dupKey: function(r){ return (r['单位'] || '') + '|' + dateStr(r['会计期间']).slice(0, 7); },
    dupHint: '同一单位、同一会计期间已有记录',
    /* 链式口径：本期工资＝本期年开累－上期年开累；本期计提＝ROUND(本期工资×比例)；
       累计计提＝上期累计计提＋本期计提（按单位分别结转，期初已计提为链起点） */
    calcAll: function(rows){
      var out = {}, chains = {}, lastByUnit = {};
      var sorted = rows.slice().sort(function(a, b){
        return dateStr(a['会计期间']) < dateStr(b['会计期间']) ? -1 : 1;
      });
      sorted.forEach(function(r){
        var unit = r['单位'] || '';
        var year = dateStr(r['会计期间']).slice(0, 4);
        var key = unit + '#' + year;   // 链按"单位+年度"，年初自动重置
        if(!chains[key]){
          /* 跨年结转：新年度未显式填“期初已计提”时，自动接续上年度末累计，避免累计计提在每年 1 月归零 */
          var carry = lastByUnit[unit] || { u: 0, e: 0 };
          chains[key] = {
            cum: Number(r['上期工资年开累(元)']) || 0,
            u: Number(r['工会期初已计提(元)']) || carry.u,
            e: Number(r['教育期初已计提(元)']) || carry.e
          };
        }
        var ch = chains[key];
        var cum = Number(r['工资年开累(元)']) || 0;
        var ur = Number(r['工会经费比例(%)']) || 0;
        var er = Number(r['职工教育经费比例(%)']) || 0;
        var wages = Math.max(0, r2(cum - ch.cum));
        var uCur = r2(wages * ur / 100), eCur = r2(wages * er / 100);
        var uAcc = r2(ch.u + uCur), eAcc = r2(ch.e + eCur);
        out[r._id] = { wages: wages, cum: cum, uCur: uCur, eCur: eCur, uAcc: uAcc, eAcc: eAcc };
        ch.cum = cum; ch.u = uAcc; ch.e = eAcc;
        lastByUnit[unit] = { u: uAcc, e: eAcc };   // 用于下一年初接续
      });
      return out;
    },
    columns: [
      {h: '序号', v: function(r, c, i){ return i + 1; }},
      {h: '单位', v: function(r){ return esc(r['单位'] || ''); }},
      {h: '会计期间', v: function(r){ return ymLabel(r['会计期间']); }},
      {h: '本期工资总额', v: function(r, c){ return amt(c.wages); }, num: true},
      {h: '工资年开累', v: function(r, c){ return amt(c.cum); }, num: true},
      {h: '工会比例', v: function(r){ return (Number(r['工会经费比例(%)']) || 0) + '%'; }},
      {h: '工会本期计提', v: function(r, c){ return amt(c.uCur); }, num: true},
      {h: '工会累计计提', v: function(r, c){ return amt(c.uAcc); }, num: true},
      {h: '教育比例', v: function(r){ return (Number(r['职工教育经费比例(%)']) || 0) + '%'; }},
      {h: '教育本期计提', v: function(r, c){ return amt(c.eCur); }, num: true},
      {h: '教育累计计提', v: function(r, c){ return amt(c.eAcc); }, num: true},
      {h: '备注', v: function(r){ return esc(r['备注'] || ''); }}
    ],
    stats: function(rows, calcs){
      var want = ymStr(periodEnd());
      var wages = 0, uCur = 0, eCur = 0, n = 0;
      rows.forEach(function(r){
        if(dateStr(r['会计期间']).slice(0, 7) !== want) return;
        var c = calcs[r._id];
        n++; wages += c.wages; uCur += c.uCur; eCur += c.eCur;
      });
      return { labels: ['本期记录数（所选期间）', '本期工资合计', '工会本期计提', '教育本期计提'],
               values: [n, fmt(wages), fmt(uCur), fmt(eCur)],
               sub: '本期计提合计（工会+教育） ' + fmt(r2(uCur + eCur)) };
    },
    attention: function(){ return []; },
    formHTML: function(){
      return unitField() +
        fgRow(
          fg('会计期间（月份）*', '<input name="period" type="month" required>'),
          fg('应付工资年开累（元）*', numInput('cum', '截至本期、扣除社保'))
        ) +
        fgRow(
          fg('工会经费比例（%）', '<input name="urate" type="text" inputmode="decimal" data-num value="2" placeholder="如：2">'),
          fg('职工教育经费比例（%）', '<input name="erate" type="text" inputmode="decimal" data-num value="8" placeholder="如：8">')
        ) +
        fgRow(
          fg('工会期初已计提（元）', numInput('uopen', '接续台账时填，仅最早一期生效')),
          fg('教育期初已计提（元）', numInput('eopen', '接续台账时填，仅最早一期生效'))
        ) +
        fg('上期工资年开累（元）', numInput('prevcum', '接续台账时填，仅最早一期生效')) +
        fg('备注', '<input name="note" type="text" placeholder="选填">') +
        '<div class="preview" id="preview">只需登记工资年开累：本期工资与两项经费由上期数据自动推算</div>';
    },
    fillForm: function(r){
      $('[name="unit"]').value = r['单位'] || '';
      $('[name="period"]').value = dateStr(r['会计期间']).slice(0, 7);
      $('[name="cum"]').value = r['工资年开累(元)'] != null ? r['工资年开累(元)'] : '';
      $('[name="urate"]').value = r['工会经费比例(%)'] != null ? r['工会经费比例(%)'] : 2;
      $('[name="erate"]').value = r['职工教育经费比例(%)'] != null ? r['职工教育经费比例(%)'] : 8;
      $('[name="uopen"]').value = r['工会期初已计提(元)'] != null ? r['工会期初已计提(元)'] : '';
      $('[name="eopen"]').value = r['教育期初已计提(元)'] != null ? r['教育期初已计提(元)'] : '';
      $('[name="prevcum"]').value = r['上期工资年开累(元)'] != null ? r['上期工资年开累(元)'] : '';
      $('[name="note"]').value = r['备注'] || '';
    },
    defaults: function(){
      /* 预填「查看期间」：与专项费用模块同理，按今天预填会让记录落错期间 */
      return { period: viewYm(), urate: 2, erate: 8 };
    },
    readForm: function(){
      var unit = $('[name="unit"]').value.trim();
      var period = $('[name="period"]').value;
      var cum = parseFloat($('[name="cum"]').value);
      var urate = parseFloat($('[name="urate"]').value);
      var erate = parseFloat($('[name="erate"]').value);
      var uopen = parseFloat($('[name="uopen"]').value);
      var eopen = parseFloat($('[name="eopen"]').value);
      var prevcum = parseFloat($('[name="prevcum"]').value);
      var note = $('[name="note"]').value.trim();
      if(!unit || !period || isNaN(cum)) return { err: '请完整填写必填项' };
      if(cum < 0) return { err: '工资年开累不能为负数' };
      if(isNaN(urate)) urate = 2;
      if(isNaN(erate)) erate = 8;
      if(urate < 0 || urate > 100 || erate < 0 || erate > 100) return { err: '计提比例需在 0～100% 之间' };
      if((!isNaN(uopen) && uopen < 0) || (!isNaN(eopen) && eopen < 0) || (!isNaN(prevcum) && prevcum < 0)) return { err: '期初/上期开累不能为负数' };
      /* 开累回退校验：不得小于同单位「紧邻的上一期」。
         与 levy.js 同一个坑：原来在遍历里直接覆盖 prevCum，最终比对的是
         「碰巧最后被遍历到」的那一期而不是期间最大的上一期，
         会静默放过工资年开累倒挂。 */
      var prevCum = null, prevYm = '';
      this.rows.forEach(function(r){
        if((r['单位'] || '') === unit && r._id !== editingId){
          var ym = dateStr(r['会计期间']).slice(0, 7);
          if(ym && ym < period && ym > prevYm){
            prevYm = ym;
            prevCum = Number(r['工资年开累(元)']) || 0;
          }
        }
      });
      if(prevCum !== null && cum < prevCum) return { err: '工资年开累（' + amt(cum) + '）不能小于上期 ' + prevYm + '（' + amt(prevCum) + '）' };
      var props = {
        '单位': { text: unit },
        '会计期间': { date: period + '-01' },
        '工资年开累(元)': { number: cum },
        '工会经费比例(%)': { number: urate },
        '职工教育经费比例(%)': { number: erate },
        '备注': { text: note }
      };
      if(!isNaN(uopen) && uopen > 0) props['工会期初已计提(元)'] = { number: uopen };
      if(!isNaN(eopen) && eopen > 0) props['教育期初已计提(元)'] = { number: eopen };
      if(!isNaN(prevcum) && prevcum > 0) props['上期工资年开累(元)'] = { number: prevcum };
      return { props: props };
    },
    onFormInput: function(){
      var pv = $('#preview'); if(!pv) return;
      var cum = parseFloat($('[name="cum"]').value);
      var ur = parseFloat($('[name="urate"]').value) || 0;
      var er = parseFloat($('[name="erate"]').value) || 0;
      if(isNaN(cum)){ pv.textContent = '只需登记工资年开累：本期工资与两项经费由上期数据自动推算'; return; }
      var prev = 0, unit = $('[name="unit"]').value.trim(), ym = $('[name="period"]').value;
      this.rows.forEach(function(r){
        if((r['单位'] || '') === unit && dateStr(r['会计期间']).slice(0, 7) < ym){
          prev = Math.max(prev, Number(r['工资年开累(元)']) || 0);
        }
      });
      var wages = Math.max(0, cum - prev);
      pv.innerHTML = '本期工资 ＝ ' + amt(cum) + ' － ' + amt(prev) + ' ＝ <strong>' + amt(wages) + '</strong> ｜ 工会 <strong>' + fmt2(r2(wages * ur / 100)) + '</strong> ｜ 教育 <strong>' + fmt2(r2(wages * er / 100)) + '</strong>（工资口径为扣除社保）';
    },
    buildPrint: function(rows, calcs, allMode){
      var pe = periodEnd();
      var want = ymStr(pe);
      var vis = allMode ? rows.slice() : rows.filter(function(r){ return dateStr(r['会计期间']).slice(0, 7) === want; });
      if(!vis.length){ toast(allMode ? '暂无经费记录' : '所选会计期间暂无经费记录'); return; }
      var sums = { w: 0, uc: 0, ua: 0, ec: 0, ea: 0 };
      var trs = vis.map(function(r, i){
        var c = calcs[r._id];
        sums.w += c.wages; sums.uc += c.uCur; sums.ua += c.uAcc; sums.ec += c.eCur; sums.ea += c.eAcc;
        return '<tr><td>' + (i + 1) + '</td>' +
          '<td>' + esc(r['单位'] || '') + '</td>' +
          '<td>' + dateStr(r['会计期间']).slice(0, 7) + '</td>' +
          '<td class="num">' + c.wages.toFixed(2) + '</td>' +
          '<td class="num">' + c.cum.toFixed(2) + '</td>' +
          '<td>' + (Number(r['工会经费比例(%)']) || 0) + '%</td>' +
          '<td class="num">' + c.uCur.toFixed(2) + '</td>' +
          '<td class="num">' + c.uAcc.toFixed(2) + '</td>' +
          '<td>' + (Number(r['职工教育经费比例(%)']) || 0) + '%</td>' +
          '<td class="num">' + c.eCur.toFixed(2) + '</td>' +
          '<td class="num">' + c.eAcc.toFixed(2) + '</td></tr>';
      }).join('');
      $('#printArea').innerHTML = '<div class="p-doc">' +
        '<h1>' + (allMode ? '工会经费、职工教育经费计提台账（开累）' : pe.getFullYear() + '年工会经费、职工教育经费明细表') + '</h1>' +
        '<div class="p-meta"><span>单位：' + esc(printUnitName()) + '</span><span>' + (allMode ? '截至 ' + ymCn(pe) : ymCn(pe)) + '</span><span>单位：元</span></div>' +
        '<table><thead><tr><th rowspan="2">序号</th><th rowspan="2">单位</th><th rowspan="2">会计期间</th><th rowspan="2">本期工资</th><th rowspan="2">工资年开累</th><th colspan="3">工会经费</th><th colspan="3">职工教育经费</th></tr>' +
        '<tr><th>计提比例</th><th>本期计提</th><th>累计计提</th><th>计提比例</th><th>本期计提</th><th>累计计提</th></tr></thead>' +
        '<tbody>' + trs + '</tbody>' +
        '<tfoot><tr><th colspan="3">合　计</th><th class="num">' + sums.w.toFixed(2) + '</th><th>—</th><th>—</th><th class="num">' + sums.uc.toFixed(2) + '</th><th class="num">' + sums.ua.toFixed(2) + '</th><th>—</th><th class="num">' + sums.ec.toFixed(2) + '</th><th class="num">' + sums.ea.toFixed(2) + '</th></tr></tfoot>' +
        '</table>' +
        signRow(['项目经理', '财务主管']) +
        '</div>';
    },
    print: function(rows, calcs){ this.buildPrint(rows, calcs, false); doPrint(true); },
    buildPrintAll: function(rows, calcs){ this.buildPrint(rows, calcs, true); },
    printAll: function(rows, calcs){ this.buildPrintAll(rows, calcs); doPrint(true); },
    seed: function(){
      var rows = [];
      [['一分公司', 8, 4800.00, 19200.00], ['二分公司', 5, 0, 0]].forEach(function(cfg){
        var cum = 0;
        for(var m = 1; m <= cfg[1]; m++){
          cum += ri(180, 250) * 1000;
          var row = { '单位': cfg[0], '会计期间': '2026-' + ('0' + m).slice(-2) + '-01',
            '工资年开累(元)': cum, '工会经费比例(%)': 2, '职工教育经费比例(%)': 8,
            '备注': m === 8 ? '工资口径为扣除社保' : '' };
          if(m === 1 && cfg[2] > 0){
            row['工会期初已计提(元)'] = cfg[2];
            row['教育期初已计提(元)'] = cfg[3];
            row['备注'] = '接续线下台账';
          }
          rows.push(row);
        }
      });
      return rows;
    }
  };

