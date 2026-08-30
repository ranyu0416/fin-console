import { $ } from './core/dom.js';
import { renderAll, saveFilterMemory, saveRecord } from './engine.js';
import { ymOffset } from './menu.js';
import { setPeriod, viewYm } from './period.js';

export function syncPeriodChips(){
  // 快捷 chip 切的是「我要看哪个月」，所以对齐视图期间而不是账套期间
  var v = viewYm();
  Array.prototype.forEach.call(document.querySelectorAll('.period-chips .chip'), function(c){
    c.className = 'chip' + (v === ymOffset(+c.getAttribute('data-ym')) ? ' on' : '');
  });
}
/** 绑定期间快捷 chip、Ctrl+S 保存、筛选框记忆。由 main.js 启动时调用一次。 */
export function bindPeriodChips(){
  Array.prototype.forEach.call(document.querySelectorAll('.period-chips .chip'), function(c){
    c.addEventListener('click', function(){
      setPeriod(ymOffset(+c.getAttribute('data-ym')));
    });
  });
  syncPeriodChips();
  /* Ctrl+S 保存表单 */
  document.addEventListener('keydown', function(e){
    if((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && $('#mask').className.indexOf('open') > -1){
      e.preventDefault();
      saveRecord(e);
    }
  });
  ['kw', 'fCat', 'fStatus', 'fUnit'].forEach(function(id){
    var el = $('#' + id);
    if(!el) return;
    el.addEventListener('input', function(){ saveFilterMemory(); renderAll(); });
    el.addEventListener('change', function(){ saveFilterMemory(); renderAll(); });
  });
}

