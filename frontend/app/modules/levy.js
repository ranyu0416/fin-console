import { $, toast } from '../core/dom.js';
import { amt, dateStr, fmt, fmt2, r2, ymCn, ymLabel, ymStr } from '../core/format.js';
import { editingId } from '../core/state.js';
import { esc } from '../core/text.js';
import { fg, fgRow, numInput, projectField, refreshProjectOptions, unitField } from '../formkit.js';
import { periodEnd, viewYm } from '../period.js';
import { doPrint, printUnitName } from '../print.js';

export const levy = {
    key: 'levy', name: '专项费用', entity: '专项费用', cardTitle: '专项费用计提台账',
    periodDisplay: true, periodField: '会计期间',
    cardHint: '',
    companyName: '示例集团有限公司',
    dbId: 'levy',
    cacheKey: 'wb_fin_levy_cache', formCacheKey: 'wb_fin_levy_form',
    sortField: '会计期间',
    selectFields: [],
    defaultOptions: {},
    filters: [ {el: 'fCat', field: '项目名称', all: '全部项目', distinct: true} ],
    searchHay: function(r){ return String(r['项目名称'] || '') + String(r['备注'] || '') + String(r['单位'] || ''); },
    dupKey: function(r){ return (r['单位'] || '') + '|' + (r['项目名称'] || '') + '|' + dateStr(r['会计期间']).slice(0, 7); },
    dupHint: '同一单位、同一项目、同一会计期间已有记录',
    /* 链式口径：当期产值＝本期开累－上期开累；本期计提＝ROUND(当期产值×比例)；
       累计计提＝上期累计计提＋本期计提（期初已计提作为链的起点，用于接续纸质台账） */
    calcAll: function(rows){
      var out = {}, chains = {}, yearRun = {}, opening = {};
      var sorted = rows.slice().sort(function(a, b){
        return dateStr(a['会计期间']) < dateStr(b['会计期间']) ? -1 : 1;
      });
      sorted.forEach(function(r){
        var key = (r['单位'] || '') + '|' + (r['项目名称'] || '');
        if(!chains[key]){
          chains[key] = {cum: 0, acc: 0};
          var open0 = Number(r['期初已计提(元)']) || 0;        // 最早一期填写的期初作为链起点
          var prevCum0 = Number(r['上期累计产值(元)']) || 0; // 上期开累基数，避免首期把历史产值全算进当期
          if(open0 > 0){ chains[key].acc = open0; opening[key] = open0; }
          if(prevCum0 > 0) chains[key].cum = prevCum0;
        }
        var ch = chains[key];
        var cum = Number(r['累计产值(元)']) || 0;
        var rate = Number(r['计提比例(%)']) || 0;
        var base = Math.max(0, r2(cum - ch.cum));
        var curAmt = r2(base * rate / 100);
        var acc = r2(ch.acc + curAmt);
        var yk = key + '#' + dateStr(r['会计期间']).slice(0, 4);
        yearRun[yk] = r2((yearRun[yk] || 0) + curAmt);
        out[r._id] = { base: base, cum: cum, rate: rate, curAmt: curAmt, accrued: acc, yearAcc: yearRun[yk], opening: opening[key] || 0 };
        ch.cum = cum; ch.acc = acc;
      });
      return out;
    },
    columns: [
      {h: '序号', v: function(r, c, i){ return i + 1; }},
      {h: '单位', v: function(r){ return esc(r['单位'] || ''); }},
      {h: '项目名称', v: function(r){ return '<strong>' + esc(r['项目名称'] || '') + '</strong>'; }},
      {h: '会计期间', v: function(r){ return ymLabel(r['会计期间']); }},
      {h: '当期产值', v: function(r, c){ return amt(c.base); }, num: true},
      {h: '累计产值', v: function(r, c){ return amt(c.cum); }, num: true},
      {h: '计提比例', v: function(r, c){ return c.rate + '%'; }},
      {h: '本期计提金额', v: function(r, c){ return amt(c.curAmt); }, num: true},
      {h: '累计计提金额', v: function(r, c){ return amt(c.accrued); }, num: true},
      {h: '当年计提金额', v: function(r, c){ return amt(c.yearAcc); }, num: true},
      {h: '备注', v: function(r){ return esc(r['备注'] || ''); }}
    ],
    stats: function(rows, calcs){
      var want = ymStr(periodEnd());
      var base = 0, cur = 0, n = 0;
      rows.forEach(function(r){
        if(dateStr(r['会计期间']).slice(0, 7) !== want) return;
        var c = calcs[r._id];
        n++; base += c.base; cur += c.curAmt;
      });
      var rate = base ? r2(cur / base * 100) : 0;
      return { labels: ['本期记录数（所选期间）', '当期产值合计', '本期计提合计', '本期加权计提率'],
               values: [n, fmt(base), fmt(cur), rate.toFixed(2) + '%'], sub: '仅显示所选期间；累计计提在打印/Excel明细中保留' };
    },
    attention: function(){ return []; },
    formHTML: function(){
      return unitField() +
        projectField() +
        fgRow(
          fg('会计期间（月份）*', '<input name="period" type="month" required>'),
          fg('计提比例（%）*', '<input name="rate" type="text" inputmode="decimal" data-num value="3" placeholder="如：3">')
        ) +
        fg('累计产值（元）*', numInput('cum', '截至本期的开累产值')) +
        fgRow(
          fg('上期累计产值（元）', numInput('prevcum', '接续台账时填，仅最早一期生效')),
          fg('期初已计提金额（元）', numInput('opening', '接续台账时填，仅最早一期生效'))
        ) +
        fg('备注', '<input name="note" type="text" placeholder="选填">') +
        '<div class="preview" id="preview">只需登记开累产值：当期产值与本期计提由上期数据自动推算</div>';
    },
    fillForm: function(r){
      $('[name="unit"]').value = r['单位'] || '';
      /* 项目下拉随单位联动，必须先设单位再刷新选项 */
      refreshProjectOptions($('#form'), r['项目名称'] || '');
      var projEl = $('[name="proj"]');
      if(projEl && projEl.tagName !== 'SELECT') projEl.value = r['项目名称'] || '';
      $('[name="period"]').value = dateStr(r['会计期间']).slice(0, 7);
      $('[name="rate"]').value = r['计提比例(%)'] != null ? r['计提比例(%)'] : 3;
      /* 编辑既有记录时以记录里的比例为准：标记这个比例已对应当前项目，
         别让紧随其后的 onFormInput 拿清单默认值把它冲掉 */
      $('[name="rate"]').setAttribute('data-for-proj', r['项目名称'] || '');
      $('[name="cum"]').value = r['累计产值(元)'] != null ? r['累计产值(元)'] : '';
      $('[name="prevcum"]').value = r['上期累计产值(元)'] != null ? r['上期累计产值(元)'] : '';
      $('[name="opening"]').value = r['期初已计提(元)'] != null ? r['期初已计提(元)'] : '';
      $('[name="note"]').value = r['备注'] || '';
    },
    defaults: function(){
      /* 预填「查看期间」而不是今天的日期：账套停在 4 月时按今天预填成 8 月，
         记录会落到当前筛选之外且脱钩于结转链条，看起来像凭空消失 */
      return { period: viewYm(), rate: 3 };
    },
    readForm: function(){
      var unit = $('[name="unit"]').value.trim();
      var proj = $('[name="proj"]').value.trim();
      var period = $('[name="period"]').value;
      var rate = parseFloat($('[name="rate"]').value);
      var cum = parseFloat($('[name="cum"]').value);
      var prevcum = parseFloat($('[name="prevcum"]').value);
      var opening = parseFloat($('[name="opening"]').value);
      var note = $('[name="note"]').value.trim();
      if(!unit || !proj || !period || isNaN(rate) || isNaN(cum)) return { err: '请完整填写必填项' };
      if(cum < 0) return { err: '累计产值不能为负数' };
      if(rate < 0 || rate > 100) return { err: '计提比例需在 0～100% 之间' };
      if((!isNaN(prevcum) && prevcum < 0) || (!isNaN(opening) && opening < 0)) return { err: '上期开累/期初已计提不能为负数' };
      /* 开累回退校验：不得小于同项目「紧邻的上一期」。
         注意必须取期间最大的那一条，不能像原来那样在遍历里直接覆盖 prevCum——
         rows 的顺序取决于服务端排序和后续增删，覆盖式写法最后留下的是
         「碰巧最后被遍历到」的那一期，可能是 1 月而不是 2 月。
         结果是：2 月开累 800 万、3 月录 500 万这种明显的回退，会因为比对了
         1 月的 300 万而被判合规，静默放过一次开累倒挂。 */
      var prevCum = null, prevYm = '';
      this.rows.forEach(function(r){
        if((r['单位'] || '') === unit && (r['项目名称'] || '') === proj && r._id !== editingId){
          var ym = dateStr(r['会计期间']).slice(0, 7);
          if(ym && ym < period && ym > prevYm){
            prevYm = ym;
            prevCum = Number(r['累计产值(元)']) || 0;
          }
        }
      });
      if(prevCum !== null && cum < prevCum) return { err: '累计产值（' + amt(cum) + '）不能小于上期 ' + prevYm + '（' + amt(prevCum) + '）' };
      var props = {
        '单位': { text: unit },
        '项目名称': { text: proj },
        '会计期间': { date: period + '-01' },
        '累计产值(元)': { number: cum },
        '计提比例(%)': { number: rate },
        '备注': { text: note }
      };
      if(!isNaN(opening) && opening > 0) props['期初已计提(元)'] = { number: opening };
      if(!isNaN(prevcum) && prevcum > 0) props['上期累计产值(元)'] = { number: prevcum };
      return { props: props };
    },
    onFormInput: function(){
      /* 单位变了要重刷项目选项；选中的项目若在清单里登记了比例，就带出来。
         只在「项目发生切换」时覆盖一次，之后用户手改的比例不再被冲掉。 */
      var rateFromList = refreshProjectOptions($('#form'));
      var rateEl = $('[name="rate"]'), projEl = $('[name="proj"]');
      var projNow = projEl ? projEl.value : '';
      if(rateEl && rateFromList != null && rateEl.getAttribute('data-for-proj') !== projNow){
        rateEl.value = rateFromList;
        rateEl.setAttribute('data-for-proj', projNow);
      }
      var pv = $('#preview'); if(!pv) return;
      var cum = parseFloat($('[name="cum"]').value);
      var rate = parseFloat($('[name="rate"]').value) || 0;
      if(isNaN(cum)){ pv.textContent = '只需登记开累产值：当期产值与本期计提由上期数据自动推算'; return; }
      var prev = 0;
      var ym = $('[name="period"]').value, unit = $('[name="unit"]').value.trim(), proj = $('[name="proj"]').value.trim();
      this.rows.forEach(function(r){
        if((r['单位'] || '') === unit && (r['项目名称'] || '') === proj &&
           dateStr(r['会计期间']).slice(0, 7) < ym){
          prev = Math.max(prev, Number(r['累计产值(元)']) || 0);
        }
      });
      var base = Math.max(0, cum - prev);
      pv.innerHTML = '当期产值 ＝ ' + amt(cum) + ' － ' + amt(prev) + ' ＝ <strong>' + amt(base) + '</strong> ｜ 本期计提（' + rate + '%）＝ <strong>' + fmt2(r2(base * rate / 100)) + '</strong>';
    },
    buildPrint: function(rows, calcs, allMode){
      var pe = periodEnd();
      var want = ymStr(pe);
      var vis = allMode ? rows.slice() : rows.filter(function(r){ return dateStr(r['会计期间']).slice(0, 7) === want; });
      if(!vis.length){ toast(allMode ? '暂无专项费用记录' : '所选会计期间暂无专项费用记录'); return; }
      var unitName = printUnitName();
      var trs = vis.map(function(r){
        var c = calcs[r._id];
        return '<tr>' +
          '<td style="text-align:left">' + esc(r['项目名称']) + '</td>' +
          '<td>' + ymLabel(r['会计期间']) + '</td>' +
          '<td class="num">' + c.base.toFixed(2) + '</td>' +
          '<td class="num">' + c.cum.toFixed(2) + '</td>' +
          '<td>' + c.rate + '%</td>' +
          '<td class="num">' + c.curAmt.toFixed(2) + '</td>' +
          '<td class="num">' + c.accrued.toFixed(2) + '</td>' +
          '<td style="text-align:left">' + esc(r['备注'] || '') + '</td></tr>';
      }).join('');
      /* 月报保留官方表手工填写区；开累打印不补空行 */
      if(!allMode){
        var minRows = 6;
        for(var bi = vis.length; bi < minRows; bi++){
          trs += '<tr><td>　</td><td>　</td><td>　</td><td>　</td><td>　</td><td>　</td><td>　</td><td>　</td></tr>';
        }
      }
      $('#printArea').innerHTML = '<div class="p-doc">' +
        '<div class="p-box">' +
          '<div class="p-company">' + esc(this.companyName) + '</div>' +
          '<div class="p-title2">专项费用' + (allMode ? '计提台账（开累）' : '计提表') + '</div>' +
          '<div class="p-meta2"><span>编制单位：' + esc(unitName) + '</span><span>' + (allMode ? '截至 ' + ymCn(pe) : pe.getFullYear() + '　年　' + (pe.getMonth() + 1) + '　月') + '</span><span>单位：元</span></div>' +
          '<table><thead><tr><th style="width:24%">项目名称</th><th>会计期间</th><th>当期产值</th><th>累计产值</th><th>计提比例</th><th>本期计提金额</th><th>累计计提金额</th><th style="width:10%">备注</th></tr></thead>' +
          '<tbody>' + trs + '</tbody></table>' +
          '<div class="p-sign2"><span>项目经理：</span><span>安全总监：</span><span>安全部门：</span><span>计划部门：</span><span>财务部门：</span></div>' +
        '</div>' +
        '</div>';
    },
    print: function(rows, calcs){ this.buildPrint(rows, calcs, false); doPrint(true); },
    buildPrintAll: function(rows, calcs){ this.buildPrint(rows, calcs, true); },
    printAll: function(rows, calcs){ this.buildPrintAll(rows, calcs); doPrint(true); },
    seed: function(){
      var projs = [
        { unit: '一分公司', name: '示例项目A', rate: 3, opening: 1700000, prevcum: 68000000, cums: [69000000, 70000000, 71500000, 73000000] },
        { unit: '二分公司', name: '示例项目B', rate: 2.5, opening: 0, prevcum: 0, cums: [2000000, 3500000, 6000000] }
      ];
      var rows = [];
      projs.forEach(function(p){
        var periods = p.cums.map(function(_, i){ return 2026 - 0 + '-' + ('0' + (8 - (p.cums.length - 1 - i))).slice(-2); });
        p.cums.forEach(function(cum, i){
          var row = { '单位': p.unit, '项目名称': p.name, '会计期间': periods[i] + '-01',
            '累计产值(元)': cum, '计提比例(%)': p.rate, '备注': '' };
          if(i === 0){
            if(p.opening > 0) row['期初已计提(元)'] = p.opening;
            if(p.prevcum > 0) row['上期累计产值(元)'] = p.prevcum;
            if(p.opening > 0 || p.prevcum > 0) row['备注'] = '接续线下台账';
          }
          rows.push(row);
        });
      });
      return rows;
    }
  };

