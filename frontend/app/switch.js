import { clearAll } from './clear.js';
import { $, setSync, toast } from './core/dom.js';
import { db, finServer } from './core/env.js';
import { cur, setCur, setEditingId } from './core/state.js';
import { closeModal, fillDynamicSelects, loadData, openModal, optId, optText, restoreFilterMemory, saveRecord } from './engine.js';
import { overviewActive } from './menu.js';
import { MODULES } from './modules/registry.js';
import { loadOverviewSummaries, renderOverview } from './overview.js';
import { setPeriod } from './period.js';
import { closePrintConfig, savePrintConfig } from './printconfig.js';

/* ---------- 模块切换 ---------- */
/**
 * 切换后把活动页签滚进视野。台账一多（18 个页签横向滚动），
 * 从左侧翻到右侧的页签后没有任何视觉回应，用户会以为没点上。
 * block:'nearest' 只横向滚、不纵向跳页；smooth 平滑但可被连续点击打断，安全。
 */
function scrollActiveTab(){
  var at = document.querySelector('.mod-tab.active');
  if(at && at.scrollIntoView){
    try{ at.scrollIntoView({ block: 'nearest', inline: 'center' }); }catch(e){ /* 旧浏览器忽略 */ }
  }
}
export function initModule(mod){
  mod.rows = [];
  mod.opts = {};
  mod.schemaFields = {};
  mod.hasCostObj = false;
  mod.online = !!(mod.dbId && db);
  mod.optText = function(field, val){ return optText(field, val); };
  mod.optId = function(field, v){ return optId(field, v); };
  mod.canWrite = function(field){ return !mod.online || !!mod.schemaFields[field]; };
}
export function switchModule(key, silent){
  if(key === '__overview'){
    setCur(MODULES.facility);   /* 保持 cur 有效，工具函数可用 */
  Array.prototype.forEach.call(document.querySelectorAll('.mod-tab'), function(t){
    t.className = 'mod-tab' + (t.getAttribute('data-mod') === '__overview' ? ' active' : '');
  });
  scrollActiveTab();
    $('#subTitle').textContent = '财务管理台 / 总览';
    $('#addBtnLabel').textContent = '新增';
    $('#attentionCard').style.display = 'none';
    $('#statsSection').style.display = 'none';
    $('#groupCard').style.display = 'none';
    $('#tableCard').style.display = 'none';
    $('#overviewCard').style.display = '';
    /*
     * 先用本机缓存立刻画一屏（不等网络），再拉服务端汇总把条数校正过来。
     * 汇总只有几百字节，不像以前那样为了进总览页把 6 个模块的明细全下载一遍。
     */
    renderOverview();
    loadOverviewSummaries();
    if(!silent) toast('已切换到「总览」');
    return;
  }
  var mod = MODULES[key];
  if(!mod) return;
  setCur(mod);
  $('#overviewCard').style.display = 'none';
  $('#statsSection').style.display = '';
  $('#tableCard').style.display = '';
  Array.prototype.forEach.call(document.querySelectorAll('.mod-tab'), function(t){
    t.className = 'mod-tab' + (t.getAttribute('data-mod') === key ? ' active' : '');
  });
  scrollActiveTab();
  $('#subTitle').textContent = '财务管理台 / ' + mod.name;
  $('#addBtnLabel').textContent = '新增' + mod.entity;
  $('#cardTitle').textContent = mod.cardTitle;
  $('#cardHint').textContent = mod.cardHint || '';
  restoreFilterMemory();
  setEditingId(null);
  $('#formBody').innerHTML = bindSelectFields(mod, mod.formHTML());
  if(mod.online){
    setSync('syncing');
    db.getSchema({ databaseId: mod.dbId }).then(function(schema){
      (schema.properties || []).forEach(function(field){
        mod.schemaFields[field.name] = true;
        if(mod.key === 'facility' && field.name === '成本对象') mod.hasCostObj = true;
        if((field.type === 'select' || field.type === 'multi_select') && field.config && field.config.options){
          mod.opts[field.name] = field.config.options;
        }
      });
      fillDynamicSelects();
      toggleTfaCostObj();
      loadData();
    }).catch(function(err){
      console.error('[database] schema 加载失败:', err);
      if(finServer()){ mod.loadFailed = true; }
      else { mod.online = false; }
      fillDynamicSelects();
      toggleTfaCostObj();
      loadData();
    });
  } else {
    fillDynamicSelects();
    toggleTfaCostObj();
    loadData();
  }
  if(!silent) toast('已切换到「' + mod.name + '」');
}
export function toggleTfaCostObj(){
  if(!cur || cur.key !== 'facility') return;
  [['costobj', '成本对象'], ['code', '设施编号']].forEach(function(pair){
    var el = document.querySelector('#formBody [name="' + pair[0] + '"]');
    if(el && el.closest('.fgroup')){
      el.closest('.fgroup').style.display = (cur.schemaFields[pair[1]] || !cur.online) ? '' : 'none';
    }
  });
}
export function bindSelectFields(mod, html){
  var map = {};
  if(mod.key === 'facility') map = { category: '设施类别', method: '摊销方法', status: '状态' };
  if(mod.key === 'asset') map = { type: '资产类型', status: '状态' };
  Object.keys(map).forEach(function(name){
    html = html.replace('<select name="' + name + '"', '<select data-field="' + map[name] + '" name="' + name + '"');
  });
  return html;
}

/* ---------- 事件绑定 ---------- */
/** 绑定页签、新增、弹窗、打印设置等静态控件。由 main.js 启动时调用一次。 */
export function bindShell(){
  Array.prototype.forEach.call(document.querySelectorAll('.mod-tab[data-mod]'), function(t){
    t.addEventListener('click', function(){ switchModule(t.getAttribute('data-mod')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.mod-tab.soon'), function(t){
    t.addEventListener('click', function(){ toast('该模块规划中，告诉小台你的需求即可加上'); });
  });
  $('#btnAdd').addEventListener('click', function(){ openModal(null); });
  var clearBtn = $('#btnClearModule');
  if(clearBtn) clearBtn.addEventListener('click', function(){ if(!overviewActive()) clearAll(); });
  $('#fPeriod').addEventListener('change', function(){ if($('#fPeriod').value) setPeriod($('#fPeriod').value, true); });
  $('#btnCancel').addEventListener('click', closeModal);
  $('#mask').addEventListener('click', function(e){ if(e.target === $('#mask')) closeModal(); });
  $('#form').addEventListener('submit', saveRecord);
  $('#btnPrintConfigCancel').addEventListener('click', closePrintConfig);
  $('#btnPrintConfigSave').addEventListener('click', savePrintConfig);
  $('#printConfigMask').addEventListener('click', function(e){ if(e.target === $('#printConfigMask')) closePrintConfig(); });
}

