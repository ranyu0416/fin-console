import { $, toast } from './core/dom.js';
import { cur } from './core/state.js';
import { cacheForm, loadData } from './engine.js';
import { openCarry } from './features/carry.js';
import { openMasterData } from './features/masterdata.js';
import { openPaste } from './features/paste.js';
import { normalizeNumInput } from './formkit.js';
import { bindMenus, overviewActive } from './menu.js';
import { MODULES } from './modules/registry.js';
import { makeModule } from './modules/generic.js';
import { advanceBookPeriod, advancePeriod, bookYm, lockYmOf, refresh, renderModClose, renderPeriodBar, setPeriod, viewYm } from './period.js';
import { bindPeriodChips } from './periodchips.js';
import { bindBeforePrint } from './print.js';
import { loadOverviewSummaries } from './overview.js';
import { bindShell, initModule, switchModule } from './switch.js';

/*
 * 顶栏的月份选择器改的是「我要看哪个月」，纯个人动作，只读账号也能用。
 * 推进全局账套期间是另一件事，走「账套」按钮，需要结账权限并二次确认。
 */
const pbYm = $('#pbYm');
pbYm.addEventListener('change', function(){ setPeriod(pbYm.value); });
pbYm.addEventListener('input', function(){ if(pbYm.value) setPeriod(pbYm.value); });
$('#pbPrev').addEventListener('click', function(){ advancePeriod(-1); });
$('#pbNext').addEventListener('click', function(){ advancePeriod(1); });
const pbBook = $('#pbBook');
if(pbBook){
  pbBook.addEventListener('click', function(){
    // 推进目标＝当前正在查看的月份。用户的自然流程是先翻到目标月再决定推进；
    // 两者已经相同就没什么可推进的，直接提示而不是弹一个无意义的确认框。
    var target = viewYm();
    if(target === bookYm()){
      toast('账套期间已经是 ' + target + '；请先把查看期间切到要推进的月份');
      return;
    }
    advanceBookPeriod(target);
  });
}
$('#formBody').addEventListener('input', function(e){
  if(e.target && e.target.getAttribute && e.target.getAttribute('data-num')) normalizeNumInput(e.target);
  cacheForm();
  if(cur.onFormInput) cur.onFormInput.call(cur);
});
$('#formBody').addEventListener('change', function(e){
  if(e.target && e.target.getAttribute && e.target.getAttribute('data-num')) normalizeNumInput(e.target);
  cacheForm();
  if(cur.onFormInput) cur.onFormInput.call(cur);
});
/* 表体里的「数据加载失败…点击重试」行（见 engine.js renderLoadFailRow） */
$('#tbody').addEventListener('click', function(e){
  if(e.target && e.target.getAttribute && e.target.getAttribute('data-retry')) loadData();
});

/*
 * 构建号核对：静态资源没有内容哈希，浏览器 5 分钟缓存窗口内可能拼出
 * 新旧混搭的模块图——症状是「某个模块点进去行为不对/是空的，刷新又好了」。
 * 每分钟对一次构建号，不一致就明确提示刷新，把这类问题从玄学变成一句话。
 */
var buildIdAtLoad = null;
fetch('/build-id.json', { cache: 'no-store' })
  .then(function(r){ return r.json(); })
  .then(function(j){
    buildIdAtLoad = j.id;
    setInterval(function(){
      fetch('/build-id.json', { cache: 'no-store' })
        .then(function(r2){ return r2.json(); })
        .then(function(j2){
          if(buildIdAtLoad && j2.id !== buildIdAtLoad){
            buildIdAtLoad = j2.id;
            toast('检测到系统已更新，请刷新页面（Ctrl+F5）后再继续操作');
          }
        })
        .catch(function(){ /* 服务器重启窗口，下个周期再看 */ });
    }, 60000);
  })
  .catch(function(){ /* 单文件离线模式没有构建号 */ });

/* ---------- 启动 ---------- */
/* 当前可处理期间默认＝当前自然月（可在顶栏期间直接选择任意年-月） */
renderPeriodBar();
bindShell();
bindMenus();
bindPeriodChips();
bindBeforePrint();
Object.keys(MODULES).forEach(function(k){ initModule(MODULES[k]); });
window.__FIN_APP__ = {
  toast: toast,
  refresh: refresh,
  renderPeriodBar: renderPeriodBar,
  renderModClose: renderModClose,
  switchModule: switchModule,
  modules: MODULES,
  currentKey: function(){ return cur && cur.key; },
  reload: function(){ if(cur && cur.key && cur.key !== '__overview') loadData(); else refresh(); },
  /* bridge.js 后台补完明细缓存后回调：只在总览页时重绘，不打断正在录入的模块 */
  refreshOverview: function(){ if(overviewActive()) loadOverviewSummaries(); },
  /* 三个新面板：供自检脚本与 admin.js 直接调用 */
  openCarry: openCarry,
  openPaste: openPaste,
  openMasterData: openMasterData,
  /* 受控清单变更后由 bridge.js 回调：重开的表单会自动用上新清单 */
  masterChanged: function(){ if(cur && cur.key && cur.key !== '__overview') loadData(); },
  /* 两层期间模型的读取口，供自检脚本断言「锁的是哪个期间」 */
  bookYm: bookYm,
  viewYm: viewYm,
  lockYmOf: lockYmOf,
  /* 模块显隐自选：保存偏好后由 admin.js 回调重排页签 */
  applyModuleVisibility: applyModuleVisibility
};

/* ---------- 界面自定义模块 与 模块显隐自选 ---------- */

function applyModuleVisibility(){
  var hidden = window.__FIN_HIDDEN_MODS__ || [];
  Array.prototype.forEach.call(document.querySelectorAll('.mod-tab[data-mod]'), function(t){
    var mod = t.getAttribute('data-mod');
    t.style.display = (mod === '__overview' || hidden.indexOf(mod) < 0) ? '' : 'none';
  });
  /* 正在看的模块被自己隐藏了：退回总览，别停留在一个「隐身」页面里 */
  if (cur && cur.key && cur.key !== '__overview' && hidden.indexOf(cur.key) >= 0) switchModule('__overview', true);
}

function ensureCustomTab(key, name){
  if (document.querySelector('.mod-tab[data-mod="' + key + '"]')) return;
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'mod-tab';
  b.setAttribute('data-mod', key);
  b.textContent = name;
  b.addEventListener('click', function(){ switchModule(key); });
  document.querySelector('.mod-nav').appendChild(b);
}

/**
 * 界面自定义模块：定义存在服务端 settings，这里从 /api/schema 拉回字段定义，
 * 用通用模块工厂（makeModule）现场生成并注册，再补一个导航页签。
 * 只处理 custom_ 前缀的模块——内置模块各有专属算法文件，不走这条通道。
 */
function registerCustomModules(){
  if (!window.__FIN_API__) return Promise.resolve();
  return window.__FIN_API__('/api/schema').then(function(out){
    var me = window.__FIN_ME__ || {};
    var meta = {};
    (me.modules || []).forEach(function(m){ meta[m.key] = m; });
    (out.modules || []).forEach(function(def){
      var key = String(def.databaseId || '');
      if (key.indexOf('custom_') !== 0 || MODULES[key]) return;
      var metaM = meta[key] || {};
      var mod = makeModule({
        key: key,
        name: def.name || metaM.name || key,
        entity: metaM.entity || def.name || key,
        periodField: metaM.periodField || null,
        sortField: metaM.periodField || null,
        fields: (def.properties || []).map(function(p){
          return { name: p.name, type: p.type, options: (p.config && p.config.options) || null };
        }),
      });
      initModule(mod);
      MODULES[key] = mod;
      ensureCustomTab(key, mod.name);
    });
    applyModuleVisibility();
  }).catch(function(){ /* schema 拉取失败不阻塞：内置模块照常使用 */ });
}

registerCustomModules();
switchModule('__overview', true);
applyModuleVisibility();

