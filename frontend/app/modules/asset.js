import { $, statusPill, toast } from '../core/dom.js';
import { amt, dateStr, fmt, fmt2, r2, ymCn, ymStr } from '../core/format.js';
import { esc, monthsBetweenYM, monthsElapsedTo, prevMonthEnd } from '../core/text.js';
import { fg, fgRow, numInput, unitField } from '../formkit.js';
import { periodEnd } from '../period.js';
import { printAssetVoucher } from '../print-facility.js';
import { doPrint, printUnitName, signRow } from '../print.js';

export const asset = {
    key: 'asset', name: '固定资产折旧', entity: '固定资产', cardTitle: '固定资产折旧台账',
    dbId: 'asset',
    cacheKey: 'wb_fin_asset_cache', formCacheKey: 'wb_fin_asset_form',
    sortField: '启用日期',
    selectFields: ['资产类型', '状态'],
    defaultOptions: { '资产类型': ['房屋构筑物', '机械设备', '运输设备', '电子设备', '其他'], '状态': ['使用中', '已提完', '已处置'] },
    filters: [ {el: 'fCat', field: '资产类型', all: '全部类型'}, {el: 'fStatus', field: '状态', all: '全部状态'} ],
    searchHay: function(r){ return String(r['资产名称'] || '') + String(r['固定资产编号'] || '') + String(r['备注'] || '') + String(r['单位'] || ''); },
    /* 期初接续（期初已折旧 + 期初截止期间）：填一次「截至某期已提 X 元」，
       之后各期在这个基数上按月往下提，不用逐月补录历史。 */
    rowCalc: function(r, pe){
      var cost = Number(r['原值(元)']) || 0;
      var residual = Number(r['残值率(%)']) || 0;
      var years = Number(r['预计使用年限(年)']) || 0;
      var totalMonths = Math.round(years * 12);
      var residualAmt = r2(cost * residual / 100);
      var total = r2(cost - residualAmt);
      var monthlyR = totalMonths > 0 ? r2(total / totalMonths) : 0;
      var openAmt = Number(r['期初已折旧(元)']) || 0;
      var openYM = dateStr(r['期初截止期间']).slice(0, 7);

      var accrued, accruedPrev, k, kPrev;
      if(openAmt > 0 && openYM){
        var after = monthsBetweenYM(openYM, ymStr(pe));
        var afterPrev = monthsBetweenYM(openYM, ymStr(prevMonthEnd(pe)));
        var fromOpen = function(n){
          if(n <= 0) return Math.min(openAmt, total);
          return r2(Math.min(openAmt + n * monthlyR, total));
        };
        accrued = fromOpen(after);
        accruedPrev = fromOpen(afterPrev);
        k = monthlyR > 0 ? Math.min(totalMonths, Math.round(accrued / monthlyR)) : 0;
        kPrev = monthlyR > 0 ? Math.min(totalMonths, Math.round(accruedPrev / monthlyR)) : 0;
      } else {
        k = Math.min(monthsElapsedTo(r['启用日期'], pe), totalMonths);
        kPrev = Math.min(monthsElapsedTo(r['启用日期'], prevMonthEnd(pe)), totalMonths);
        var chain = function(n){ return n >= totalMonths ? total : r2(Math.min(n * monthlyR, total)); };  // 期满倒挤尾差
        accrued = chain(k);
        accruedPrev = chain(kPrev);
      }
      var bear = null;
      if(r['转移至项目日期']){
        var kb = Math.min(monthsElapsedTo(r['转移至项目日期'], pe), totalMonths);
        /* 与主链一致：期满按总额倒挤尾差，且本项目承担不得超过开累折旧 */
        bear = r2(Math.min(kb >= totalMonths ? total : r2(Math.min(kb * monthlyR, total)), accrued));
      }
      return { residualAmt: residualAmt, totalMonths: totalMonths, monthly: monthlyR,
               k: k, kPrev: kPrev, cur: k - kPrev,
               curAmt: r2(accrued - accruedPrev), accrued: accrued, bear: bear,
               net: r2(cost - accrued), remain: Math.max(0, totalMonths - k),
               opening: openAmt, openingYM: openYM,
               notStarted: (openAmt > 0 && openYM) ? false : ymStr(pe) < dateStr(r['启用日期']).slice(0, 7) };
    },
    columns: [
      {h: '序号', v: function(r, c, i){ return i + 1; }},
      {h: '单位', v: function(r){ return esc(r['单位'] || ''); }},
      {h: '固定资产编号', v: function(r){ return esc(r['固定资产编号'] || ''); }},
      {h: '资产名称', v: function(r){ return '<strong>' + esc(r['资产名称'] || '') + '</strong>'; }},
      {h: '资产类型', v: function(r){ return esc(this.optText('资产类型', r['资产类型'])); }},
      {h: '预计使用年限', v: function(r){ return (Number(r['预计使用年限(年)']) || 0) + ' 年'; }},
      {h: '启用日期', v: function(r){ return dateStr(r['启用日期']); }},
      {h: '转移至项目日期', v: function(r){ return dateStr(r['转移至项目日期']) || '—'; }},
      {h: '开累折旧月份', v: function(r, c){ return c.k; }},
      {h: '原值', v: function(r){ return amt(r['原值(元)']); }, num: true},
      {h: '残值率', v: function(r){ return (Number(r['残值率(%)']) || 0) + '%'; }},
      {h: '预计残值', v: function(r, c){ return amt(c.residualAmt); }, num: true},
      {h: '本次折旧', v: function(r, c){ return c.notStarted ? '<span class="pill gone">未启用</span>' : amt(c.curAmt); }, num: true},
      {h: '开累折旧额', v: function(r, c){ return amt(c.accrued); }, num: true},
      {h: '本项目承担折旧', v: function(r, c){ return c.bear == null ? '—' : amt(c.bear); }, num: true},
      {h: '账面余额', v: function(r, c){ return amt(c.net); }, num: true},
      {h: '状态', v: function(r){ return statusPill(this.optText('状态', r['状态'])); }}
    ],
    stats: function(rows, calcs){
      var cost = 0, accrued = 0, net = 0, cur = 0, bear = 0;
      rows.forEach(function(r){
        var c = calcs[r._id];
        cost += Number(r['原值(元)']) || 0; accrued += c.accrued; net += c.net; cur += c.curAmt;
        if(c.bear != null) bear += c.bear;
      });
      return { labels: ['资产总数', '原值合计', '开累折旧额合计', '账面余额合计 / 本次折旧'],
               values: [rows.length, fmt(cost), fmt(accrued), fmt(net)], sub: '/ ' + fmt(cur) };
    },
    attention: function(rows, calcs){
      var items = [];
      rows.forEach(function(r){
        var c = calcs[r._id];
        var status = this.optText('状态', r['状态']);
        if(status !== '使用中') return;
        if(c.remain === 0){
          items.push({ row: r, level: 'over', text: '「' + (r['资产名称'] || '') + '」折旧年限已满，开累折旧 ' + fmt(c.accrued) + '，建议将状态更新为「已提完」', action: 'finish' });
        } else if(c.remain === 1 && c.cur > 0){
          items.push({ row: r, level: 'warn', text: '「' + (r['资产名称'] || '') + '」本期为最后一期折旧，本次折旧 ' + fmt2(c.curAmt), action: null });
        }
      }, this);
      return items;
    },
    finishUpdate: function(id){ return { '状态': { select: this.optId('状态', '已提完') } }; },
    voucher: function(id){ printAssetVoucher.call(this, id); },
    autoCode: 'ZC', codeField: '固定资产编号',
    formHTML: function(){
      return unitField() +
        fgRow(
          fg('固定资产编号', '<input name="code" type="text" placeholder="自动生成，可改">'),
          fg('资产名称 *', '<input name="name" type="text" required>')
        ) +
        fgRow(
          fg('资产类型 *', '<select name="type" required><option value>请选择</option></select>'),
          fg('状态', '<select name="status"><option value>请选择</option></select>')
        ) +
        fgRow(
          fg('原值（元）*', numInput('cost', '0.00')),
          fg('残值率（%）', '<input name="residual" type="text" inputmode="decimal" data-num value="5" placeholder="如：5">')
        ) +
        fgRow(
          fg('预计使用年限（年）*', '<input name="years" type="text" inputmode="decimal" data-num placeholder="如：5" required>'),
          fg('启用日期 *', '<input name="start_date" type="date" required>')
        ) +
        fg('转移至项目日期', '<input name="transfer_date" type="date" title="选填：填写后自动计算本项目承担折旧">') +
        fg('备注', '<input name="note" type="text" placeholder="选填">') +
        '<div class="fieldset-hint">期初接续：从旧账切过来时填这两项，只填一次。填了之后按期初往下提，不再从启用日期重算。</div>' +
        fgRow(
          fg('期初已折旧（元）', numInput('open_amt', '截至期初已提金额')),
          fg('期初截止期间', '<input name="open_ym" type="month" title="上面的金额是截至哪一期的">')
        ) +
        '<div class="preview" id="preview">月折旧额＝原值×(1－残值率)÷(年限×12)，启用当月起计提</div>';
    },
    fillForm: function(r){
      $('[name="unit"]').value = r['单位'] || '';
      $('[name="code"]').value = r['固定资产编号'] || '';
      $('[name="name"]').value = r['资产名称'] || '';
      $('[name="type"]').value = this.optId('资产类型', r['资产类型']) || '';
      $('[name="status"]').value = this.optId('状态', r['状态']) || '';
      $('[name="cost"]').value = r['原值(元)'] != null ? r['原值(元)'] : '';
      $('[name="residual"]').value = r['残值率(%)'] != null ? r['残值率(%)'] : 5;
      $('[name="years"]').value = r['预计使用年限(年)'] != null ? r['预计使用年限(年)'] : '';
      $('[name="start_date"]').value = dateStr(r['启用日期']);
      $('[name="transfer_date"]').value = dateStr(r['转移至项目日期']);
      $('[name="note"]').value = r['备注'] || '';
      $('[name="open_amt"]').value = r['期初已折旧(元)'] != null ? r['期初已折旧(元)'] : '';
      $('[name="open_ym"]').value = dateStr(r['期初截止期间']).slice(0, 7);
    },
    defaults: function(){
      return { residual: 5, start_date: new Date().toISOString().slice(0, 10) };
    },
    readForm: function(){
      var unit = $('[name="unit"]').value.trim();
      var code = $('[name="code"]').value.trim();
      var name = $('[name="name"]').value.trim();
      var type = $('[name="type"]').value;
      var status = $('[name="status"]').value;
      var cost = parseFloat($('[name="cost"]').value);
      var residual = parseFloat($('[name="residual"]').value) || 0;
      var years = parseFloat($('[name="years"]').value);
      var startDate = $('[name="start_date"]').value;
      var transfer = $('[name="transfer_date"]').value;
      var note = $('[name="note"]').value.trim();
      var openAmt = parseFloat($('[name="open_amt"]').value);
      var openYm = $('[name="open_ym"]').value;
      if(!unit || !name || !type || isNaN(cost) || isNaN(years) || !startDate) return { err: '请完整填写必填项' };
      if(cost <= 0) return { err: '原值必须大于 0' };
      if(years <= 0) return { err: '预计使用年限必须大于 0' };
      if(isNaN(residual)) residual = 0;
      if(residual < 0 || residual > 100) return { err: '残值率需在 0～100% 之间' };
      var hasOpenAmt = !isNaN(openAmt) && openAmt > 0;
      if(hasOpenAmt && !openYm) return { err: '填了期初已折旧，必须同时填「期初截止期间」' };
      if(!hasOpenAmt && openYm) return { err: '填了期初截止期间，必须同时填「期初已折旧（元）」' };
      if(hasOpenAmt){
        var totalDep = r2(cost - r2(cost * residual / 100));
        if(openAmt > totalDep) return { err: '期初已折旧（' + amt(openAmt) + '）不能大于应提总额（' + amt(totalDep) + '）' };
        if(openYm < dateStr(startDate).slice(0, 7)) return { err: '期初截止期间不能早于启用日期所在月' };
      }
      var props = {
        '单位': { text: unit },
        '固定资产编号': { text: code },
        '资产名称': { text: name },
        '资产类型': { select: type },
        '原值(元)': { number: cost },
        '残值率(%)': { number: residual },
        '预计使用年限(年)': { number: years },
        '启用日期': { date: startDate },
        '备注': { text: note }
      };
      if(transfer) props['转移至项目日期'] = { date: transfer };
      if(status) props['状态'] = { select: status };
      else props['状态'] = { select: this.optId('状态', '使用中') };
      if(hasOpenAmt){
        props['期初已折旧(元)'] = { number: openAmt };
        props['期初截止期间'] = { date: openYm + '-01' };
      }
      return { props: props };
    },
    onFormInput: function(){
      var pv = $('#preview'); if(!pv) return;
      var cost = parseFloat($('[name="cost"]').value) || 0;
      var residual = parseFloat($('[name="residual"]').value) || 0;
      var years = parseFloat($('[name="years"]').value) || 0;
      var openAmt = parseFloat($('[name="open_amt"]').value) || 0;
      var openYm = $('[name="open_ym"]').value;
      if(cost && years){
        var total = r2(cost - r2(cost * residual / 100));
        var monthly = r2(total / Math.round(years * 12));
        if(openAmt > 0 && openYm){
          var left = r2(total - openAmt);
          pv.innerHTML = '期初接续：截至 <strong>' + openYm + '</strong> 已提 <strong>' + fmt2(openAmt) +
            '</strong> ｜ 月折旧额 <strong>' + fmt2(monthly) + '</strong> ｜ 剩余 <strong>' + fmt2(left) +
            '</strong>（约 ' + (monthly > 0 ? Math.ceil(left / monthly) : 0) + ' 期）';
          return;
        }
        var extra = $('[name="transfer_date"]').value ? '；填写转移日期后自动核算本项目承担折旧' : '';
        pv.innerHTML = '预计残值 <strong>' + fmt2(r2(cost * residual / 100)) + '</strong> ｜ 月折旧额 <strong>' + fmt2(monthly) + '</strong>' + extra;
      } else pv.textContent = '月折旧额＝原值×(1－残值率)÷(年限×12)，启用当月起计提';
    },
    buildPrint: function(rows, calcs){
      if(!rows.length){ toast('暂无数据可打印'); return; }
      var pe = periodEnd();
      var sums = { cost: 0, res: 0, cur: 0, acc: 0, bear: 0, net: 0 };
      var trs = rows.map(function(r, i){
        var c = calcs[r._id];
        sums.cost += Number(r['原值(元)']) || 0; sums.res += c.residualAmt;
        sums.cur += c.curAmt; sums.acc += c.accrued; sums.net += c.net;
        if(c.bear != null) sums.bear += c.bear;
        return '<tr><td>' + (i + 1) + '</td>' +
          '<td>' + esc(r['单位'] || '') + '</td>' +
          '<td>' + esc(r['固定资产编号'] || '') + '</td>' +
          '<td style="text-align:left">' + esc(r['资产名称']) + '</td>' +
          '<td>' + esc(this.optText('资产类型', r['资产类型'])) + '</td>' +
          '<td>' + (Number(r['预计使用年限(年)']) || 0) + '</td>' +
          '<td>' + c.k + '</td>' +
          '<td class="num">' + ((Number(r['原值(元)']) || 0)).toFixed(2) + '</td>' +
          '<td>' + (Number(r['残值率(%)']) || 0) + '%</td>' +
          '<td class="num">' + c.residualAmt.toFixed(2) + '</td>' +
          '<td class="num">' + c.curAmt.toFixed(2) + '</td>' +
          '<td class="num">' + c.accrued.toFixed(2) + '</td>' +
          '<td class="num">' + (c.bear == null ? '—' : c.bear.toFixed(2)) + '</td>' +
          '<td class="num">' + c.net.toFixed(2) + '</td></tr>';
      }, this).join('');
      $('#printArea').innerHTML = '<div class="p-doc">' +
        '<h1>固定资产折旧明细表</h1>' +
        '<div class="p-meta"><span>单位：' + esc(printUnitName()) + '</span><span>' + ymCn(pe) + '</span><span>单位：元</span></div>' +
        '<table><thead><tr><th>序号</th><th>单位</th><th>固定资产编号</th><th>资产名称</th><th>资产类型</th><th>预计使用年限</th><th>开累折旧月份</th><th>原值</th><th>残值率</th><th>预计残值</th><th>本次折旧</th><th>开累折旧额</th><th>本项目承担折旧</th><th>账面余额</th></tr></thead>' +
        '<tbody>' + trs + '</tbody>' +
        '<tfoot><tr><th colspan="7">合　计</th><th class="num">' + sums.cost.toFixed(2) + '</th><th>—</th><th class="num">' + sums.res.toFixed(2) + '</th><th class="num">' + sums.cur.toFixed(2) + '</th><th class="num">' + sums.acc.toFixed(2) + '</th><th class="num">' + sums.bear.toFixed(2) + '</th><th class="num">' + sums.net.toFixed(2) + '</th></tr></tfoot>' +
        '</table>' +
        signRow(['项目经理', '设备部门', '财务部长', '制表']) +
        '</div>';
    },
    print: function(rows, calcs){ this.buildPrint(rows, calcs); doPrint(true); },
    buildPrintAll: function(rows, calcs){
      if(!rows.length){ toast('暂无数据可打印'); return; }
      var pe = periodEnd();
      var trs = rows.map(function(r, i){
        var c = calcs[r._id];
        return '<tr><td>' + (i + 1) + '</td>' +
          '<td>' + esc(r['单位'] || '') + '</td>' +
          '<td>' + esc(r['固定资产编号'] || '') + '</td>' +
          '<td style="text-align:left">' + esc(r['资产名称']) + '</td>' +
          '<td>' + esc(this.optText('资产类型', r['资产类型'])) + '</td>' +
          '<td>' + dateStr(r['启用日期']) + '</td>' +
          '<td>' + (dateStr(r['转移至项目日期']) || '—') + '</td>' +
          '<td>' + (Number(r['预计使用年限(年)']) || 0) + '</td>' +
          '<td>' + c.k + '/' + c.totalMonths + '</td>' +
          '<td class="num">' + ((Number(r['原值(元)']) || 0)).toFixed(2) + '</td>' +
          '<td class="num">' + c.monthly.toFixed(2) + '</td>' +
          '<td class="num">' + c.accrued.toFixed(2) + '</td>' +
          '<td class="num">' + (c.bear == null ? '—' : c.bear.toFixed(2)) + '</td>' +
          '<td class="num">' + c.net.toFixed(2) + '</td>' +
          '<td>' + esc(this.optText('状态', r['状态'])) + '</td></tr>';
      }, this).join('');
      $('#printArea').innerHTML = '<div class="p-doc">' +
        '<h1>固定资产台账（全量）</h1>' +
        '<div class="p-meta"><span>单位：' + esc(printUnitName()) + '</span><span>截至 ' + ymCn(pe) + '</span><span>单位：元</span></div>' +
        '<table><thead><tr><th>序号</th><th>单位</th><th>固定资产编号</th><th>资产名称</th><th>资产类型</th><th>启用日期</th><th>转移至项目</th><th>年限(年)</th><th>已摊/共(月)</th><th>原值</th><th>月折旧额</th><th>开累折旧额</th><th>本项目承担</th><th>账面余额</th><th>状态</th></tr></thead>' +
        '<tbody>' + trs + '</tbody></table>' +
        signRow(['项目经理', '设备部门', '财务部长', '制表']) +
        '</div>';
    },
    printAll: function(rows, calcs){ this.buildPrintAll(rows, calcs); doPrint(true); },
    seed: function(){
      var defs = [
        ['一分公司', '液压挖掘机', '机械设备', 786000, 10, '2024-07-10', '2024-10-01'],
        ['一分公司', '装载机', '机械设备', 325000, 10, '2024-09-15', ''],
        ['一分公司', '自卸货车', '运输设备', 268000, 8, '2025-01-10', '2025-03-01'],
        ['一分公司', '皮卡指挥车', '运输设备', 145000, 8, '2025-03-20', ''],
        ['二分公司', '全站仪', '电子设备', 86000, 3, '2025-05-15', '2025-06-01'],
        ['二分公司', '水准仪', '电子设备', 21000, 3, '2025-05-15', ''],
        ['二分公司', '台式电脑', '电子设备', 7200, 3, '2023-08-10', '2024-01-05'],
        ['二分公司', '笔记本电脑', '电子设备', 9800, 3, '2025-09-01', ''],
        ['三分公司', '柜式空调', '电子设备', 6800, 3, '2025-02-18', ''],
        ['三分公司', '柴油发电机', '机械设备', 52000, 10, '2024-12-05', '2025-02-01'],
        ['三分公司', '直流电焊机', '机械设备', 12800, 10, '2025-04-22', ''],
        ['三分公司', '活动板房', '房屋构筑物', 96000, 5, '2025-06-12', '']
      ];
      return defs.map(function(x, i){
        return { '单位': x[0], '固定资产编号': 'ZC-' + x[5].slice(0, 4) + '-' + ('00' + (i + 1)).slice(-3),
          '资产名称': x[1], '资产类型': x[2], '原值(元)': x[3], '残值率(%)': 5,
          '预计使用年限(年)': x[4], '启用日期': x[5], '转移至项目日期': x[6],
          '状态': '使用中', '备注': '' };
      });
    }
  };

