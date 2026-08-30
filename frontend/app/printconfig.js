import { $, toast } from './core/dom.js';
import { FIN_STORE } from './core/env.js';
import { cur, setCur } from './core/state.js';
import { esc } from './core/text.js';
import { overviewActive } from './menu.js';
import { MODULES } from './modules/registry.js';
import { xlsSpec } from './xlsspec.js';

/* ---------- 打印模块设置（本地列配置） ---------- */
var PRINT_PROFILE_KEY = 'wb_fin_print_profiles_v1';
var printConfigDraft = null;
var printConfigModuleKey = null;
/*
 * 打印列设置面板要列出哪些模块：直接取注册表的键序，不再手抄一份。
 * 手抄的那份是新增模块时最容易漏改的地方之一——漏了不会报错，
 * 只是新模块在「打印/Excel 列设置」里凭空消失，很难联想到是这里。
 */
function printConfigModuleKeys(){ return Object.keys(MODULES); }
export function readPrintProfiles(){
  try{ return JSON.parse(FIN_STORE.getItem(PRINT_PROFILE_KEY) || '{}') || {}; }catch(e){ return {}; }
}
export function writePrintProfiles(v){ try{ FIN_STORE.setItem(PRINT_PROFILE_KEY, JSON.stringify(v)); }catch(e){} }
export function printConfigColumns(kind){
  if(kind === 'xls'){
    var spec = null;
    try{ spec = xlsSpec(false, true); }catch(e){}
    if(spec && spec.cols && spec.cols.length) return spec.cols.map(function(c, i){ return {i:i, h:c.h}; });
  }
  return (cur.columns || []).filter(function(c){ return !(c.gated && cur.online && !cur.schemaFields[c.gated]); })
    .map(function(c, i){ return {i:i, h:c.h}; });
}
export function selectedPrintIndexes(key, kind, count){
  var p = readPrintProfiles()[key] || {};
  var a = p[kind];
  if(!Array.isArray(a) || !a.length) return Array.from({length: count}, function(_, i){ return i; });
  var out = a.map(Number).filter(function(i){ return i >= 0 && i < count; });
  return out.length ? out : Array.from({length: count}, function(_, i){ return i; });
}
export function exportLabelKey(v){
  var x = normPrintLabel(v);
  var map = {
    '期限月':'应摊销月份','已摊共月':'开累摊销月份','月摊销额':'本月摊销金额',
    '开累摊销':'开累摊销金额','本月摊销':'本月摊销金额','原值元':'原值',
    '本期工资':'本期工资总额','本期计提':'本期计提金额','累计计提':'累计计提金额',
    '当期计提':'本期计提金额','单价不含税':'单价（不含税）'
  };
  return normPrintLabel(map[x] || v);
}
export function applyXlsProfile(spec){
  if(!spec || !spec.cols || !spec.rows || !cur) return spec;
  var p = readPrintProfiles()[cur.key] || {};
  if(!Array.isArray(p.xls) || !p.xls.length) return spec;
  var configCols = printConfigColumns('xls');
  var selected = {};
  p.xls.forEach(function(i){ if(configCols[i]) selected[exportLabelKey(configCols[i].h)] = true; });
  var keep = spec.cols.map(function(c, i){ return !!selected[exportLabelKey(c.h)]; }).map(function(v, i){ return v ? i : -1; }).filter(function(i){ return i >= 0; });
  /* 若历史配置来自旧版字段或遇到无法映射的特殊列，退回按位置匹配，避免导出空表 */
  if(!keep.length) keep = selectedPrintIndexes(cur.key, 'xls', spec.cols.length);
  if(keep.length === spec.cols.length) return spec;
  var mark = {}; keep.forEach(function(i){ mark[i] = true; });
  spec.cols = spec.cols.filter(function(_, i){ return !!mark[i]; });
  spec.rows = spec.rows.map(function(row){ return keep.map(function(i){ return row[i]; }); });
  /* 列数变化后，原来的合并坐标不再可靠；保留数据与合计行，取消跨列合并避免错位 */
  spec.merges = [];
  return spec;
}
export function normPrintLabel(v){ return String(v == null ? '' : v).replace(/[ \u3000\-—_（）()：:]/g, ''); }
export function printHeaderToScreenLabel(v){
  var x = normPrintLabel(v);
  var map = {
    '原值':'原值','原值元':'原值','期限月':'应摊销月份','已摊共月':'开累摊销月份',
    '月摊销额':'本月摊销金额','开累摊销':'开累摊销金额','本月摊销':'本月摊销金额',
    '本次折旧':'本次折旧','预计残值':'预计净残值','本期工资':'本期工资总额',
    '当期计提':'本期计提金额','累计计提':'累计计提金额','单价不含税':'单价（不含税）',
    '本期调整额':'本期计提金额'
  };
  return map[x] || String(v == null ? '' : v);
}
export function applyPrintProfile(){
  if(!cur || !$('#printArea')) return;
  var p = readPrintProfiles()[cur.key] || {};
  if(!Array.isArray(p.print) || !p.print.length) return;
  var cols = printConfigColumns('print');
  var selected = {}; selectedPrintIndexes(cur.key, 'print', cols.length).forEach(function(i){ selected[normPrintLabel(cols[i].h)] = true; });
  Array.prototype.forEach.call($('#printArea').querySelectorAll('table'), function(table){
    var head = table.tHead;
    if(!head || head.rows.length !== 1) return;
    var hcells = Array.prototype.slice.call(head.rows[0].cells);
    if(!hcells.length || hcells.some(function(c){ return c.colSpan !== 1 || c.rowSpan !== 1; })) return;
    var keep = hcells.map(function(cell){ return !!selected[normPrintLabel(printHeaderToScreenLabel(cell.textContent))]; });
    if(keep.every(function(v){ return v; }) || !keep.some(function(v){ return v; })) return;
    var rows = Array.prototype.slice.call(table.rows);
    if(rows.some(function(row){ return Array.prototype.some.call(row.cells, function(c){ return c.colSpan !== 1 || c.rowSpan !== 1; }); })) return;
    rows.forEach(function(row){
      Array.prototype.slice.call(row.cells).forEach(function(cell, i){ if(!keep[i]) cell.remove(); });
    });
  });
}
export function configBlock(kind, title, cols, selected){
  var html = '<div class="print-config-block"><h4>' + title + '</h4>' +
    '<div class="print-config-actions"><button type="button" class="btn btn-sm" data-pc-all="' + kind + '">全选</button><button type="button" class="btn btn-sm" data-pc-none="' + kind + '">清空</button></div>' +
    '<div class="print-config-grid">';
  cols.forEach(function(c){
    html += '<label><input type="checkbox" data-pc-kind="' + kind + '" data-pc-index="' + c.i + '"' + (selected.indexOf(c.i) >= 0 ? ' checked' : '') + '><span title="' + esc(c.h) + '">' + esc(c.h) + '</span></label>';
  });
  return html + '</div></div>';
}
export function printConfigColumnsFor(key, kind){
  var old = cur, out = [];
  setCur(MODULES[key]);
  try{ out = printConfigColumns(kind); }catch(e){ out = []; }
  setCur(old);
  return out;
}
export function bindPrintConfigActions(){
  Array.prototype.forEach.call($('#printConfigBody').querySelectorAll('[data-pc-all]'), function(b){
    b.addEventListener('click', function(){
      var kind = b.getAttribute('data-pc-all');
      Array.prototype.forEach.call($('#printConfigBody').querySelectorAll('[data-pc-kind="'+kind+'"]'), function(c){ c.checked = true; });
    });
  });
  Array.prototype.forEach.call($('#printConfigBody').querySelectorAll('[data-pc-none]'), function(b){
    b.addEventListener('click', function(){
      var kind = b.getAttribute('data-pc-none');
      Array.prototype.forEach.call($('#printConfigBody').querySelectorAll('[data-pc-kind="'+kind+'"]'), function(c){ c.checked = false; });
    });
  });
}
export function renderPrintConfigBody(key){
  var mod = MODULES[key];
  if(!mod) return;
  printConfigModuleKey = key;
  var pc = printConfigColumnsFor(key, 'print'), xc = printConfigColumnsFor(key, 'xls');
  printConfigDraft = { print: selectedPrintIndexes(key, 'print', pc.length), xls: selectedPrintIndexes(key, 'xls', xc.length) };
  $('#printConfigBody').innerHTML = configBlock('print', '打印列', pc, printConfigDraft.print) + configBlock('xls', 'Excel 列', xc, printConfigDraft.xls);
  bindPrintConfigActions();
}
export function openPrintConfig(){
  var keys = printConfigModuleKeys().filter(function(key){ return !!MODULES[key]; });
  if(!keys.length) return;
  var preferred = (!overviewActive() && cur && MODULES[cur.key]) ? cur.key : keys[0];
  var sel = $('#printConfigModuleSelect');
  sel.innerHTML = keys.map(function(key){ return '<option value="' + esc(key) + '">' + esc(MODULES[key].name) + '</option>'; }).join('');
  sel.value = preferred;
  sel.onchange = function(){ renderPrintConfigBody(sel.value); };
  renderPrintConfigBody(preferred);
  $('#printConfigMask').className = 'mask open';
}
export function closePrintConfig(){ $('#printConfigMask').className = 'mask'; printConfigDraft = null; printConfigModuleKey = null; }
export function savePrintConfig(){
  var key = printConfigModuleKey, mod = MODULES[key];
  if(!key || !mod) return;
  var out = { print: [], xls: [] }, valid = true;
  ['print','xls'].forEach(function(kind){
    Array.prototype.forEach.call($('#printConfigBody').querySelectorAll('[data-pc-kind="'+kind+'"]:checked'), function(c){ out[kind].push(Number(c.getAttribute('data-pc-index'))); });
    if(!out[kind].length){ toast('至少保留一列：' + (kind === 'print' ? '打印' : 'Excel')); valid = false; }
  });
  if(!valid) return;
  var all = readPrintProfiles(); all[key] = out; writePrintProfiles(all); closePrintConfig(); toast('已保存「' + mod.name + '」打印 / Excel 列设置（全账套共享，所有账号生效）');
}

