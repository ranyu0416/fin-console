import { $, statusPill } from '../core/dom.js';
import { amt, dateStr, fmt, fmt2, r2, ymStr } from '../core/format.js';
import { esc, monthsBetweenYM, monthsElapsedTo, prevMonthEnd } from '../core/text.js';
import { fg, fgRow, numInput, unitField } from '../formkit.js';
import { printTfaLedger, printTfaMonthly, printTfaVoucher } from '../print-facility.js';
import { doPrint } from '../print.js';

export const facility = {
    key: 'facility', name: '设施摊销', entity: '设施', cardTitle: '摊销台账',
    dbId: 'facility',
    cacheKey: 'wb_fin_facility_cache', formCacheKey: 'wb_fin_facility_form',
    sortField: '启用日期',
    selectFields: ['设施类别', '摊销方法', '状态'],
    defaultOptions: {
      '设施类别': ['房屋类设施', '构筑物类设施', '其他设施'],
      '摊销方法': ['直线法', '一次性摊销'],
      '状态': ['使用中', '已摊完', '已清理']
    },
    filters: [ {el: 'fCat', field: '设施类别', all: '全部类别'}, {el: 'fStatus', field: '状态', all: '全部状态'} ],
    searchHay: function(r){
      return String(r['设施名称'] || '') + String(r['备注'] || '') + String(r['成本对象'] || '') + String(r['单位'] || '');
    },
    hasCostObj: false, schemaFields: {}, autoCode: 'TFA', codeField: '设施编号',
    /* 口径：月摊销额取整到分；开累＝截至上期＋本期（本期含入账月补提），末期倒挤尾差；
       入账日期晚于启用日期时，入账月自动补提此前各月，入账前不计提。

       期初接续（期初已摊销 + 期初截止期间）：
       从纸质台账或旧系统切过来时，不必把历史各期逐月补录。填一次「截至某期已摊 X 元」，
       之后各期就在这个基数上按月往下摊。填了期初的行，摊销完全以期初为起点计算，
       不再走入账月补提那套逻辑——否则会和期初重复计提。 */
    rowCalc: function(r, pe){
      var cost = Number(r['原值(元)']) || 0;
      var residual = Number(r['残值率(%)']) || 0;
      var months = Number(r['摊销期限(月)']) || 0;
      var method = this.optText('摊销方法', r['摊销方法']);
      var residualAmt = r2(cost * residual / 100);
      var total = r2(cost - residualAmt);
      var eff = method === '一次性摊销' ? 1 : months;
      var bookYM = dateStr(r['入账日期'] || r['启用日期']).slice(0, 7);
      var peYM = ymStr(pe);
      var monthlyR = eff > 0 ? r2(total / eff) : 0;
      var openAmt = Number(r['期初已摊销(元)']) || 0;
      var openYM = dateStr(r['期初截止期间']).slice(0, 7);

      if(openAmt > 0 && openYM){
        /* 期初接续：以「截至 openYM 已摊 openAmt」为起点，之后每月加一期 */
        var after = monthsBetweenYM(openYM, peYM);            // 本期距期初多少个月（≤0 表示还在期初之内）
        var afterPrev = monthsBetweenYM(openYM, ymStr(prevMonthEnd(pe)));
        function fromOpen(n){
          if(n <= 0) return Math.min(openAmt, total);
          return r2(Math.min(openAmt + n * monthlyR, total));
        }
        var accO = fromOpen(after);
        var accPrevO = fromOpen(afterPrev);
        var doneMonths = monthlyR > 0 ? Math.min(eff, Math.round(accO / monthlyR)) : 0;
        return { residualAmt: residualAmt, total: total, monthly: monthlyR,
                 k: doneMonths, kPrev: monthlyR > 0 ? Math.min(eff, Math.round(accPrevO / monthlyR)) : 0,
                 cur: accO > accPrevO ? 1 : 0,
                 accrued: accO, accruedPrev: accPrevO,
                 curAmt: r2(accO - accPrevO), net: r2(cost - accO),
                 remain: monthlyR > 0 ? Math.max(0, Math.ceil(r2(total - accO) / monthlyR)) : 0,
                 progress: total > 0 ? Math.min(1, accO / total) : 0,
                 opening: openAmt, openingYM: openYM,
                 notStarted: false };
      }

      var k = Math.min(monthsElapsedTo(r['启用日期'], pe), eff);
      var kPrev = Math.min(monthsElapsedTo(r['启用日期'], prevMonthEnd(pe)), eff);
      function chain(n){ return n >= eff ? total : r2(Math.min(n * monthlyR, total)); }  // 期满倒挤尾差
      var accrued = 0, accruedPrev = 0;
      if(peYM >= bookYM){          // 入账后（含入账当月）才在账面体现
        accrued = chain(k);
        accruedPrev = peYM === bookYM ? 0 : chain(kPrev);
      }
      return { residualAmt: residualAmt, total: total, monthly: monthlyR,
               k: peYM >= bookYM ? k : 0, kPrev: kPrev, cur: peYM >= bookYM ? (k - kPrev) : 0,
               accrued: accrued, accruedPrev: accruedPrev,
               curAmt: r2(accrued - accruedPrev), net: r2(cost - accrued),
               remain: Math.max(0, eff - k), progress: total > 0 ? Math.min(1, accrued / total) : 0,
               opening: 0, openingYM: '',
               notStarted: peYM < dateStr(r['启用日期']).slice(0, 7) };
    },
    columns: [
      {h: '序号', v: function(r, c, i){ return i + 1; }},
      {h: '设施编号', v: function(r){ return esc(r['设施编号'] || ''); }, gated: '设施编号'},
      {h: '单位', v: function(r){ return esc(r['单位'] || ''); }},
      {h: '设施类别', v: function(r){ return esc(this.optText('设施类别', r['设施类别'])); }},
      {h: '设施名称', v: function(r){ return '<strong>' + esc(r['设施名称'] || '') + '</strong>'; }},
      {h: '成本对象', v: function(r){ return esc(r['成本对象'] || ''); }, gated: '成本对象'},
      {h: '入账日期', v: function(r){ return dateStr(r['入账日期'] || r['启用日期']); }},
      {h: '启用日期', v: function(r){ return dateStr(r['启用日期']); }},
      {h: '原值', v: function(r){ return amt(r['原值(元)']); }, num: true},
      {h: '残值率', v: function(r){ return (Number(r['残值率(%)']) || 0) + '%'; }},
      {h: '预计净残值', v: function(r, c){ return amt(c.residualAmt); }, num: true},
      {h: '应摊销月份', v: function(r){ return Number(r['摊销期限(月)']) || 0; }},
      {h: '本期摊销月份', v: function(r, c){ return c.notStarted ? '<span class="pill gone">未启用</span>' : (c.cur > 0 && c.accruedPrev === 0 && c.k > 1 ? c.k + '（补提）' : c.cur); }},
      {h: '开累摊销月份', v: function(r, c){ return c.k; }},
      {h: '截至上期摊销金额', v: function(r, c){ return amt(c.accruedPrev); }, num: true},
      {h: '本月摊销金额', v: function(r, c){ return amt(c.curAmt); }, num: true},
      {h: '开累摊销金额', v: function(r, c){ return amt(c.accrued); }, num: true},
      {h: '本月末账面净值', v: function(r, c){ return amt(c.net); }, num: true},
      {h: '状态', v: function(r){ return statusPill(this.optText('状态', r['状态'])); }}
    ],
    stats: function(rows, calcs){
      var cost = 0, accrued = 0, net = 0, cur = 0;
      rows.forEach(function(r){
        var c = calcs[r._id];
        cost += Number(r['原值(元)']) || 0; accrued += c.accrued; net += c.net; cur += c.curAmt;
      });
      return { labels: ['设施总数', '原值合计', '开累摊销金额', '净值合计 / 本月摊销金额'],
               values: [rows.length, fmt(cost), fmt(accrued), fmt(net)], sub: '/ ' + fmt(cur) };
    },
    groupStats: function(vis, calcs){
      function tbl(title, keyFn){
        var g = {};
        vis.forEach(function(r){
          var c = calcs[r._id];
          var key = keyFn(r) || '（未设置）';
          if(!g[key]) g[key] = {n: 0, cost: 0, cur: 0, acc: 0, net: 0};
          var o = g[key];
          o.n++; o.cost += Number(r['原值(元)']) || 0; o.cur += c.curAmt; o.acc += c.accrued; o.net += c.net;
        });
        return '<table><thead><tr><th>' + title + '</th><th>数量</th><th class="num">原值</th><th class="num">本月摊销</th><th class="num">开累摊销</th><th class="num">净值</th></tr></thead><tbody>' +
          Object.keys(g).sort().map(function(k2){
            var o = g[k2];
            return '<tr><td>' + esc(k2) + '</td><td>' + o.n + '</td><td class="num">' + amt(o.cost) + '</td><td class="num">' + amt(o.cur) + '</td><td class="num">' + amt(o.acc) + '</td><td class="num">' + amt(o.net) + '</td></tr>';
          }).join('') + '</tbody></table>';
      }
      return tbl('设施类别', function(r){ return this.optText('设施类别', r['设施类别']); }.bind(this)) +
             tbl('成本对象', function(r){ return r['成本对象']; });
    },
    attention: function(rows, calcs){
      var items = [];
      rows.forEach(function(r){
        var c = calcs[r._id];
        var status = this.optText('状态', r['状态']);
        if(status === '已清理') return;
        if(c.progress >= 1 && c.remain === 0 && status === '使用中'){
          items.push({ row: r, level: 'over', text: '「' + (r['设施名称'] || '') + '」摊销期限已满，开累摊销 ' + fmt(c.accrued) + '，建议将状态更新为「已摊完」', action: 'finish' });
        } else if(status === '使用中' && c.remain === 1 && c.cur > 0){
          items.push({ row: r, level: 'warn', text: '「' + (r['设施名称'] || '') + '」本期为最后一期摊销，本月摊销金额 ' + fmt2(c.curAmt), action: null });
        }
      }, this);
      return items;
    },
    finishUpdate: function(id){ return { '状态': { select: this.optId('状态', '已摊完') } }; },
    autoCode: 'TFA',
    formHTML: function(){
      return fgRow(
        fg('设施编号', '<input name="code" type="text" placeholder="自动生成，可改">'),
        unitField()
      ) +
        fg('设施名称 *', '<input name="name" type="text" placeholder="如：项目部办公板房" required>') +
        fgRow(
          fg('设施类别 *', '<select name="category" required><option value>请选择</option></select>'),
          fg('摊销方法 *', '<select name="method" required><option value>请选择</option></select>')
        ) +
        fgRow(
          fg('原值（元）*', numInput('cost', '0.00')),
          fg('残值率（%）', '<input name="residual" type="text" inputmode="decimal" data-num value="5" placeholder="如：5">')
        ) +
        fgRow(
          fg('启用日期 *', '<input name="start_date" type="date" required title="摊销自启用当月起算">'),
          fg('入账日期 *', '<input name="book_date" type="date" required title="晚于启用日期时，入账月自动补提之前各月">')
        ) +
        fgRow(
          fg('摊销期限（月）*', '<input name="months" type="text" inputmode="numeric" data-num placeholder="如：24" required>'),
          fg('状态', '<select name="status"><option value>请选择</option></select>')
        ) +
        fgRow(
          fg('成本对象', '<input name="costobj" type="text" placeholder="如：xx项目部">'),
          fg('备注', '<input name="note" type="text" placeholder="选填">')
        ) +
        '<div class="fieldset-hint">期初接续：从纸质台账或旧系统切过来时填这两项，只填一次。填了之后本模块按期初往下摊，不再补提历史各月。</div>' +
        fgRow(
          fg('期初已摊销（元）', numInput('open_amt', '截至期初已摊金额')),
          fg('期初截止期间', '<input name="open_ym" type="month" title="上面的金额是截至哪一期的">')
        ) +
        '<div class="preview" id="preview">填写原值、残值率与期限后，自动计算月摊销额</div>';
    },
    fillForm: function(r){
      $('[name="code"]').value = r['设施编号'] || '';
      $('[name="name"]').value = r['设施名称'] || '';
      $('[name="unit"]').value = r['单位'] || '';
      $('[name="category"]').value = this.optId('设施类别', r['设施类别']) || '';
      $('[name="method"]').value = this.optId('摊销方法', r['摊销方法']) || '';
      $('[name="cost"]').value = r['原值(元)'] != null ? r['原值(元)'] : '';
      $('[name="residual"]').value = r['残值率(%)'] != null ? r['残值率(%)'] : 5;
      $('[name="start_date"]').value = dateStr(r['启用日期']);
      $('[name="book_date"]').value = dateStr(r['入账日期'] || r['启用日期']);
      $('[name="months"]').value = r['摊销期限(月)'] != null ? r['摊销期限(月)'] : '';
      $('[name="status"]').value = this.optId('状态', r['状态']) || '';
      $('[name="costobj"]').value = r['成本对象'] || '';
      $('[name="note"]').value = r['备注'] || '';
      $('[name="open_amt"]').value = r['期初已摊销(元)'] != null ? r['期初已摊销(元)'] : '';
      $('[name="open_ym"]').value = dateStr(r['期初截止期间']).slice(0, 7);
    },
    defaults: function(){
      var d = new Date().toISOString().slice(0, 10);
      return { residual: 5, start_date: d, book_date: d };
    },
    readForm: function(){
      var code = $('[name="code"]').value.trim();
      var name = $('[name="name"]').value.trim();
      var unit = $('[name="unit"]').value.trim();
      var cat = $('[name="category"]').value;
      var method = $('[name="method"]').value;
      var cost = parseFloat($('[name="cost"]').value);
      var residual = parseFloat($('[name="residual"]').value);
      var startDate = $('[name="start_date"]').value;
      var bookDate = $('[name="book_date"]').value || startDate;
      var months = parseInt($('[name="months"]').value, 10);
      var status = $('[name="status"]').value;
      var costobj = $('[name="costobj"]').value.trim();
      var note = $('[name="note"]').value.trim();
      var openAmt = parseFloat($('[name="open_amt"]').value);
      var openYm = $('[name="open_ym"]').value;
      if(!name || !unit || !cat || !method || isNaN(cost) || !startDate || !months) return { err: '请完整填写必填项' };
      if(cost <= 0) return { err: '原值必须大于 0' };
      if(months < 1) return { err: '摊销期限不能小于 1 个月' };
      if(isNaN(residual)) residual = 0;
      if(residual < 0 || residual > 100) return { err: '残值率需在 0～100% 之间' };
      /* 期初两项必须成对出现，否则算不出从哪一期往下摊 */
      var hasOpenAmt = !isNaN(openAmt) && openAmt > 0;
      if(hasOpenAmt && !openYm) return { err: '填了期初已摊销，必须同时填「期初截止期间」' };
      if(!hasOpenAmt && openYm) return { err: '填了期初截止期间，必须同时填「期初已摊销（元）」' };
      if(hasOpenAmt){
        var totalAmort = r2(cost - r2(cost * residual / 100));
        if(openAmt > totalAmort) return { err: '期初已摊销（' + amt(openAmt) + '）不能大于应摊总额（' + amt(totalAmort) + '）' };
        if(openYm < dateStr(startDate).slice(0, 7)) return { err: '期初截止期间不能早于启用日期所在月' };
      }
      var props = {
        '设施名称': { text: name },
        '设施类别': { select: cat },
        '原值(元)': { number: cost },
        '残值率(%)': { number: residual },
        '启用日期': { date: startDate },
        '摊销期限(月)': { number: months },
        '摊销方法': { select: method },
        '备注': { text: note }
      };
      if(code && this.canWrite('设施编号')) props['设施编号'] = { text: code };
      if(this.canWrite('单位')) props['单位'] = { text: unit };
      if(this.canWrite('入账日期')) props['入账日期'] = { date: bookDate };
      if(status) props['状态'] = { select: status };
      else props['状态'] = { select: this.optId('状态', '使用中') };
      if(costobj && this.canWrite('成本对象')) props['成本对象'] = { text: costobj };
      if(hasOpenAmt){
        props['期初已摊销(元)'] = { number: openAmt };
        props['期初截止期间'] = { date: openYm + '-01' };
      }
      return { props: props };
    },
    onFormInput: function(){
      var pv = $('#preview'); if(!pv) return;
      var cost = parseFloat($('[name="cost"]').value) || 0;
      var residual = parseFloat($('[name="residual"]').value) || 0;
      var months = parseInt($('[name="months"]').value, 10) || 0;
      var method = this.optText('摊销方法', $('[name="method"]').value);
      var sd = $('[name="start_date"]').value, bd = $('[name="book_date"]').value;
      var openAmt = parseFloat($('[name="open_amt"]').value) || 0;
      var openYm = $('[name="open_ym"]').value;
      if(!cost || !months){ pv.textContent = '填写原值、残值率与期限后，自动计算月摊销额'; return; }
      var residualAmt = r2(cost * residual / 100);
      var total = r2(cost - residualAmt);
      if(openAmt > 0 && openYm){
        var monthly = r2(total / (method === '一次性摊销' ? 1 : months));
        var left = r2(total - openAmt);
        var leftMonths = monthly > 0 ? Math.ceil(left / monthly) : 0;
        pv.innerHTML = '期初接续：截至 <strong>' + openYm + '</strong> 已摊 <strong>' + fmt2(openAmt) +
          '</strong> ｜ 应摊总额 <strong>' + fmt2(total) + '</strong> ｜ 月摊销额 <strong>' + fmt2(monthly) +
          '</strong> ｜ 剩余 <strong>' + fmt2(left) + '</strong>（约 ' + leftMonths + ' 期）';
        return;
      }
      var catchUp = (sd && bd && bd.slice(0, 7) > sd.slice(0, 7)) ? '；入账月将自动补提启用以来各月' : '';
      if(method === '一次性摊销'){
        pv.innerHTML = '预计净残值 <strong>' + fmt2(residualAmt) + '</strong> ｜ 应摊总额 <strong>' + fmt2(total) + '</strong>（入账当月一次性计提）';
      } else {
        pv.innerHTML = '预计净残值 <strong>' + fmt2(residualAmt) + '</strong> ｜ 应摊总额 <strong>' + fmt2(total) + '</strong> ｜ 月摊销额 <strong>' + fmt2(r2(total / months)) + '</strong>' + catchUp;
      }
    },
    buildPrint: function(rows, calcs){ printTfaMonthly.call(this, rows, calcs); },
    print: function(rows, calcs){ this.buildPrint(rows, calcs); doPrint(true); },
    buildPrintAll: function(rows, calcs){ printTfaLedger.call(this, rows, calcs); },
    printAll: function(rows, calcs){ this.buildPrintAll(rows, calcs); doPrint(true); },
    voucher: function(id){ printTfaVoucher.call(this, id); },
    seed: function(){
      var defs = [
        ['一分公司', '项目部办公板房', '房屋类设施', 386000, 5, '2024-11-15', '2024-11-20', 36, '直线法', '使用中', '项目部'],
        ['一分公司', '工人宿舍板房', '房屋类设施', 512000, 5, '2024-09-20', '2024-09-25', 36, '直线法', '使用中', '项目部'],
        ['一分公司', '食堂及沐浴间', '房屋类设施', 168000, 5, '2025-02-10', '2025-04-05', 30, '直线法', '使用中', '项目部'],
        ['二分公司', '现场临时道路', '构筑物类设施', 245000, 0, '2025-04-08', '2025-04-15', 24, '直线法', '使用中', '示例项目C'],
        ['二分公司', '临时用电线路', '其他设施', 96000, 0, '2025-06-01', '2025-06-10', 24, '直线法', '使用中', '示例项目C'],
        ['二分公司', '临时给排水管网', '其他设施', 72000, 0, '2025-06-01', '2025-06-10', 24, '直线法', '使用中', '示例项目C'],
        ['三分公司', '围挡', '其他设施', 58000, 5, '2025-08-15', '2025-08-18', 24, '直线法', '使用中', '示例项目A'],
        ['三分公司', '型材加工棚', '构筑物类设施', 45000, 5, '2024-09-01', '2024-09-05', 24, '直线法', '使用中', '示例项目A'],
        ['三分公司', '水泥库房', '构筑物类设施', 30000, 5, '2023-06-10', '2023-06-15', 36, '直线法', '已摊完', '示例项目A'],
        ['一分公司', '小型工具房', '其他设施', 8000, 0, '2026-05-20', '2026-05-22', 12, '一次性摊销', '使用中', '项目部']
      ];
      var seqByYear = {};
      return defs.map(function(x){
        var y = x[5].slice(0, 4);
        seqByYear[y] = (seqByYear[y] || 0) + 1;
        return { '单位': x[0], '设施名称': x[1], '设施类别': x[2], '原值(元)': x[3], '残值率(%)': x[4],
                 '启用日期': x[5], '入账日期': x[6], '摊销期限(月)': x[7], '摊销方法': x[8], '状态': x[9],
                 '成本对象': x[10], '设施编号': 'TFA-' + y + '-' + ('000' + seqByYear[y]).slice(-3), '备注': '' };
      });
    }
  };

