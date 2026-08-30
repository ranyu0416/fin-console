import { dateStr, r2, ymCn, ymLabel, ymStr } from './core/format.js';
import { cur } from './core/state.js';
import { todayStr } from './core/text.js';
import { calcsOf, curRows, displayRows } from './engine.js';
import { periodEnd } from './period.js';
import { printUnitName } from './print.js';
import { applyXlsProfile } from './printconfig.js';

/* 各模块导出规格：periodOnly=true 本月，false 全量台账；列结构与打印表严格一致 */
export function xlsSpec(periodOnly, skipProfile){
  /* 当前选择：沿用页面筛选并遵循模块期间口径；开累：忽略页面筛选，导出全模块全量记录 */
  var rows = periodOnly ? displayRows(curRows()) : curRows().slice();
  if(!rows.length) return null;
  var calcs = calcsOf(rows);
  var pe = periodEnd();
  var ym = ymStr(pe);
  var org = printUnitName();
  var spec = { sheet: cur.name, metaR: '单位：元' };
  var merges = [];
  var rn = 0;   /* 数据区行序号，合并定位用（表头占 3 行，数据从第 4 行起） */
  function labelRow(arr, span, label, vals){
    rn++;
    var r = [{ v: label, s: 'slB' }];
    for(var i = 1; i < span; i++) r.push({ v: '', s: 'slB' });
    vals.forEach(function(v){ r.push({ v: v, b: 1 }); });
    merges.push('R' + (rn + 3) + 'C1:R' + (rn + 3) + 'C' + span);
    arr.push(r);
  }
  function plainRow(arr, cells){ rn++; arr.push(cells); }
  if(cur.key === 'facility' && periodOnly){
    spec.file = '设施摊销表_' + ym + '.xlsx';
    spec.title = ymCn(pe) + '设施摊销表';
    spec.metaL = '编制单位：' + org + '　　' + ymCn(pe);
    spec.cols = [
      { h: '序号', s: 'n0', w: 38 }, { h: '单位', s: 'sc', w: 70 }, { h: '设施类别', s: 'sc', w: 88 },
      { h: '设施名称', s: 'sl', w: 150 }, { h: '成本对象', s: 'sl', w: 110 }, { h: '入账日期', s: 'sc', w: 76 },
      { h: '启用日期', s: 'sc', w: 76 }, { h: '原值', s: 'n2', w: 98 }, { h: '残值率', s: 'pc', w: 52 },
      { h: '预计净残值', s: 'n2', w: 90 }, { h: '应摊销月份', s: 'n0', w: 66 }, { h: '本期摊销月份', s: 'n0', w: 66 },
      { h: '开累摊销月份', s: 'n0', w: 66 }, { h: '截至上期摊销金额', s: 'n2', w: 102 },
      { h: '本月摊销金额', s: 'n2', w: 92 }, { h: '开累摊销金额', s: 'n2', w: 92 }, { h: '本月末账面净值', s: 'n2', w: 98 }
    ];
    var out = [];
    var groups = {};
    rows.forEach(function(r){
      var g = this.optText('设施类别', r['设施类别']) || '未分类';
      (groups[g] = groups[g] || []).push(r);
    }, cur);
    var grand = { cost: 0, res: 0, prev: 0, cur: 0, acc: 0, net: 0 }, sn = 0;
    Object.keys(groups).sort().forEach(function(g){
      var s = { cost: 0, res: 0, prev: 0, cur: 0, acc: 0, net: 0 };
      groups[g].forEach(function(r){
        var c = calcs[r._id];
        sn++; s.cost += Number(r['原值(元)']) || 0; s.res += c.residualAmt; s.prev += c.accruedPrev;
        s.cur += c.curAmt; s.acc += c.accrued; s.net += c.net;
        plainRow(out, [sn, r['单位'] || '', g, r['设施名称'], r['成本对象'] || '',
          dateStr(r['入账日期'] || r['启用日期']), dateStr(r['启用日期']),
          Number(r['原值(元)']) || 0, Number(r['残值率(%)']) || 0, c.residualAmt,
          Number(r['摊销期限(月)']) || 0, c.cur, c.k, c.accruedPrev, c.curAmt, c.accrued, c.net]);
      }, cur);
      grand.cost += s.cost; grand.res += s.res; grand.prev += s.prev; grand.cur += s.cur; grand.acc += s.acc; grand.net += s.net;
      labelRow(out, 7, g + '小计', [s.cost, '—', s.res, '—', '—', '—', s.prev, s.cur, s.acc, s.net]);
    }, cur);
    var byObj = {};
    rows.forEach(function(r){
      var c = calcs[r._id], k2 = r['成本对象'] || '未分摊';
      var o = byObj[k2] = byObj[k2] || { cost: 0, res: 0, prev: 0, cur: 0, acc: 0, net: 0 };
      o.cost += Number(r['原值(元)']) || 0; o.res += c.residualAmt; o.prev += c.accruedPrev;
      o.cur += c.curAmt; o.acc += c.accrued; o.net += c.net;
    });
    Object.keys(byObj).sort().forEach(function(k2){
      var o = byObj[k2];
      labelRow(out, 7, '其中：' + k2, [o.cost, '—', o.res, '—', '—', '—', o.prev, o.cur, o.acc, o.net]);
    });
    labelRow(out, 7, '总　计', [grand.cost, '—', grand.res, '—', '—', '—', grand.prev, grand.cur, grand.acc, grand.net]);
    spec.rows = out;
  } else if(cur.key === 'facility'){
    spec.file = '设施台账_' + todayStr() + '.xlsx';
    spec.title = '设施台账（全量）';
    spec.metaL = '编制单位：' + org + '　　截至 ' + ymCn(pe);
    spec.cols = [
      { h: '序号', s: 'n0', w: 38 }, { h: '单位', s: 'sc', w: 70 }, { h: '设施类别', s: 'sc', w: 88 },
      { h: '设施名称', s: 'sl', w: 150 }, { h: '成本对象', s: 'sl', w: 110 }, { h: '入账日期', s: 'sc', w: 76 },
      { h: '启用日期', s: 'sc', w: 76 }, { h: '期限(月)', s: 'n0', w: 58 }, { h: '已摊/共(月)', s: 'sc', w: 88 },
      { h: '原值', s: 'n2', w: 98 }, { h: '月摊销额', s: 'n2', w: 86 }, { h: '开累摊销', s: 'n2', w: 92 },
      { h: '本月摊销', s: 'n2', w: 86 }, { h: '账面净值', s: 'n2', w: 94 }, { h: '状态', s: 'sc', w: 60 }
    ];
    var out = [], t = { cost: 0, acc: 0, cur: 0, net: 0 };
    rows.forEach(function(r, i){
      var c = calcs[r._id], mo = Number(r['摊销期限(月)']) || 0;
      t.cost += Number(r['原值(元)']) || 0; t.acc += c.accrued; t.cur += c.curAmt; t.net += c.net;
      plainRow(out, [i + 1, r['单位'] || '', this.optText('设施类别', r['设施类别']) || '', r['设施名称'],
        r['成本对象'] || '', dateStr(r['入账日期'] || r['启用日期']), dateStr(r['启用日期']), mo,
        c.k + '/' + mo, Number(r['原值(元)']) || 0, c.monthly, c.accrued, c.curAmt, c.net,
        this.optText('状态', r['状态'])]);
    }, cur);
    labelRow(out, 9, '总　计', [t.cost, '—', t.acc, t.cur, t.net, '—']);
    spec.rows = out;
  } else if(cur.key === 'asset' && periodOnly){
    spec.file = '固定资产折旧明细表_' + ym + '.xlsx';
    spec.title = ymCn(pe) + '固定资产折旧明细表';
    spec.metaL = '编制单位：' + org + '　　' + ymCn(pe);
    spec.cols = [
      { h: '序号', s: 'n0', w: 38 }, { h: '单位', s: 'sc', w: 70 }, { h: '固定资产编号', s: 'sc', w: 100 },
      { h: '资产名称', s: 'sl', w: 140 }, { h: '资产类型', s: 'sc', w: 80 }, { h: '预计使用年限', s: 'n0', w: 76 },
      { h: '开累折旧月份', s: 'n0', w: 76 }, { h: '原值', s: 'n2', w: 98 }, { h: '残值率', s: 'pc', w: 52 },
      { h: '预计残值', s: 'n2', w: 88 }, { h: '本次折旧', s: 'n2', w: 84 }, { h: '开累折旧额', s: 'n2', w: 92 },
      { h: '本项目承担折旧', s: 'n2', w: 104 }, { h: '账面余额', s: 'n2', w: 94 }
    ];
    var out = [], s = { cost: 0, res: 0, cur: 0, acc: 0, bear: 0, net: 0 };
    rows.forEach(function(r, i){
      var c = calcs[r._id];
      s.cost += Number(r['原值(元)']) || 0; s.res += c.residualAmt; s.cur += c.curAmt; s.acc += c.accrued; s.net += c.net;
      if(c.bear != null) s.bear += c.bear;
      plainRow(out, [i + 1, r['单位'] || '', r['固定资产编号'] || '', r['资产名称'],
        this.optText('资产类型', r['资产类型']), Number(r['预计使用年限(年)']) || 0, c.k,
        Number(r['原值(元)']) || 0, Number(r['残值率(%)']) || 0, c.residualAmt, c.curAmt, c.accrued,
        c.bear == null ? '—' : c.bear, c.net]);
    }, cur);
    labelRow(out, 7, '合　计', [s.cost, '—', s.res, s.cur, s.acc, r2(s.bear), s.net]);
    spec.rows = out;
  } else if(cur.key === 'asset'){
    spec.file = '固定资产台账_' + todayStr() + '.xlsx';
    spec.title = '固定资产台账（全量）';
    spec.metaL = '编制单位：' + org + '　　截至 ' + ymCn(pe);
    spec.cols = [
      { h: '序号', s: 'n0', w: 38 }, { h: '单位', s: 'sc', w: 70 }, { h: '固定资产编号', s: 'sc', w: 100 },
      { h: '资产名称', s: 'sl', w: 140 }, { h: '资产类型', s: 'sc', w: 80 }, { h: '启用日期', s: 'sc', w: 76 },
      { h: '转移至项目', s: 'sc', w: 76 }, { h: '年限(年)', s: 'n0', w: 58 }, { h: '已摊/共(月)', s: 'sc', w: 88 },
      { h: '原值', s: 'n2', w: 98 }, { h: '月折旧额', s: 'n2', w: 84 }, { h: '开累折旧额', s: 'n2', w: 92 },
      { h: '本项目承担', s: 'n2', w: 96 }, { h: '账面余额', s: 'n2', w: 94 }, { h: '状态', s: 'sc', w: 60 }
    ];
    var out = [], t = { cost: 0, acc: 0, net: 0 };
    rows.forEach(function(r, i){
      var c = calcs[r._id];
      t.cost += Number(r['原值(元)']) || 0; t.acc += c.accrued; t.net += c.net;
      plainRow(out, [i + 1, r['单位'] || '', r['固定资产编号'] || '', r['资产名称'],
        this.optText('资产类型', r['资产类型']), dateStr(r['启用日期']), dateStr(r['转移至项目日期']) || '—',
        Number(r['预计使用年限(年)']) || 0, c.k + '/' + c.totalMonths, Number(r['原值(元)']) || 0,
        c.monthly, c.accrued, c.bear == null ? '—' : c.bear, c.net, this.optText('状态', r['状态'])]);
    }, cur);
    labelRow(out, 9, '总　计', [t.cost, '—', t.acc, '—', t.net, '—']);
    spec.rows = out;
  } else if(cur.key === 'union'){
    var vis = periodOnly ? rows.filter(function(r){ return dateStr(r['会计期间']).slice(0, 7) === ym; }) : rows.slice().sort(function(a, b){
      return (a['单位'] || '').localeCompare(b['单位'] || '') || String(a['会计期间']).localeCompare(String(b['会计期间']));
    });
    if(!vis.length) return null;
    spec.file = '工会经费职工教育经费' + (periodOnly ? '明细表_' + ym : '台账_' + todayStr()) + '.xlsx';
    spec.title = (periodOnly ? ymCn(pe) : '') + '工会经费、职工教育经费' + (periodOnly ? '明细表' : '台账（全量）');
    spec.metaL = '编制单位：' + org + '　　' + (periodOnly ? ymCn(pe) : '截至 ' + ymCn(pe));
    spec.cols = [
      { h: '序号', s: 'n0', w: 38 }, { h: '单位', s: 'sc', w: 76 }, { h: '会计期间', s: 'sc', w: 72 },
      { h: '本期工资', s: 'n2', w: 92 }, { h: '工资年开累', s: 'n2', w: 100 },
      { h: '计提比例', s: 'pc', w: 56 }, { h: '本期计提', s: 'n2', w: 84 }, { h: '累计计提', s: 'n2', w: 92 },
      { h: '计提比例', s: 'pc', w: 56 }, { h: '本期计提', s: 'n2', w: 84 }, { h: '累计计提', s: 'n2', w: 92 }
    ];
    var out = [];
    if(periodOnly){
      var s = { w: 0, uc: 0, ua: 0, ec: 0, ea: 0 };
      vis.forEach(function(r, i){
        var c = calcs[r._id];
        s.w += c.wages; s.uc += c.uCur; s.ua += c.uAcc; s.ec += c.eCur; s.ea += c.eAcc;
        plainRow(out, [i + 1, r['单位'] || '', dateStr(r['会计期间']).slice(0, 7), c.wages, c.cum,
          Number(r['工会经费比例(%)']) || 0, c.uCur, c.uAcc, Number(r['职工教育经费比例(%)']) || 0, c.eCur, c.eAcc]);
      });
      labelRow(out, 3, '合　计', [s.w, '—', '—', s.uc, s.ua, '—', s.ec, s.ea]);
    } else {
      vis.forEach(function(r, i){
        var c = calcs[r._id];
        plainRow(out, [i + 1, r['单位'] || '', dateStr(r['会计期间']).slice(0, 7), c.wages, c.cum,
          Number(r['工会经费比例(%)']) || 0, c.uCur, c.uAcc, Number(r['职工教育经费比例(%)']) || 0, c.eCur, c.eAcc]);
      });
    }
    spec.rows = out;
  } else if(cur.key === 'levy'){
    var vis = periodOnly ? rows.filter(function(r){ return dateStr(r['会计期间']).slice(0, 7) === ym; }) : rows.slice().sort(function(a, b){
      return (a['单位'] || '').localeCompare(b['单位'] || '') || String(a['会计期间']).localeCompare(String(b['会计期间']));
    });
    if(!vis.length) return null;
    spec.file = '专项费用计提表_' + ym + '.xlsx';
    spec.title = '专项费用计提表';
    spec.metaL = '编制单位：' + org + '　　' + pe.getFullYear() + ' 年 ' + (pe.getMonth() + 1) + ' 月';
    spec.cols = [
      { h: '项目名称', s: 'sl', w: 220 }, { h: '会计期间', s: 'sc', w: 78 }, { h: '当期产值', s: 'n2', w: 100 }, { h: '累计产值', s: 'n2', w: 100 },
      { h: '计提比例', s: 'pc', w: 60 }, { h: '本期计提金额', s: 'n2', w: 100 },
      { h: '累计计提金额', s: 'n2', w: 100 }, { h: '备注', s: 'sl', w: 110 }
    ];
    spec.rows = vis.map(function(r){
      var c = calcs[r._id];
      return [r['项目名称'], ymLabel(r['会计期间']), c.base, c.cum, c.rate, c.curAmt, c.accrued, r['备注'] || ''];
    });
  } else if(cur.key === 'baddebt'){
    spec.file = '减值准备明细表_' + (periodOnly ? ym : todayStr()) + '.xlsx';
    spec.title = '其他应收款计提减值准备明细表';
    spec.metaL = '编制单位：' + org + '　　' + (periodOnly ? ymCn(pe) : '截至 ' + todayStr());
    spec.cols = [
      { h: '序号', s: 'n0', w: 38 }, { h: '单位', s: 'sc', w: 70 }, { h: '科目名称', s: 'sl', w: 200 },
      { h: '往来单位名称', s: 'sl', w: 140 }, { h: '入账日期', s: 'sc', w: 76 }, { h: '科目余额', s: 'n2', w: 96 },
      { h: '账龄', s: 'sc', w: 72 }, { h: '计提比例', s: 'pc', w: 60 }, { h: '应计提金额', s: 'n2', w: 96 },
      { h: '已计提金额', s: 'n2', w: 96 }, { h: '本期计提金额', s: 'n2', w: 100 }
    ];
    var out = [], s = { bal: 0, due: 0, paid: 0, cur: 0 };
    rows.forEach(function(r, i){
      var c = calcs[r._id];
      s.bal += c.balance; s.due += c.due; s.paid += c.paid; s.cur += c.cur;
      plainRow(out, [i + 1, r['单位'] || '', r['科目名称'], r['往来单位名称'] || '', dateStr(r['入账日期']),
        c.balance, c.age, c.rate, c.due, c.paid, c.cur]);
    });
    labelRow(out, 5, '合　计', [s.bal, '—', '—', s.due, s.paid, s.cur]);
    spec.rows = out;
  } else if(cur.key === 'lvc'){
    var vis = periodOnly ? rows.filter(function(r){ return dateStr(r['入账月份']).slice(0, 7) === ym; }) : rows;
    if(!vis.length) return null;
    spec.file = '低值易耗品' + (periodOnly ? '摊销明细表_' + ym : '台账_' + todayStr()) + '.xlsx';
    spec.title = '低值易耗品' + (periodOnly ? '摊销明细表' : '台账（全量）');
    spec.metaL = '编制单位：' + org + '　　' + (periodOnly ? ymCn(pe) : '截至 ' + ymCn(pe));
    spec.cols = [
      { h: '序号', s: 'n0', w: 38 }, { h: '单位', s: 'sc', w: 70 }, { h: '入账月份', s: 'sc', w: 72 },
      { h: '凭证号', s: 'sc', w: 110 }, { h: '开票日期', s: 'sc', w: 76 }, { h: '资产名称', s: 'sl', w: 110 },
      { h: '规格型号', s: 'sc', w: 96 }, { h: '计量单位', s: 'sc', w: 60 }, { h: '数量', s: 'n0', w: 52 },
      { h: '单价（不含税）', s: 'n2', w: 92 }, { h: '不含税总金额', s: 'n2', w: 96 }, { h: '可抵扣进项税额', s: 'n2', w: 104 },
      { h: '含税金额', s: 'n2', w: 92 }, { h: '本期摊销', s: 'n2', w: 88 }, { h: '领用人', s: 'sc', w: 64 },
      { h: '成本对象', s: 'sl', w: 100 }
    ];
    var out = [], sn = 0;
    var grand = { net: 0, tax: 0, gross: 0, cur: 0 };
    var groups = {};
    vis.forEach(function(r){
      var g = (r['单位'] || '') + ' / ' + (r['成本对象'] || '未分摊');
      (groups[g] = groups[g] || []).push(r);
    });
    Object.keys(groups).sort().forEach(function(g){
      var s = { net: 0, tax: 0, gross: 0, cur: 0 };
      groups[g].forEach(function(r){
        var c = calcs[r._id];
        sn++; s.net += c.netAmt; s.tax += c.tax; s.gross += c.grossAmt; s.cur += c.curAmt;
        plainRow(out, [sn, r['单位'] || '', dateStr(r['入账月份']).slice(0, 7), r['凭证号'] || '',
          dateStr(r['开票日期']), r['资产名称'], r['规格型号'] || '', r['计量单位'] || '',
          Number(r['数量']) || 0, Number(r['单价(元)']) || 0, c.netAmt, c.tax, c.grossAmt, c.curAmt,
          r['领用人'] || '', r['成本对象'] || '']);
      });
      grand.net += s.net; grand.tax += s.tax; grand.gross += s.gross; grand.cur += s.cur;
      labelRow(out, 10, g + '小计', [s.net, s.tax, s.gross, s.cur, '—', '—']);
    });
    labelRow(out, 10, '总　计', [grand.net, grand.tax, grand.gross, grand.cur, '—', '—']);
    spec.rows = out;
  } else {
    /*
     * 通用导出：没有专属规格的模块（新增模块默认走这里）按屏显列表原样导出。
     *
     * 原来这里是 return null，效果是「导出 Excel」点了没反应，只弹一句
     * 「当前没有可导出的数据」——数据明明在屏幕上。新增一个模块后第一个被
     * 发现的缺口就是它，而这个缺口不需要每个模块各写一份规格才能补上：
     * 列定义已经在模块的 columns 里了，取表头和取值函数即可。
     * 需要合并小计、分组的正式报表再单独写专属规格覆盖。
     */
    var cols = (cur.columns || []).filter(function(c){
      return !(c.gated && cur.online && !cur.schemaFields[c.gated]);
    });
    if(!cols.length) return null;
    spec.file = cur.name + '_' + (periodOnly ? ym : todayStr()) + '.xlsx';
    spec.title = cur.name + (periodOnly ? '（' + ymCn(pe) + '）' : '台账（全量）');
    spec.metaL = '编制单位：' + org + '　　' + (periodOnly ? ymCn(pe) : '截至 ' + ymCn(pe));
    spec.cols = cols.map(function(c){
      return { h: c.h, s: c.num ? 'n2' : 'sl', w: c.num ? 96 : 110 };
    });
    /*
     * 分组小计与总计：模块声明 groupBy（字段名）即按该字段重排并插入「××小计」行，
     * 末尾补「总　计」行——与打印的 buildGenericPrint 同一口径。
     * 没声明 groupBy 的模块行为与原来完全一致（只有数据行）。
     */
    var groupBy = cur.groupBy;
    var ordered = groupBy
      ? rows.slice().sort(function(a, b){ return String(a[groupBy] || '').localeCompare(String(b[groupBy] || '')); })
      : rows;
    var span = cols.length > 2 ? 2 : 1;
    function sumsVals(sums){
      var vals = [];
      for(var ci = span; ci < cols.length; ci++){
        vals.push(cols[ci].num && sums[ci] !== undefined ? r2(sums[ci]) : '—');
      }
      return vals;
    }
    var out = [];
    var sums = {}, gsum = null, gname = null;
    function flushGroup(){
      if(!gsum) return;
      labelRow(out, span, (gname || '（未分组）') + '小计', sumsVals(gsum));
    }
    ordered.forEach(function(r, idx){
      var c = calcs[r._id] || {};
      var g = groupBy ? String(r[groupBy] || '') : null;
      if(groupBy && gname !== null && g !== gname){ flushGroup(); gsum = null; }
      if(groupBy && g !== gname){ gname = g; gsum = {}; }
      var cells = cols.map(function(col, ci){
        var v = col.v.call(cur, r, c, idx);
        if(typeof v === 'number'){
          if(col.num){ sums[ci] = (sums[ci] || 0) + v; gsum[ci] = (gsum[ci] || 0) + v; }
          return v;
        }
        /* 取值函数返回的是待插入表格的 HTML 片段，导出前要还原成纯文本 */
        var text = String(v == null ? '' : v).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        if(col.num){
          var n = Number(text.replace(/[,，\s¥]/g, '').replace(/^\((.*)\)$/, '-$1'));
          if(Number.isFinite(n)){
            sums[ci] = (sums[ci] || 0) + n; gsum[ci] = (gsum[ci] || 0) + n;
            return n;
          }
        }
        return text;
      });
      plainRow(out, cells);
    });
    if(groupBy) flushGroup();
    if(cols.some(function(c2, ci){ return c2.num && sums[ci] !== undefined; })){
      labelRow(out, span, '总　计', sumsVals(sums));
    }
    spec.rows = out;
  }
  spec.merges = merges;
  return skipProfile ? spec : applyXlsProfile(spec);
}

