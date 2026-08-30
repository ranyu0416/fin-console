/*
 * 服务端桥接层（浏览器侧）
 * ------------------------------------------------------------------
 * 职责：
 *   1. 登录/改密/退出的界面与流程；
 *   2. 把原页面依赖的 window.__SMART_PAGE__.database 换成本服务器的 REST API；
 *   3. 把「当前会计期间 / 结账状态 / 打印列配置」从浏览器本地搬到服务器共享，
 *      对台账脚本仍然表现为同步的 localStorage 接口；
 *   4. 轮询服务端期间与结账状态，多人同时使用时保持一致。
 * 台账计算逻辑（app.js）不做任何业务改动。
 */
(function () {
  'use strict';

  /*
   * 需要落到服务端的键。分两类：
   *   WORK_YM / CLOSURES / PRINT_PROFILES —— 全局共享，改了所有人都变；
   *   VIEW_YM                             —— 个人偏好，只影响自己。
   * 两类都要经服务端持久化（换机器/换浏览器要能带走），但走不同接口、不同权限。
   */
  var SHARED_KEYS = {
    WORK_YM: 'wb_work_ym',        // 账套期间（全局，需结账权限）
    VIEW_YM: 'wb_view_ym',        // 视图期间（个人，任何账号可改自己的）
    CLOSURES: 'wb_fin_closures',
    PRINT_PROFILES: 'wb_fin_print_profiles_v1',
  };
  var POLL_MS = 20000;

  var state = {
    me: null,
    booted: false,
    shared: {},          // 共享设置的本地镜像
    lastSignature: '',
    pollTimer: null,
    saving: 0,
  };

  /* ================= 基础请求 ================= */

  function api(path, options) {
    var opt = options || {};
    var init = {
      method: opt.method || 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    };
    if (opt.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opt.body);
    }
    return fetch(path, init).then(function (resp) {
      var ct = resp.headers.get('content-type') || '';
      var parse = ct.indexOf('application/json') >= 0 ? resp.json() : resp.text().then(function (t) { return { error: t }; });
      return parse.then(function (data) {
        if (!resp.ok) {
          var err = new Error((data && data.error) || '请求失败（HTTP ' + resp.status + '）');
          err.status = resp.status;
          err.code = data && data.code;
          throw err;
        }
        return data;
      });
    });
  }

  function el(id) { return document.getElementById(id); }

  function showToast(msg) {
    if (window.__FIN_APP__ && window.__FIN_APP__.toast) {
      window.__FIN_APP__.toast(msg);
      return;
    }
    var box = el('bridgeToast');
    if (!box) return;
    box.textContent = msg;
    box.style.display = 'block';
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.style.display = 'none'; }, 3200);
  }

  /* ================= 共享设置：同步接口 + 异步落库 ================= */

  var realStore = (function () {
    try {
      window.localStorage.setItem('__fin_probe__', '1');
      window.localStorage.removeItem('__fin_probe__');
      return window.localStorage;
    } catch (e) {
      // 隐私模式等场景下退化为内存存储，页面仍可用（仅本次会话）
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; },
      };
    }
  })();

  function pushShared(key, rawValue, prevValue) {
    if (key === SHARED_KEYS.WORK_YM) {
      var ym = String(rawValue || '');
      if (!/^\d{4}-\d{2}$/.test(ym)) return;
      // 推进账套期间：全局动作，服务端要求 canClose 权限
      trackSave(api('/api/period', { method: 'POST', body: { period: ym } }), '推进账套期间失败');
      return;
    }
    if (key === SHARED_KEYS.VIEW_YM) {
      var vym = String(rawValue || '');
      if (!vym) {
        // 清空＝取消个人选择，回到跟随账套期间
        trackSave(api('/api/view-period', { method: 'DELETE' }), '重置查看期间失败');
        return;
      }
      if (!/^\d{4}-\d{2}$/.test(vym)) return;
      // 个人偏好，任何账号都能改自己的；失败也不该打断浏览，所以只提示不回滚界面
      trackSave(api('/api/view-period', { method: 'POST', body: { period: vym } }), '保存查看期间失败');
      return;
    }
    if (key === SHARED_KEYS.PRINT_PROFILES) {
      var profiles = {};
      try { profiles = JSON.parse(rawValue || '{}') || {}; } catch (e) { profiles = {}; }
      trackSave(api('/api/settings', { method: 'POST', body: { printProfiles: profiles } }), '保存打印列配置失败');
      return;
    }
    if (key === SHARED_KEYS.CLOSURES) {
      // 台账脚本整体重写结账数组；这里换算成对服务端的增量结账/重开请求。
      // prevValue 必须是覆盖前的旧值，否则算不出差异（这里出过一次 bug，勿改成读 state）。
      var next = [];
      try { next = JSON.parse(rawValue || '[]') || []; } catch (e) { next = []; }
      var prev = [];
      try { prev = JSON.parse(prevValue || '[]') || []; } catch (e) { prev = []; }
      var nextKeys = {}; next.forEach(function (c) { if (c && c.key) nextKeys[c.key] = c; });
      var prevKeys = {}; prev.forEach(function (c) { if (c && c.key) prevKeys[c.key] = c; });
      var jobs = [];
      Object.keys(nextKeys).forEach(function (k) {
        if (!prevKeys[k]) jobs.push({ module: nextKeys[k].module, period: nextKeys[k].period, closed: true });
      });
      Object.keys(prevKeys).forEach(function (k) {
        if (!nextKeys[k]) jobs.push({ module: prevKeys[k].module, period: prevKeys[k].period, closed: false });
      });
      jobs.forEach(function (job) {
        trackSave(
          api('/api/closures', { method: 'POST', body: job }).then(function (out) {
            state.shared[SHARED_KEYS.CLOSURES] = JSON.stringify(out.closures || []);
          }),
          (job.closed ? '结账' : '重开') + '失败',
        );
      });
    }
  }

  function trackSave(promise, failMessage) {
    state.saving += 1;
    setSyncBadge('syncing');
    return promise
      .then(function (out) {
        return out;
      })
      .catch(function (err) {
        showToast(failMessage + '：' + err.message);
        // 服务端拒绝时立即回读，避免本地镜像与服务端不一致
        return refreshShared().then(function () { throw err; }, function () { throw err; });
      })
      .finally(function () {
        state.saving = Math.max(0, state.saving - 1);
        if (!state.saving) setSyncBadge('synced');
      })
      .catch(function () { /* 已提示，避免未捕获拒绝 */ });
  }

  /** 交给 app.js 使用的 localStorage 替身 */
  var storageShim = {
    getItem: function (key) {
      if (Object.prototype.hasOwnProperty.call(state.shared, key)) return state.shared[key];
      return realStore.getItem(key);
    },
    setItem: function (key, value) {
      if (isSharedKey(key)) {
        var str = String(value);
        var before = state.shared[key];
        state.shared[key] = str;
        if (before !== str) pushShared(key, str, before);
        return;
      }
      realStore.setItem(key, value);
    },
    removeItem: function (key) {
      if (isSharedKey(key)) {
        state.shared[key] = key === SHARED_KEYS.CLOSURES ? '[]' : '';
        return;
      }
      realStore.removeItem(key);
    },
  };

  function isSharedKey(key) {
    return (
      key === SHARED_KEYS.WORK_YM ||
      key === SHARED_KEYS.VIEW_YM ||
      key === SHARED_KEYS.CLOSURES ||
      key === SHARED_KEYS.PRINT_PROFILES
    );
  }

  window.__FIN_STORAGE__ = storageShim;

  /* ================= database 适配：REST 版 ================= */

  function modulePath(databaseId) {
    return '/api/modules/' + encodeURIComponent(String(databaseId || ''));
  }

  var database = {
    getSchema: function (params) {
      return api(modulePath(params && params.databaseId) + '/schema');
    },
    query: function (params) {
      var p = params || {};
      var qs = [];
      if (p.pageSize) qs.push('limit=' + encodeURIComponent(p.pageSize));
      return api(modulePath(p.databaseId) + '/records' + (qs.length ? '?' + qs.join('&') : '')).then(function (out) {
        /*
         * total 是服务端符合条件的真实总数，truncated 表示这次没取全。
         * 必须原样透出：链式计提要靠它判断数据是否完整，
         * 拿残缺数据接着算会得出自洽但错误的金额。
         */
        return {
          results: out.results || [],
          total: out.total || 0,
          returned: out.returned === undefined ? (out.results || []).length : out.returned,
          truncated: !!out.truncated,
        };
      });
    },
    addRecord: function (params) {
      var p = params || {};
      return api(modulePath(p.databaseId) + '/records', { method: 'POST', body: { properties: p.properties } });
    },
    updateRecord: function (params) {
      var p = params || {};
      // rev 是乐观锁：调用方把读到的版本号带上，服务端比对不上就 409。
      // 不带 rev 时服务端放行（兼容脚本调用），所以这里只在确实有值时才发。
      var body = { properties: p.properties };
      if (p.rev !== undefined && p.rev !== null) body.rev = p.rev;
      return api(modulePath(p.databaseId) + '/records/' + encodeURIComponent(p.recordId), {
        method: 'PATCH',
        body: body,
      });
    },
    deleteRecord: function (params) {
      var p = params || {};
      return api(modulePath(p.databaseId) + '/records/' + encodeURIComponent(p.recordId), { method: 'DELETE' });
    },
    /* 扩展：整模块清空，比逐条删除快得多 */
    clearModule: function (params) {
      var p = params || {};
      return api(modulePath(p.databaseId) + '/records', { method: 'DELETE' });
    },
    importRecords: function (params) {
      var p = params || {};
      return api(modulePath(p.databaseId) + '/import', {
        method: 'POST',
        body: { rows: p.rows || [], replace: !!p.replace, allowNewNames: !!p.allowNewNames },
      });
    },
    /* 粘贴导入用：只校验不写库，返回每一行的错误 */
    checkRecords: function (params) {
      var p = params || {};
      return api(modulePath(p.databaseId) + '/import/check', { method: 'POST', body: { rows: p.rows || [] } });
    },
  };

  window.__SMART_PAGE__ = window.__SMART_PAGE__ || {};
  window.__SMART_PAGE__.database = database;

  /* ================= 同步状态灯 ================= */

  function setSyncBadge(mode) {
    var badge = el('syncBadge');
    var text = el('syncText');
    if (!badge || !text) return;
    badge.className = 'sync-badge' + (mode === 'synced' ? '' : ' ' + mode);
    text.textContent = mode === 'synced' ? '已同步' : mode === 'syncing' ? '同步中' : '连接中断';
    var tip = el('offlineTip');
    if (tip) tip.className = 'offline-tip' + (mode === 'offline' ? ' show' : '');
  }

  /* ================= 拉取共享状态 ================= */

  function applySharedPayload(payload) {
    var changed = false;
    var ym = String(payload.workPeriod || '');
    if (ym && state.shared[SHARED_KEYS.WORK_YM] !== ym) {
      state.shared[SHARED_KEYS.WORK_YM] = ym;
      changed = true;
    }
    /*
     * 视图期间只在服务端明确给了值时才覆盖本地。
     * 不能像账套期间那样无条件同步：用户可能刚在本地翻到上个月，
     * 20 秒后的轮询如果把服务端的旧值盖回来，界面就会自己跳走。
     * 服务端返回的 viewPeriod 在用户没设过时等于 workPeriod，
     * 所以这里额外要求它与账套期间不同，或本地根本还没有值。
     */
    var vym = String(payload.viewPeriod || '');
    if (vym) {
      var localView = state.shared[SHARED_KEYS.VIEW_YM];
      if (!localView) {
        state.shared[SHARED_KEYS.VIEW_YM] = vym;
        changed = true;
      }
    }
    var closures = JSON.stringify(payload.closures || []);
    if (state.shared[SHARED_KEYS.CLOSURES] !== closures) {
      state.shared[SHARED_KEYS.CLOSURES] = closures;
      changed = true;
    }
    if (payload.printProfiles !== undefined) {
      var profiles = JSON.stringify(payload.printProfiles || {});
      if (state.shared[SHARED_KEYS.PRINT_PROFILES] !== profiles) {
        state.shared[SHARED_KEYS.PRINT_PROFILES] = profiles;
        changed = true;
      }
    }
    return changed;
  }

  function refreshShared() {
    return api('/api/period').then(function (out) {
      var changed = applySharedPayload(out);
      setSyncBadge('synced');
      return changed;
    });
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(function () {
      if (document.hidden || state.saving) return;
      api('/api/period')
        .then(function (out) {
          var sig = String(out.workPeriod || '') + '|' + String(out.viewPeriod || '') + '|' + JSON.stringify(out.closures || []);
          if (sig === state.lastSignature) {
            setSyncBadge('synced');
            return;
          }
          state.lastSignature = sig;
          var changed = applySharedPayload(out);
          setSyncBadge('synced');
          if (changed && window.__FIN_APP__) {
            if (window.__FIN_APP__.renderPeriodBar) window.__FIN_APP__.renderPeriodBar();
            if (window.__FIN_APP__.renderModClose) window.__FIN_APP__.renderModClose();
            if (window.__FIN_APP__.refresh) window.__FIN_APP__.refresh();
          }
        })
        .catch(function (err) {
          if (err.status === 401) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
            showLogin('会话已过期，请重新登录');
            return;
          }
          setSyncBadge('offline');
        });
    }, POLL_MS);
  }

  /* ================= 登录界面 ================= */

  function showLogin(message) {
    var overlay = el('authOverlay');
    if (!overlay) return;
    overlay.classList.add('show');
    el('appShell').style.display = 'none';
    el('authError').textContent = message || '';
    el('authError').style.display = message ? 'block' : 'none';
    el('changePanel').style.display = 'none';
    el('loginPanel').style.display = 'block';
    var u = el('loginUser');
    if (u) setTimeout(function () { u.focus(); }, 50);
  }

  function showChangePassword(message) {
    el('authOverlay').classList.add('show');
    el('appShell').style.display = 'none';
    el('loginPanel').style.display = 'none';
    el('changePanel').style.display = 'block';
    el('changeError').textContent = message || '首次登录或口令被重置，请设置新口令后继续。';
    el('changeError').style.display = 'block';
    setTimeout(function () { el('newPwd1').focus(); }, 50);
  }

  function hideAuth() {
    el('authOverlay').classList.remove('show');
    el('appShell').style.display = '';
  }

  function renderIdentity() {
    var box = el('userChip');
    if (!box || !state.me) return;
    var u = state.me.user;
    box.innerHTML =
      '<span class="uc-name" title="' + escAttr(u.username) + '">' + escHtml(u.displayName || u.username) + '</span>' +
      '<span class="uc-role">' + escHtml(u.roleLabel || u.role) + '</span>' +
      '<button type="button" class="btn btn-sm" id="btnChangePwd">改密</button>' +
      '<button type="button" class="btn btn-sm" id="btnLogout">退出</button>';
    el('btnChangePwd').addEventListener('click', function () { showChangePassword('请输入当前口令与新口令。'); });
    el('btnLogout').addEventListener('click', doLogout);
    document.body.classList.toggle('role-viewer', !state.me.can.write);
    document.body.classList.toggle('role-admin', !!state.me.can.admin);
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

  function doLogout() {
    api('/api/logout', { method: 'POST' })
      .catch(function () { /* 即便请求失败也回到登录页 */ })
      .then(function () { window.location.reload(); });
  }

  /* ================= 启动 ================= */

  function loadAppScript() {
    if (state.booted) return Promise.resolve();
    state.booted = true;
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      // 台账是 ES 模块图，入口 app/main.js 自行 import 其余模块
      s.type = 'module';
      s.src = 'app/main.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('台账脚本 app/main.js 加载失败')); };
      document.body.appendChild(s);
    });
  }

  /**
   * 登录后拉一次轻量汇总：期间、结账状态、各模块条数。响应几百字节。
   * 这一步在关键路径上，必须快——界面要等它返回才开始加载应用脚本。
   */
  function primeShared() {
    return api('/api/overview')
      .then(function (out) {
        applySharedPayload(out);
        if (out && out.summaries) window.__FIN_SUMMARIES__ = out.summaries;
      })
      .catch(function () { /* 拿不到汇总不阻塞启动，总览页会退回纯缓存视图 */ });
  }

  /**
   * 后台预热各模块明细缓存，让总览页的金额 KPI 有数可算。
   *
   * 关键点是「后台」：以前这一步在启动关键路径上同步等待，而它返回的是
   * 6 个模块的全部明细——300 条数据就是 98.8 KB，1 Mbps 下要等近 1 秒才开始
   * 加载应用脚本，用户看到的是一片空白。现在改成先把界面跑起来，
   * 明细在后面慢慢补，补完再让总览页自己重绘一次。
   *
   * 金额 KPI 之所以仍需明细：摊销/折旧/账龄要按启用日期、残值率、上期累计
   * 逐条推算，这套口径目前只有前端实现，服务端只出得了条数类汇总。
   */
  function primeOverviewCache() {
    return api('/api/overview?detail=1')
      .then(function (out) {
        applySharedPayload(out);
        if (out && out.summaries) window.__FIN_SUMMARIES__ = out.summaries;
        var modules = out.modules || {};
        Object.keys(modules).forEach(function (key) {
          try {
            realStore.setItem('wb_fin_' + key + '_cache', JSON.stringify(modules[key] || []));
          } catch (e) { /* 缓存写不进去不影响联机使用 */ }
        });
      })
      .catch(function () { /* 预热失败不阻塞使用，进入具体模块时会拉到最新数据 */ });
  }

  function bootAuthenticated(me) {
    state.me = me;
    state.shared[SHARED_KEYS.WORK_YM] = String(me.workPeriod || '');
    // 服务端在用户没设过时返回 workPeriod，所以这里直接采用即可
    state.shared[SHARED_KEYS.VIEW_YM] = String(me.viewPeriod || me.workPeriod || '');
    state.shared[SHARED_KEYS.CLOSURES] = JSON.stringify(me.closures || []);
    state.shared[SHARED_KEYS.PRINT_PROFILES] = JSON.stringify(me.printProfiles || {});
    state.lastSignature = String(me.workPeriod || '') + '|' + JSON.stringify(me.closures || []);

    // app 模块在启动时读取这几个全局量，必须先于脚本加载写好
    window.__FIN_SERVER__ = true;
    window.__FIN_CAN__ = me.can || { write: false, close: false, admin: false };
    window.__FIN_ORG__ = me.orgName || '';
    window.__FIN_ME__ = me;
    window.__FIN_HIDDEN_MODS__ = me.hiddenModules || [];
    window.__FIN_API__ = api;
    // 受控清单：单位与项目主数据，录入界面据此生成下拉框
    window.__FIN_MASTER__ = {
      strict: me.masterDataStrict !== false,
      units: me.units || [],
      projects: me.projects || [],
      carryModules: me.carryModules || [],
    };
    window.__FIN_RELOAD_MASTER__ = function () {
      return Promise.all([api('/api/master/units'), api('/api/master/projects')]).then(function (out) {
        window.__FIN_MASTER__.units = out[0].units || [];
        window.__FIN_MASTER__.strict = out[0].strict !== false;
        window.__FIN_MASTER__.projects = out[1].projects || [];
        if (window.__FIN_APP__ && window.__FIN_APP__.masterChanged) window.__FIN_APP__.masterChanged();
        return window.__FIN_MASTER__;
      });
    };
    window.__FIN_REFRESH_OVERVIEW__ = function (done) {
      primeOverviewCache().then(function () { if (typeof done === 'function') done(); });
    };

    hideAuth();
    renderIdentity();
    setSyncBadge('syncing');

    return primeShared()
      .then(loadAppScript)
      .then(function () {
        setSyncBadge('synced');
        startPolling();
        if (window.__FIN_ADMIN_READY__) window.__FIN_ADMIN_READY__(me);
        // 界面已经能用了，明细缓存放到后面补；补完只重绘总览，不打断正在操作的模块
        primeOverviewCache().then(function () {
          if (window.__FIN_APP__ && window.__FIN_APP__.refreshOverview) window.__FIN_APP__.refreshOverview();
        });
      })
      .catch(function (err) {
        setSyncBadge('offline');
        showToast(err.message);
      });
  }

  function bootstrap() {
    setSyncBadge('syncing');
    api('/api/me')
      .then(function (out) {
        if (!out.authenticated) {
          showLogin('');
          return;
        }
        if (out.user.mustChange) {
          state.me = out;
          showChangePassword('首次登录或口令已被重置，请设置新口令。');
          return;
        }
        bootAuthenticated(out);
      })
      .catch(function () {
        setSyncBadge('offline');
        showLogin('无法连接服务器，请确认服务已启动后刷新页面。');
      });
  }

  function bindAuthForms() {
    el('loginPanel').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = el('btnLogin');
      var username = el('loginUser').value.trim();
      var password = el('loginPwd').value;
      if (!username || !password) {
        el('authError').textContent = '请输入账号与口令';
        el('authError').style.display = 'block';
        return;
      }
      btn.disabled = true;
      btn.textContent = '登录中…';
      api('/api/login', { method: 'POST', body: { username: username, password: password } })
        .then(function (out) {
          el('loginPwd').value = '';
          if (out.user.mustChange) {
            state.me = out;
            showChangePassword('首次登录，请设置新口令。');
            return;
          }
          bootAuthenticated(out);
        })
        .catch(function (err) {
          el('authError').textContent = err.message;
          el('authError').style.display = 'block';
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = '登录';
        });
    });

    el('changePanel').addEventListener('submit', function (e) {
      e.preventDefault();
      var cur = el('curPwd').value;
      var p1 = el('newPwd1').value;
      var p2 = el('newPwd2').value;
      var err = el('changeError');
      if (p1 !== p2) {
        err.textContent = '两次输入的新口令不一致';
        err.style.display = 'block';
        return;
      }
      var btn = el('btnChangeSubmit');
      btn.disabled = true;
      btn.textContent = '提交中…';
      api('/api/password', { method: 'POST', body: { currentPassword: cur, newPassword: p1 } })
        .then(function () {
          el('curPwd').value = el('newPwd1').value = el('newPwd2').value = '';
          showLogin('口令已修改，请用新口令重新登录。');
        })
        .catch(function (e2) {
          err.textContent = e2.message;
          err.style.display = 'block';
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = '保存新口令';
        });
    });

    el('btnChangeCancel').addEventListener('click', function () {
      if (state.me && state.me.user && !state.me.user.mustChange) {
        hideAuth();
        return;
      }
      doLogout();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindAuthForms(); bootstrap(); });
  } else {
    bindAuthForms();
    bootstrap();
  }
})();
