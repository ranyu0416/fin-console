import { $, toast } from './core/dom.js';
import { amt, r2, ymCn } from './core/format.js';
import { cur } from './core/state.js';
import { esc } from './core/text.js';
import { calcsOf, curRows, rowVisible } from './engine.js';
import { periodEnd } from './period.js';
import { applyPrintProfile } from './printconfig.js';

/* ---------- 打印管线 ----------
   1) ensureOrientStyle：写入 @page 方向与边距（0 边距抑制浏览器页眉页脚，留白由 .p-doc padding 提供）；
   2) fitPrintScale：把超宽表格整体缩放到可打印宽度内，避免右侧列被截断；
   3) doPrint：程序化打印入口；beforeprint 兜底：用户直接 Ctrl+P 时自动构建当前模块报表 */
var pageOrientStyle = null;
var programmaticPrint = false;
export function ensureOrientStyle(landscape){
  if(pageOrientStyle && pageOrientStyle.parentNode) pageOrientStyle.parentNode.removeChild(pageOrientStyle);
  pageOrientStyle = document.createElement('style');
  pageOrientStyle.textContent = '@page{size:A4 ' + (landscape ? 'landscape' : 'portrait') + ';margin:0;}';
  document.head.appendChild(pageOrientStyle);
}
export function fitPrintScale(landscape){
  var pa = $('#printArea');
  if(!pa) return;
  /* 离屏临时显示以测量实际宽度 */
  pa.style.display = 'block';
  pa.style.position = 'absolute';
  pa.style.left = '-10000px';
  pa.style.top = '0';
  pa.style.width = 'auto';
  var doc = pa.querySelector('.p-doc');
  if(doc){
    doc.style.zoom = '';
    doc.style.margin = '';
    var availPx = (landscape ? 1123 : 794) - 91;   // 纸宽减去 .p-doc 左右 padding(12mm×2≈91px)
    var w = doc.scrollWidth;
    if(w > availPx && w > 0){
      var factor = Math.max(0.55, availPx / w);
      doc.style.zoom = factor;
      /* 缩放后整体居中：左右各补 (纸宽-缩放后宽)/2；zoom 会同步缩放 margin，故除以 factor */
      var free = ((landscape ? 1123 : 794) - w * factor) / 2;
      if(free > 1) doc.style.margin = '0 ' + Math.round(free / factor) + 'px';
    }
  }
  pa.style.display = '';
  pa.style.position = '';
  pa.style.left = '';
  pa.style.top = '';
  pa.style.width = '';
}
export function doPrint(landscape){
  programmaticPrint = true;
  applyPrintProfile();
  ensureOrientStyle(landscape);
  fitPrintScale(landscape);
  try{ window.print(); }catch(e){}
  setTimeout(function(){ programmaticPrint = false; }, 800);
}
/** 用户直接 Ctrl+P 时的兜底：自动构建当前模块报表。由 main.js 启动时调用一次。 */
export function bindBeforePrint(){
  window.addEventListener('beforeprint', function(){
    if(programmaticPrint || !cur) return;
    try{
      var rows = curRows(), calcs = calcsOf(rows);
      if(cur.buildPrint) cur.buildPrint(rows.filter(rowVisible), calcs);
      else buildGenericPrint(rows.filter(rowVisible), calcs, cur.name);
      ensureOrientStyle(cur.printLandscape !== false);
      fitPrintScale(cur.printLandscape !== false);
    }catch(e){ console.error('[print] beforeprint 构建失败:', e); }
  });
}
export function signRow(names){
  return '<div class="p-sign">' + names.map(function(n){ return '<span>' + n + '：</span>'; }).join('') + '</div>';
}
export function printUnitName(){
  /* 直接取已定义单位：优先顶部筛选；未筛选时若当前模块只涉及一家单位则取该名称，否则显示全公司 */
  var u = $('#fUnit') && $('#fUnit').value;
  if(u) return u;
  var us = [];
  ((cur && cur.rows) || []).forEach(function(r){
    var v = r['单位'];
    if(v && us.indexOf(v) < 0) us.push(v);
  });
  if(us.length === 1) return us[0];
  /* 没有「单位」字段的模块（往来/研发/合同等）回退到「项目」维度 */
  var ps = [];
  ((cur && cur.rows) || []).forEach(function(r){
    var v = r['项目'];
    if(v && ps.indexOf(v) < 0) ps.push(v);
  });
  if(ps.length === 1) return ps[0];
  return (window.__FIN_ORG__ || '') || '全公司';
}

/**
 * 通用报表：按模块的 columns 直接排一张表，金额列自动求合计。
 *
 * 存在的意义是让「新增一个模块」不必先写打印代码就能用。
 * 原来模块没有 print/buildPrint 时，「导出/打印 → 打印本月」会抛
 * TypeError: cur.print is not a function，菜单点下去毫无反应，
 * 控制台里才有线索——这是新增模块时第二个必然撞到的缺口。
 * 需要合并表头、分组小计、盖章栏的正式报表，各模块仍然自己写 buildPrint 覆盖。
 */
export function buildGenericPrint(rows, calcs, title){
  var mod = cur;
  var cols = (mod.columns || []).filter(function(c){
    return !(c.gated && mod.online && !mod.schemaFields[c.gated]);
  });
  if(!cols.length){ $('#printArea').innerHTML = ''; return false; }
  /*
   * 分组小计：模块声明 groupBy（字段名）即生效——行按该字段重排，
   * 每组之后插一行「组名 · 小计」，tfoot 仍是全量合计。
   * 让「按课题/性质/单位汇总」的台账不必各写一份 buildPrint 就有正式报表的样子。
   */
  var groupBy = mod.groupBy;
  var ordered = groupBy
    ? rows.slice().sort(function(a, b){ return String(a[groupBy] || '').localeCompare(String(b[groupBy] || '')); })
    : rows;
  var sums = {};
  var gsum = null, gname = null;
  function groupRow(){
    if(!gsum) return '';
    return '<tr class="p-sub">' + cols.map(function(col, ci){
      if(ci === 0) return '<td>' + esc(gname || '（未分组）') + ' · 小计</td>';
      if(col.num && gsum[ci] !== undefined) return '<td class="num">' + amt(r2(gsum[ci])) + '</td>';
      return '<td></td>';
    }).join('') + '</tr>';
  }
  var trs = ordered.map(function(r, i){
    var c = calcs[r._id] || {};
    var g = groupBy ? String(r[groupBy] || '') : null;
    var out = '';
    if(groupBy && gname !== null && g !== gname){ out += groupRow(); gsum = null; }
    if(groupBy && g !== gname){ gname = g; gsum = {}; }
    out += '<tr>' + cols.map(function(col, ci){
      var v = col.v.call(mod, r, c, i);
      var text = String(v == null ? '' : v);
      if(col.num){
        var n = Number(text.replace(/<[^>]+>/g, '').replace(/[,，\s¥]/g, ''));
        if(!isNaN(n)){
          sums[ci] = (sums[ci] || 0) + n;
          gsum[ci] = (gsum[ci] || 0) + n;
        }
      }
      return '<td' + (col.num ? ' class="num"' : '') + '>' + text + '</td>';
    }).join('') + '</tr>';
    return out;
  }).join('');
  if(groupBy) trs += groupRow();
  var foot = cols.some(function(col, ci){ return col.num && sums[ci] !== undefined; })
    ? '<tfoot><tr>' + cols.map(function(col, ci){
        if(ci === 0) return '<th>合　计</th>';
        if(col.num && sums[ci] !== undefined) return '<th class="num">' + amt(r2(sums[ci])) + '</th>';
        return '<th>—</th>';
      }).join('') + '</tr></tfoot>'
    : '';
  $('#printArea').innerHTML = '<div class="p-doc">' +
    '<h1>' + esc(title || mod.name) + '</h1>' +
    '<div class="p-meta"><span>单位：' + esc(printUnitName()) + '</span><span>' + ymCn(periodEnd()) + '</span><span>单位：元</span></div>' +
    '<table><thead><tr>' + cols.map(function(col){ return '<th>' + esc(col.h) + '</th>'; }).join('') + '</tr></thead>' +
    '<tbody>' + trs + '</tbody>' + foot + '</table>' +
    signRow(['制表', '审核']) +
    '</div>';
  return true;
}

/** 打印当前模块：模块自带 print 就用它，否则退回通用报表。 */
export function printCurrent(rows, calcs, allMode){
  if(allMode && cur.printAll){ cur.printAll(rows, calcs); return; }
  if(!allMode && cur.print){ cur.print(rows, calcs); return; }
  if(!rows.length){ toast('暂无数据可打印'); return; }
  if(buildGenericPrint(rows, calcs, cur.name + (allMode ? '台账（全量）' : '（' + ymCn(periodEnd()) + '）'))) doPrint(true);
  else toast('当前模块没有可打印的列');
}

