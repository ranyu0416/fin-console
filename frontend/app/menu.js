import { clearAll, seedDemo } from './clear.js';
import { $, toast } from './core/dom.js';
import { cur } from './core/state.js';
import { calcsOf, curRows, displayRows } from './engine.js';
import { openCarry } from './features/carry.js';
import { openMasterData } from './features/masterdata.js';
import { openPaste } from './features/paste.js';
import { renderOverview } from './overview.js';
import { openPrintConfig } from './printconfig.js';
import { printCurrent } from './print.js';
import { xlsSpec } from './xlsspec.js';
import { exportExcelXls, exportJson } from './xlsx.js';

export function overviewActive(){ return $('#overviewCard').style.display !== 'none'; }

/* 不需要「当前模块」上下文就能用的动作：在总览页也放行 */
var GLOBAL_ACTS = ['seed', 'printConfig', 'carry', 'paste', 'masterData'];

export function menuAction(act){
  /* 结转 / 粘贴导入 / 受控清单由台账自身实现；其余管理面板在 admin.js 里 */
  if(act === 'carry'){ openCarry(); return; }
  if(act === 'paste'){ openPaste(); return; }
  if(act === 'masterData'){ openMasterData(); return; }
  if(window.__FIN_MENU__ && typeof window.__FIN_MENU__[act] === 'function'){ window.__FIN_MENU__[act](); return; }
  if(overviewActive() && GLOBAL_ACTS.indexOf(act) < 0){
    toast('请先从上方页签进入具体模块，再操作当前模块'); return;
  }
  /*
   * 数据没取全时，打印与导出必须一起挡住。
   * 屏幕上已经拒绝显示金额了，但打印和 Excel 走的是各自的取值路径，
   * 不挡的话仍然会导出一份用残缺链条算出来的、看起来正常的报表——
   * 那比屏幕上显示错数字更危险，因为它会被打印出来签字归档。
   */
  var OUTPUT_ACTS = ['printMonth', 'printAll', 'xlsMonth', 'xlsAll', 'json'];
  if(cur && cur.truncated && OUTPUT_ACTS.indexOf(act) >= 0){
    toast('数据未取全（' + (cur.rows || []).length + '/' + (cur.serverTotal || 0) + '），为避免导出错误金额已阻止本次操作');
    return;
  }
  var rows = curRows(), calcs = calcsOf(rows);
  /* 打印统一走 printCurrent：模块自带 print/printAll 就用模块的，
     没有的（新增模块常见）退回按 columns 排的通用报表，而不是抛 TypeError。 */
  if(act === 'printMonth'){ printCurrent(displayRows(rows), calcs, false); }
  else if(act === 'printAll'){ printCurrent(rows, calcs, true); }
  else if(act === 'xlsMonth'){ exportExcelXls(xlsSpec(true)); }
  else if(act === 'xlsAll'){ exportExcelXls(xlsSpec(false)); }
  else if(act === 'json'){ exportJson(); }
  else if(act === 'printConfig'){ openPrintConfig(); }
  else if(act === 'seed'){
    if(confirm('将为没有数据的离线模块填入随机示例数据（已连接在线资料库或已有数据的模块不受影响）。继续？')){
      seedDemo();
      if(overviewActive()) renderOverview();
    }
  }
  else if(act === 'clear'){ clearAll(); }
}
/** 绑定「导出/打印」与「⋯」两个下拉菜单。由 main.js 在启动时调用一次。 */
export function bindMenus(){
  ['menuExport', 'menuMore'].forEach(function(id){
    var wrap = $('#' + id);
    if(!wrap) return;
    wrap.querySelector('.btn').addEventListener('click', function(e){
      e.stopPropagation();
      var was = wrap.className.indexOf('open') > -1;
      Array.prototype.forEach.call(document.querySelectorAll('.menu-wrap'), function(w){ w.className = 'menu-wrap'; });
      if(!was) wrap.className = 'menu-wrap open';
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.menu [data-act]'), function(b){
      b.addEventListener('click', function(){
        wrap.className = 'menu-wrap';
        menuAction(b.getAttribute('data-act'));
      });
    });
  });
  /* 一级「本月结转」按钮：月初最高频的动作不该藏在二级菜单里 */
  var carryBtn = $('#btnCarryQuick');
  if(carryBtn) carryBtn.addEventListener('click', function(){ menuAction('carry'); });
  document.addEventListener('click', function(){
    Array.prototype.forEach.call(document.querySelectorAll('.menu-wrap'), function(w){ w.className = 'menu-wrap'; });
  });
}
/* 期间快捷 chip：本月 / 上月（工具栏与总览两处同步高亮） */
export function ymOffset(off){
  var d = new Date();
  d.setMonth(d.getMonth() + off);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

