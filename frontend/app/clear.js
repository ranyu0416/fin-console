import { setSync, toast } from './core/dom.js';
import { FIN_STORE, db } from './core/env.js';
import { cur } from './core/state.js';
import { buildFilterSelects, curRows, loadData, renderAll, saveCache } from './engine.js';
import { MODULES } from './modules/registry.js';
import { guardUnlocked } from './period.js';

export function clearAll(){
  if(!guardUnlocked()) return;
  var rows = curRows();
  if(!rows.length){ toast('当前没有数据'); return; }
  if(!confirm('确定清空「' + cur.name + '」全部 ' + rows.length + ' 条记录吗？建议先导出备份。')) return;
  if(!confirm('二次确认：清空后数据不可恢复，确定继续？')) return;
  if(!cur.online){
    cur.rows = []; saveCache(); renderAll(); toast('已清空（离线模式）');
    return;
  }
  setSync('syncing');
  var clearReq = db.clearModule
    ? db.clearModule({ databaseId: cur.dbId })
    : rows.reduce(function(chain, r){
        return chain.then(function(){ return db.deleteRecord({ databaseId: cur.dbId, recordId: r._id }); });
      }, Promise.resolve());
  clearReq.then(function(){ toast('已清空全部数据'); loadData(); })
    .catch(function(err){ console.error('[database] 清空失败:', err); toast(err && err.message ? err.message : '清空失败，请刷新查看'); loadData(); });
}

/* ---------- 示例数据 ---------- */
export function seedDemo(){
  var seeded = [], skipped = [];
  Object.keys(MODULES).forEach(function(k){
    var mod = MODULES[k];
    if(mod.online || (mod.rows && mod.rows.length)){ skipped.push(mod.name); return; }
    if(!mod.seed) return;
    var rows = mod.seed();
    rows.forEach(function(r, i){ r._id = 'demo_' + k + '_' + (i + 1); });
    mod.rows = rows;
    try{ FIN_STORE.setItem(mod.cacheKey, JSON.stringify(rows)); }catch(e){}
    seeded.push(mod.name);
  });
  renderAll();
  buildFilterSelects();
  toast(seeded.length
    ? '已填入示例数据：' + seeded.join('、') + (skipped.length ? '（' + skipped.join('、') + '已有数据或在线，跳过）' : '')
    : '没有可填入的空模块（均已在线或已有数据）');
}

/* ---------- 总览工作台（v2）：跨模块 KPI + 待办汇总，数据取各模块本地缓存快照 ---------- */

