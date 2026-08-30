/*
 * 服务器版附加面板：操作日志、账号管理、数据备份、旧数据迁移。
 * 通过 window.__FIN_MENU__ 挂到台账的「⋯」菜单上，不改台账业务逻辑。
 * 注意：结转、粘贴导入、单位/项目清单由台账自身实现（app/features/），
 * menu.js 会在查这里之前先处理那三个动作。
 */
(function () {
  'use strict';

  /*
   * 模块清单以服务端 /api/me 返回的 modules 为准（bridge.js 已存进 window.__FIN_ME__）。
   *
   * 这里原来是手抄的两份常量。新增模块时漏改不会报任何错，
   * 只是操作日志的模块筛选框、「导入本机旧数据」的模块下拉里少一项，
   * 审计表格里那个模块的名字还会退化成英文 key——都很难联想到是这里。
   * 服务端 schema 已经是权威来源，直接读它；拿不到时才退回内置清单。
   */
  var FALLBACK_KEYS = ['facility', 'levy', 'union', 'asset', 'baddebt', 'lvc'];
  function serverModules() {
    var me = window.__FIN_ME__;
    var list = me && Array.isArray(me.modules) ? me.modules : [];
    return list.filter(function (m) { return m && m.key; });
  }
  function moduleKeys() {
    var list = serverModules();
    return list.length ? list.map(function (m) { return m.key; }) : FALLBACK_KEYS.slice();
  }
  function moduleName(key) {
    var list = serverModules();
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i].name || key;
    }
    return key || '';
  }

  function el(id) { return document.getElementById(id); }
  function api(path, options) { return window.__FIN_API__(path, options); }
  function toast(msg) {
    if (window.__FIN_APP__ && window.__FIN_APP__.toast) window.__FIN_APP__.toast(msg);
    else console.log(msg);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function localTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function bytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(1) + ' MB';
  }

  function openPanel(title, html) {
    el('adminTitle').textContent = title;
    el('adminBody').innerHTML = html;
    el('adminMask').className = 'mask open';
  }
  function closePanel() { el('adminMask').className = 'mask'; }

  /* ================= 操作日志 ================= */

  var ACTION_LABEL = {
    'login.ok': '登录成功',
    'login.fail': '登录失败',
    'login.blocked': '登录被限流',
    logout: '退出登录',
    'password.change': '修改口令',
    'record.create': '新增记录',
    'record.update': '修改记录',
    'record.delete': '删除记录',
    'record.clear': '清空模块',
    'record.import': '导入数据',
    'record.carry': '本月结转',
    'master.unit.add': '新增单位',
    'master.unit.update': '修改单位',
    'master.unit.rename': '单位改名',
    'master.unit.disable': '停用单位',
    'master.project.add': '新增项目',
    'master.project.update': '修改项目',
    'master.project.rename': '项目改名',
    'master.project.disable': '停用项目',
    'master.seed': '归集清单',
    'master.strict': '受控清单开关',
    'period.set': '切换期间',
    'period.close': '结账',
    'period.reopen': '重开期间',
    'settings.update': '修改设置',
    'data.export': '导出整套账',
    'data.import': '从备份恢复整套账',
    'data.backup': '生成备份',
    'user.create': '新增账号',
    'user.update': '修改账号',
    'user.disable': '停用账号',
    'user.reset_password': '重置口令',
    'bootstrap.admin': '初始化管理员',
    error: '服务器错误',
  };

  function showAudit() {
    openPanel('操作日志', '<div class="adm-hint">正在加载…</div>');
    var filterHtml =
      '<div class="adm-toolbar">' +
      '<select id="admAuditModule"><option value="">全部模块</option>' +
      moduleKeys().map(function (k) { return '<option value="' + k + '">' + esc(moduleName(k)) + '</option>'; }).join('') +
      '</select>' +
      '<select id="admAuditLimit"><option value="200">最近 200 条</option><option value="500">最近 500 条</option><option value="1000">最近 1000 条</option></select>' +
      '<button class="btn btn-sm" id="admAuditReload" type="button">刷新</button>' +
      '</div>';

    function load() {
      var mod = el('admAuditModule') ? el('admAuditModule').value : '';
      var limit = el('admAuditLimit') ? el('admAuditLimit').value : 200;
      var qs = '?limit=' + encodeURIComponent(limit) + (mod ? '&module=' + encodeURIComponent(mod) : '');
      el('admAuditTable').innerHTML = '<div class="adm-hint">加载中…</div>';
      api('/api/audit' + qs)
        .then(function (out) {
          var rows = out.rows || [];
          if (!rows.length) {
            el('admAuditTable').innerHTML = '<div class="adm-hint">暂无日志记录。</div>';
            return;
          }
          el('admAuditTable').innerHTML =
            '<div class="adm-scroll"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>模块</th><th>详情</th></tr></thead><tbody>' +
            rows
              .map(function (r) {
                return (
                  '<tr><td>' + localTime(r.at) + '</td>' +
                  '<td>' + esc(r.actor) + '</td>' +
                  '<td>' + esc(ACTION_LABEL[r.action] || r.action) + '</td>' +
                  '<td>' + esc(r.module ? moduleName(r.module) : '—') + '</td>' +
                  '<td class="detail">' + esc(String(r.detail || '').slice(0, 400)) + '</td></tr>'
                );
              })
              .join('') +
            '</tbody></table></div>';
        })
        .catch(function (err) { el('admAuditTable').innerHTML = '<div class="adm-hint">加载失败：' + esc(err.message) + '</div>'; });
    }

    openPanel('操作日志', filterHtml + '<div id="admAuditTable"></div>');
    el('admAuditReload').addEventListener('click', load);
    el('admAuditModule').addEventListener('change', load);
    el('admAuditLimit').addEventListener('change', load);
    var curKey = window.__FIN_APP__ && window.__FIN_APP__.currentKey && window.__FIN_APP__.currentKey();
    if (curKey && moduleKeys().indexOf(curKey) >= 0) el('admAuditModule').value = curKey;
    load();
  }

  /* ================= 账号管理 ================= */

  function showUsers() {
    openPanel('账号管理', '<div class="adm-hint">正在加载…</div>');
    api('/api/users')
      .then(function (out) {
        var roles = out.roles || [];
        var html =
          '<div class="adm-hint">角色权限：管理员＝全部权限（含账号、备份）；记账员＝录入、修改、结账；只读＝只能查看与打印。' +
          '新增账号后请把初始口令线下告知本人，其首次登录会被强制改密。</div>' +
          '<div class="adm-row">' +
          '<div class="fgroup"><label>账号</label><input id="admNewUser" type="text" placeholder="字母数字，如 wangfin"></div>' +
          '<div class="fgroup"><label>姓名</label><input id="admNewName" type="text" placeholder="如 王会计"></div>' +
          '<div class="fgroup"><label>角色</label><select id="admNewRole">' +
          roles.map(function (r) { return '<option value="' + esc(r.key) + '"' + (r.key === 'accountant' ? ' selected' : '') + '>' + esc(r.label) + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="fgroup"><label>初始口令（留空自动生成）</label><input id="admNewPwd" type="text" placeholder="至少 8 位，含字母和数字"></div>' +
          '<button class="btn btn-primary" id="admCreateUser" type="button">新增账号</button>' +
          '</div>' +
          '<div id="admUserTable"></div>';
        openPanel('账号管理', html);
        el('admCreateUser').addEventListener('click', createUser);
        renderUserTable(out.users || [], roles);
      })
      .catch(function (err) { openPanel('账号管理', '<div class="adm-hint">加载失败：' + esc(err.message) + '</div>'); });
  }

  function renderUserTable(users, roles) {
    var me = window.__FIN_ME__ && window.__FIN_ME__.user ? window.__FIN_ME__.user.username : '';
    el('admUserTable').innerHTML =
      '<div class="adm-scroll"><table><thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>' +
      users
        .map(function (u) {
          var roleSel =
            '<select data-role-for="' + esc(u.username) + '">' +
            roles.map(function (r) { return '<option value="' + esc(r.key) + '"' + (r.key === u.role ? ' selected' : '') + '>' + esc(r.label) + '</option>'; }).join('') +
            '</select>';
          var actions =
            '<button class="btn btn-sm" data-reset="' + esc(u.username) + '">重置口令</button>' +
            (u.username === me
              ? ''
              : u.disabled
                ? '<button class="btn btn-sm" data-enable="' + esc(u.username) + '">启用</button>'
                : '<button class="btn btn-sm btn-danger" data-disable="' + esc(u.username) + '">停用</button>');
          return (
            '<tr><td>' + esc(u.username) + (u.username === me ? '（本人）' : '') + '</td>' +
            '<td>' + esc(u.display_name) + '</td>' +
            '<td>' + roleSel + '</td>' +
            '<td>' + (u.disabled ? '<span class="pill gone">已停用</span>' : '<span class="pill use">正常</span>') +
            (u.must_change ? ' <span class="pill done">待改密</span>' : '') + '</td>' +
            '<td>' + (u.last_login ? localTime(u.last_login) : '从未登录') + '</td>' +
            '<td><div class="row-actions">' + actions + '</div></td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';

    Array.prototype.forEach.call(el('admUserTable').querySelectorAll('[data-role-for]'), function (sel) {
      sel.addEventListener('change', function () {
        var name = sel.getAttribute('data-role-for');
        api('/api/users/' + encodeURIComponent(name), { method: 'PATCH', body: { role: sel.value } })
          .then(function () { toast('已更新 ' + name + ' 的角色'); })
          .catch(function (err) { toast('更新失败：' + err.message); showUsers(); });
      });
    });
    Array.prototype.forEach.call(el('admUserTable').querySelectorAll('[data-reset]'), function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-reset');
        var pwd = prompt('为「' + name + '」设置新口令（至少 8 位，含字母和数字）。设置后该账号会被强制下线并要求改密。');
        if (!pwd) return;
        api('/api/users/' + encodeURIComponent(name), { method: 'PATCH', body: { password: pwd } })
          .then(function () { toast('已重置 ' + name + ' 的口令'); showUsers(); })
          .catch(function (err) { toast('重置失败：' + err.message); });
      });
    });
    Array.prototype.forEach.call(el('admUserTable').querySelectorAll('[data-disable]'), function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-disable');
        if (!confirm('停用「' + name + '」？该账号会立即下线，但历史数据与日志保留。')) return;
        api('/api/users/' + encodeURIComponent(name), { method: 'DELETE' })
          .then(function () { toast('已停用 ' + name); showUsers(); })
          .catch(function (err) { toast('停用失败：' + err.message); });
      });
    });
    Array.prototype.forEach.call(el('admUserTable').querySelectorAll('[data-enable]'), function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-enable');
        api('/api/users/' + encodeURIComponent(name), { method: 'PATCH', body: { disabled: false } })
          .then(function () { toast('已启用 ' + name); showUsers(); })
          .catch(function (err) { toast('启用失败：' + err.message); });
      });
    });
  }

  function createUser() {
    var username = el('admNewUser').value.trim();
    var displayName = el('admNewName').value.trim();
    var role = el('admNewRole').value;
    var password = el('admNewPwd').value;
    if (!username) { toast('请填写账号'); return; }
    var body = { username: username, displayName: displayName, role: role };
    if (password) body.password = password;
    api('/api/users', { method: 'POST', body: body })
      .then(function (out) {
        if (out.initialPassword) {
          alert('账号「' + username + '」已创建。\n初始口令：' + out.initialPassword + '\n请线下告知本人，首次登录须改密。');
        } else {
          toast('账号已创建：' + username);
        }
        showUsers();
      })
      .catch(function (err) { toast('创建失败：' + err.message); });
  }

  /* ================= 数据备份 ================= */

  function showBackup() {
    openPanel('数据备份', '<div class="adm-hint">正在加载…</div>');
    api('/api/backup')
      .then(function (out) {
        var list = out.backups || [];
        var html =
          '<div class="adm-hint">备份文件位于服务器的 <code>data/backups</code> 目录，由服务端定时热备生成（默认每 24 小时一份，保留 30 份）。<br>' +
          '恢复有两种方式：<b>①</b> 用下面的「从 JSON 恢复」上传之前导出的整套账 JSON——会先预演给你看清覆盖范围，服务端在正式覆盖前还会自动备份一次现状；' +
          '<b>②</b> 直接换库文件：停止服务 → 用备份文件替换 <code>data/fin.db</code> 并删除同目录的 <code>fin.db-wal</code>、<code>fin.db-shm</code> → 重新启动。</div>' +
          '<div class="adm-toolbar">' +
          '<button class="btn btn-primary btn-sm" id="admBackupNow" type="button">立即备份</button>' +
          '<button class="btn btn-sm" id="admDownloadAll" type="button">下载整套账 JSON</button>' +
          '<label class="btn btn-sm" style="cursor:pointer">从 JSON 恢复<input id="admRestoreFile" type="file" accept="application/json,.json" style="display:none"></label>' +
          '</div>' +
          (list.length
            ? '<div class="adm-scroll"><table><thead><tr><th>备份文件</th><th class="num">大小</th><th>生成时间</th></tr></thead><tbody>' +
              list.map(function (b) {
                return '<tr><td>' + esc(b.file) + '</td><td class="num">' + bytes(b.size) + '</td><td>' + localTime(b.at) + '</td></tr>';
              }).join('') +
              '</tbody></table></div>'
            : '<div class="adm-hint">还没有备份文件。点击「立即备份」可马上生成一份。</div>');
        openPanel('数据备份', html);
        el('admBackupNow').addEventListener('click', function () {
          var b = el('admBackupNow');
          b.disabled = true;
          b.textContent = '备份中…';
          api('/api/backup', { method: 'POST' })
            .then(function () { toast('备份已生成'); showBackup(); })
            .catch(function (err) { toast('备份失败：' + err.message); b.disabled = false; b.textContent = '立即备份'; });
        });
        el('admDownloadAll').addEventListener('click', downloadAll);
        el('admRestoreFile').addEventListener('change', function (e) { restoreFrom(e.target.files && e.target.files[0]); });
      })
      .catch(function (err) { openPanel('数据备份', '<div class="adm-hint">加载失败：' + esc(err.message) + '</div>'); });
  }

  function downloadAll() {
    // 走浏览器直接下载，服务端已设置 Content-Disposition
    window.location.href = '/api/export';
  }

  /**
   * 从导出的 JSON 恢复整套账。
   *
   * 以前只有导出没有导入，那份备份实际上只能看不能用——真出事时唯一的路子
   * 是手工拼 SQL。这里补上入口，但流程刻意做成两步：
   * 先预演（服务端只解析不写库，返回逐模块的「现有条数 → 待恢复条数」），
   * 让人看清将覆盖什么，再输入确认词才真正执行。
   * 服务端在正式恢复前还会自动热备一次现状。
   */
  function restoreFrom(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () { toast('读取文件失败'); };
    reader.onload = function () {
      var payload;
      try {
        payload = JSON.parse(String(reader.result));
      } catch (err) {
        toast('这不是有效的 JSON 文件');
        return;
      }
      toast('正在核对备份内容…');
      api('/api/import', { method: 'POST', body: { payload: payload, dryRun: true } })
        .then(function (preview) {
          var lines = Object.keys(preview.incoming || {}).map(function (k) {
            var name = (window.__FIN_APP__ && window.__FIN_APP__.modules[k] && window.__FIN_APP__.modules[k].name) || k;
            return '　' + name + '：现有 ' + preview.willReplace[k] + ' 条 → 恢复为 ' + preview.incoming[k] + ' 条';
          });
          var msg =
            '这份备份导出于 ' + (preview.exportedAt ? localTime(preview.exportedAt) : '未知时间') + '。\n\n' +
            '恢复会「整库替换」，不是合并——以下数据将被完全覆盖：\n' + lines.join('\n') + '\n' +
            '　受控清单：' + preview.units + ' 个单位 / ' + preview.projects + ' 个项目\n' +
            '　结账记录：' + preview.closures + ' 条\n\n' +
            (preview.errors && preview.errors.length
              ? '注意：有 ' + preview.errors.length + ' 处内容无法解析，例如「' + preview.errors[0] + '」\n\n'
              : '') +
            '服务端会在覆盖前自动备份一次当前数据。\n确认继续请输入：替换全部数据';
          var answer = window.prompt(msg, '');
          if (answer !== '替换全部数据') { toast('已取消恢复'); return; }
          return api('/api/import', { method: 'POST', body: { payload: payload, confirm: '替换全部数据' } }).then(function (out) {
            toast('恢复完成，恢复前的数据已备份为 ' + out.backupBefore + '，即将刷新页面');
            setTimeout(function () { window.location.reload(); }, 1500);
          });
        })
        .catch(function (err) { toast('恢复失败：' + err.message); });
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ================= 旧数据迁移 ================= */

  function localCacheRows(key) {
    try {
      var raw = window.localStorage.getItem('wb_fin_' + key + '_cache');
      var rows = raw ? JSON.parse(raw) : [];
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      return [];
    }
  }

  function stripMeta(row) {
    var out = {};
    Object.keys(row || {}).forEach(function (k) { if (k.charAt(0) !== '_') out[k] = row[k]; });
    return out;
  }

  function showImportLocal() {
    var found = moduleKeys().map(function (k) { return { key: k, rows: localCacheRows(k) }; }).filter(function (x) { return x.rows.length; });
    var html =
      '<div class="adm-hint">把这台电脑浏览器里遗留的离线数据（旧版本存在 localStorage 的台账）上传到服务器。' +
      '导入是「追加」而不是覆盖，已在服务器上的记录不会被删除；重复导入会产生重复行，请只做一次。' +
      '也可以选择本地导出的 JSON 备份文件导入。</div>' +
      '<div class="adm-row">' +
      '<div class="fgroup"><label>从 JSON 备份文件导入到指定模块</label>' +
      '<select id="admImportModule">' + moduleKeys().map(function (k) { return '<option value="' + k + '">' + esc(moduleName(k)) + '</option>'; }).join('') + '</select></div>' +
      '<div class="fgroup"><label>选择文件</label><input id="admImportFile" type="file" accept="application/json,.json"></div>' +
      '<button class="btn" id="admImportFileBtn" type="button">导入文件</button>' +
      '</div>' +
      (found.length
        ? '<table><thead><tr><th>模块</th><th class="num">本机缓存条数</th><th>操作</th></tr></thead><tbody>' +
          found.map(function (x) {
            return '<tr><td>' + esc(moduleName(x.key)) + '</td><td class="num">' + x.rows.length + '</td>' +
              '<td><button class="btn btn-sm" data-imp="' + x.key + '">上传到服务器</button></td></tr>';
          }).join('') +
          '</tbody></table>'
        : '<div class="adm-hint">本机浏览器里没有检测到遗留的离线台账数据。</div>');
    openPanel('导入本机旧数据', html);

    Array.prototype.forEach.call(el('adminBody').querySelectorAll('[data-imp]'), function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-imp');
        var rows = localCacheRows(key).map(stripMeta);
        if (!rows.length) { toast('没有可导入的数据'); return; }
        if (!confirm('把「' + moduleName(key) + '」的 ' + rows.length + ' 条本机数据追加到服务器？')) return;
        b.disabled = true;
        b.textContent = '上传中…';
        api('/api/modules/' + key + '/import', { method: 'POST', body: { rows: rows, replace: false } })
          .then(function (out) {
            var msg = '已导入 ' + out.inserted + ' 条';
            if (out.skipped) msg += '，跳过 ' + out.skipped + ' 条（字段不合法）';
            toast(msg);
            if (out.errors && out.errors.length) console.warn('[import] 跳过明细：', out.errors);
            if (window.__FIN_APP__ && window.__FIN_APP__.reload) window.__FIN_APP__.reload();
          })
          .catch(function (err) { toast('导入失败：' + err.message); })
          .finally(function () { b.disabled = false; b.textContent = '上传到服务器'; });
      });
    });

    el('admImportFileBtn').addEventListener('click', function () {
      var input = el('admImportFile');
      var key = el('admImportModule').value;
      if (!input.files || !input.files[0]) { toast('请先选择 JSON 文件'); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var rows;
        try {
          var parsed = JSON.parse(String(reader.result));
          rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : parsed.modules && parsed.modules[key];
        } catch (e) {
          toast('文件不是合法 JSON');
          return;
        }
        if (!Array.isArray(rows) || !rows.length) { toast('文件里没有找到该模块的记录数组'); return; }
        if (!confirm('把 ' + rows.length + ' 条记录追加到「' + moduleName(key) + '」？')) return;
        api('/api/modules/' + key + '/import', { method: 'POST', body: { rows: rows.map(stripMeta), replace: false } })
          .then(function (out) {
            toast('已导入 ' + out.inserted + ' 条' + (out.skipped ? '，跳过 ' + out.skipped + ' 条' : ''));
            if (out.errors && out.errors.length) console.warn('[import] 跳过明细：', out.errors);
            if (window.__FIN_APP__ && window.__FIN_APP__.reload) window.__FIN_APP__.reload();
          })
          .catch(function (err) { toast('导入失败：' + err.message); });
      };
      reader.readAsText(input.files[0], 'utf-8');
    });
  }

  /* ================= 模块显隐自选 ================= */

  function openModuleVisibility() {
    api('/api/schema')
      .then(function (out) {
        var mods = (out.modules || []).filter(function (m) { return m.databaseId !== '__overview'; });
        var hidden = window.__FIN_HIDDEN_MODS__ || [];
        var rows = mods.map(function (m) {
          var on = hidden.indexOf(m.databaseId) < 0;
          return '<label class="adm-row" style="display:flex;gap:8px;align-items:center;padding:4px 0">' +
            '<input type="checkbox" data-viskey="' + esc(m.databaseId) + '"' + (on ? ' checked' : '') + '> ' +
            esc(m.name) + ' <span style="color:#8a94a6">' + esc(m.databaseId) + '</span></label>';
        }).join('');
        openPanel(
          '模块显示设置',
          '<div class="adm-hint">勾选 = 显示在导航栏。只影响你自己的界面，不影响其他人，也不影响数据。</div>' +
            '<div style="margin:10px 0">' + rows + '</div>' +
            '<div class="adm-hint">总览页始终显示。</div>' +
            '<button class="btn btn-primary" id="btnVisSave" type="button">保存</button>'
        );
        el('btnVisSave').addEventListener('click', function () {
          var hidden = [];
          Array.prototype.forEach.call(document.querySelectorAll('[data-viskey]'), function (cb) {
            if (!cb.checked) hidden.push(cb.getAttribute('data-viskey'));
          });
          api('/api/prefs/modules', { method: 'POST', body: { hidden: hidden } })
            .then(function () {
              window.__FIN_HIDDEN_MODS__ = hidden;
              if (window.__FIN_APP__ && window.__FIN_APP__.applyModuleVisibility) window.__FIN_APP__.applyModuleVisibility();
              toast('显示设置已保存');
              closePanel();
            })
            .catch(function (err) { toast('保存失败：' + err.message); });
        });
      })
      .catch(function (err) { openPanel('模块显示设置', '<div class="adm-hint">加载失败：' + esc(err.message) + '</div>'); });
  }

  /* ================= 界面自定义新建模块 ================= */

  var FIELD_TYPES = [['text', '文字'], ['number', '数字'], ['date', '日期'], ['select', '单选']];

  function newModFieldRow() {
    var typeOpts = FIELD_TYPES.map(function (t) {
      return '<option value="' + t[0] + '">' + t[1] + '</option>';
    }).join('');
    var div = document.createElement('div');
    div.className = 'nm-field-row';
    div.style.cssText = 'display:flex;gap:6px;align-items:center;margin:4px 0';
    div.innerHTML =
      '<input class="nm-fname" placeholder="字段名，如：金额(元)" style="flex:2;min-width:0">' +
      '<select class="nm-ftype" style="flex:1;min-width:0">' + typeOpts + '</select>' +
      '<label style="white-space:nowrap;font-size:12px"><input type="checkbox" class="nm-freq">必填</label>' +
      '<input class="nm-fopts" placeholder="选项,逗号分隔" style="flex:2;min-width:0;display:none">' +
      '<button type="button" class="btn btn-sm nm-fdel">×</button>';
    div.querySelector('.nm-ftype').addEventListener('change', function () {
      div.querySelector('.nm-fopts').style.display = this.value === 'select' ? '' : 'none';
    });
    div.querySelector('.nm-fdel').addEventListener('click', function () { div.remove(); });
    return div;
  }

  function openNewModule() {
    var rows = '';
    for (var i = 0; i < 3; i++) rows += newModFieldRow().outerHTML;
    openPanel(
      '新建模块',
      '<div class="adm-hint">创建后立即出现在导航栏，录入 / 打印 / Excel 导出 / 结账自动可用，无需重启。' +
        '系统会自动带上「单位」（受控清单）与「备注」字段。</div>' +
        '<div style="margin:10px 0"><label>模块名称：<input id="nmName" placeholder="如：资金管理" maxlength="20"></label></div>' +
        '<div style="margin:6px 0"><label><input type="checkbox" id="nmMonthly" checked> 按月记录（每月结转复制名册；不勾则是常设台账）</label></div>' +
        '<div class="adm-hint" style="margin-top:10px">业务字段：</div>' +
        '<div id="nmFields">' + rows + '</div>' +
        '<button class="btn btn-sm" id="nmAddField" type="button" style="margin:6px 0">+ 添加字段</button>' +
        '<div id="nmErr" style="color:#c0392b;margin:6px 0"></div>' +
        '<button class="btn btn-primary" id="nmCreate" type="button">创建模块</button>'
    );
    el('nmAddField').addEventListener('click', function () {
      el('nmFields').appendChild(newModFieldRow());
    });
    el('nmCreate').addEventListener('click', function () {
      var fields = [];
      var err = '';
      Array.prototype.forEach.call(document.querySelectorAll('#nmFields .nm-field-row'), function (row) {
        if (err) return;
        var name = row.querySelector('.nm-fname').value.trim();
        if (!name) return;
        var type = row.querySelector('.nm-ftype').value;
        var f = { name: name, type: type, required: row.querySelector('.nm-freq').checked };
        if (type === 'select') {
          var opts = row.querySelector('.nm-fopts').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
          if (!opts.length) { err = '单选字段「' + name + '」需要至少一个选项'; return; }
          f.options = opts;
        }
        fields.push(f);
      });
      if (err) { el('nmErr').textContent = err; return; }
      if (!fields.length) { el('nmErr').textContent = '请至少填写一个业务字段'; return; }
      el('nmErr').textContent = '';
      api('/api/modules-custom', {
        method: 'POST',
        body: { name: el('nmName').value.trim(), monthly: el('nmMonthly').checked, fields: fields },
      })
        .then(function (out) {
          toast('模块「' + out.module.name + '」已创建');
          closePanel();
          window.location.reload();  // 重载后启动流程会自动注册新模块并补页签
        })
        .catch(function (e2) { el('nmErr').textContent = e2.message; });
    });
  }

  /* ================= 菜单挂载 ================= */

  window.__FIN_MENU__ = {
    audit: showAudit,
    users: showUsers,
    serverBackup: showBackup,
    exportAll: downloadAll,
    importLocal: showImportLocal,
    modvis: openModuleVisibility,
    newmod: openNewModule,
    // 服务器版不再提供随机示例数据，避免把演示数据写进正式账套
    seed: function () {
      toast('服务器版不提供示例数据；如需迁移旧数据，请用「导入本机旧数据」');
    },
  };

  function bind() {
    var close = el('btnAdminClose');
    if (close) close.addEventListener('click', closePanel);
    var mask = el('adminMask');
    if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) closePanel(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
