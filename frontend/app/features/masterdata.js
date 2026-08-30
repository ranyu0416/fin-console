/**
 * 单位 / 项目受控清单维护面板（仅管理员）。
 *
 * 这份清单是整个系统的身份基准。专项费用按「单位|项目名称」串联各期记录，
 * 工会经费按「单位」串联。名称一旦出现写法漂移（多个空格、全角括号、简写），
 * 链条就断成两条，上期累计基数丢失，本期产值＝全部开累额，计提金额静默翻倍。
 *
 * 所以这里只允许两种改名方式：
 *   - 改名（rename）：连带改写所有历史台账，链条保持完整。
 *   - 停用（disable）：不再出现在录入下拉框里，历史数据原样保留。
 * 「新建一个正确的名字」不是改名——那会把历史留在旧名下。
 */
import { $, toast } from '../core/dom.js';
import { finApi, reloadMaster } from '../core/env.js';
import { esc } from '../core/text.js';

function panel(html) {
  $('#adminTitle').textContent = '单位 / 项目清单';
  $('#adminBody').innerHTML = html;
  $('#adminMask').className = 'mask open';
}

let state = { units: [], projects: [], strict: true, tab: 'unit' };

export function openMasterData() {
  panel('<div class="adm-hint">加载中…</div>');
  Promise.all([finApi('/api/master/units?all=1'), finApi('/api/master/projects?all=1')])
    .then(function (out) {
      state.units = out[0].units || [];
      state.strict = out[0].strict !== false;
      state.projects = out[1].projects || [];
      render();
    })
    .catch(function (err) {
      panel('<div class="adm-hint">加载失败：' + esc(err.message) + '</div>');
    });
}

function refresh() {
  return Promise.all([finApi('/api/master/units?all=1'), finApi('/api/master/projects?all=1')])
    .then(function (out) {
      state.units = out[0].units || [];
      state.strict = out[0].strict !== false;
      state.projects = out[1].projects || [];
      render();
      // 让录入界面的下拉框立刻用上新清单
      return reloadMaster();
    });
}

function render() {
  panel(
    '<div class="adm-toolbar">' +
      '<button class="btn btn-sm' + (state.tab === 'unit' ? ' btn-primary' : '') + '" id="mdTabUnit" type="button">单位（' + state.units.length + '）</button>' +
      '<button class="btn btn-sm' + (state.tab === 'proj' ? ' btn-primary' : '') + '" id="mdTabProj" type="button">项目（' + state.projects.length + '）</button>' +
      '<span class="spacer" style="flex:1"></span>' +
      '<label title="关掉之后录入界面允许自由输入名称，写法漂移不再被拦住，仅供迁移期临时使用">' +
      '<input type="checkbox" id="mdStrict"' + (state.strict ? ' checked' : '') + '> 强制从清单选择' +
      '</label>' +
      '<button class="btn btn-sm" id="mdSeed" type="button">从既有台账归集</button>' +
      '</div>' +
      (state.tab === 'unit' ? unitTab() : projectTab()),
  );

  $('#mdTabUnit').addEventListener('click', function () { state.tab = 'unit'; render(); });
  $('#mdTabProj').addEventListener('click', function () { state.tab = 'proj'; render(); });
  $('#mdStrict').addEventListener('change', function () {
    const on = this.checked;
    finApi('/api/master/strict', { method: 'POST', body: { strict: on } })
      .then(function () {
        toast(on ? '已开启：录入只能从清单选择' : '已关闭：录入允许自由输入（注意写法漂移风险）');
        return refresh();
      })
      .catch(function (err) { toast(err.message); render(); });
  });
  $('#mdSeed').addEventListener('click', doSeed);

  if (state.tab === 'unit') bindUnitTab();
  else bindProjectTab();
}

/* ---------------- 单位 ---------------- */

function unitTab() {
  return (
    '<div class="adm-row">' +
    '<div class="fgroup"><label>单位名称</label><input id="mdUnitInput" type="text" placeholder="如：一分公司"></div>' +
    '<div class="fgroup"><label>排序号</label><input id="mdUnitSort" type="text" inputmode="numeric" placeholder="0"></div>' +
    '<button class="btn btn-primary btn-sm" id="mdUnitAdd" type="button">添加</button>' +
    '</div>' +
    (state.units.length
      ? '<div class="adm-scroll"><table><thead><tr><th>单位名称</th><th>排序</th><th>状态</th><th>备注</th><th>操作</th></tr></thead><tbody>' +
        state.units.map(function (u) {
          return '<tr>' +
            '<td><strong>' + esc(u.name) + '</strong></td>' +
            '<td>' + (u.sort || 0) + '</td>' +
            '<td>' + (u.active ? '<span class="pill use">在用</span>' : '<span class="pill gone">已停用</span>') + '</td>' +
            '<td class="detail">' + esc(u.note || '') + '</td>' +
            '<td>' +
            '<button class="btn btn-sm" data-unit-rename="' + esc(u.name) + '" type="button">改名</button> ' +
            (u.active
              ? '<button class="btn btn-sm" data-unit-off="' + esc(u.name) + '" type="button">停用</button>'
              : '<button class="btn btn-sm" data-unit-on="' + esc(u.name) + '" type="button">启用</button>') +
            '</td></tr>';
        }).join('') +
        '</tbody></table></div>'
      : '<div class="adm-hint">清单还是空的。可以逐个添加，也可以点「从既有台账归集」把已经录过的名称一次性收进来。</div>') +
    '<div class="adm-hint">改名会连带改写所有历史台账里的这个名称，计提链条保持完整——不要用「新建正确名称」代替改名。' +
    '停用只是不再出现在录入下拉框里，历史数据原样保留。</div>'
  );
}

function bindUnitTab() {
  $('#mdUnitAdd').addEventListener('click', function () {
    const name = $('#mdUnitInput').value.trim();
    const sort = $('#mdUnitSort').value.trim();
    if (!name) { toast('请输入单位名称'); return; }
    finApi('/api/master/units', { method: 'POST', body: { name: name, sort: sort ? Number(sort) : 0 } })
      .then(function (out) {
        toast(out.reactivated ? '已重新启用「' + out.name + '」' : '已添加「' + out.name + '」');
        return refresh();
      })
      .catch(function (err) { toast(err.message); });
  });

  each('[data-unit-rename]', function (btn) {
    btn.addEventListener('click', function () {
      const from = btn.getAttribute('data-unit-rename');
      const to = prompt('把「' + from + '」改成什么名字？\n所有历史台账里的这个名称会一并改写。', from);
      if (!to || to === from) return;
      finApi('/api/master/units/' + encodeURIComponent(from), { method: 'PATCH', body: { newName: to } })
        .then(function (out) {
          toast('已改名，连带更新 ' + out.records + ' 条台账');
          return refresh();
        })
        .catch(function (err) { toast(err.message); });
    });
  });

  each('[data-unit-off]', function (btn) {
    btn.addEventListener('click', function () {
      const name = btn.getAttribute('data-unit-off');
      if (!confirm('停用「' + name + '」？停用后录入界面不再出现这个单位，历史数据保留。')) return;
      finApi('/api/master/units/' + encodeURIComponent(name), { method: 'DELETE' })
        .then(function () { toast('已停用'); return refresh(); })
        .catch(function (err) { toast(err.message); });
    });
  });

  each('[data-unit-on]', function (btn) {
    btn.addEventListener('click', function () {
      const name = btn.getAttribute('data-unit-on');
      finApi('/api/master/units/' + encodeURIComponent(name), { method: 'PATCH', body: { active: true } })
        .then(function () { toast('已启用'); return refresh(); })
        .catch(function (err) { toast(err.message); });
    });
  });
}

/* ---------------- 项目 ---------------- */

function projectTab() {
  const activeUnits = state.units.filter(function (u) { return u.active; });
  return (
    '<div class="adm-row">' +
    '<div class="fgroup"><label>所属单位</label><select id="mdProjUnit">' +
    (activeUnits.length
      ? activeUnits.map(function (u) { return '<option value="' + esc(u.name) + '">' + esc(u.name) + '</option>'; }).join('')
      : '<option value="">请先添加单位</option>') +
    '</select></div>' +
    '<div class="fgroup"><label>项目名称</label><input id="mdProjInput" type="text" placeholder="如：示例项目A"></div>' +
    '<div class="fgroup"><label>计提比例（%）</label><input id="mdProjRate" type="text" inputmode="decimal" placeholder="选填，如 3"></div>' +
    '<button class="btn btn-primary btn-sm" id="mdProjAdd" type="button">添加</button>' +
    '</div>' +
    (state.projects.length
      ? '<div class="adm-scroll"><table><thead><tr><th>单位</th><th>项目名称</th><th class="num">计提比例</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        state.projects.map(function (p) {
          return '<tr>' +
            '<td>' + esc(p.unit) + '</td>' +
            '<td><strong>' + esc(p.name) + '</strong></td>' +
            '<td class="num">' + (p.rate == null ? '—' : p.rate + '%') + '</td>' +
            '<td>' + (p.active ? '<span class="pill use">在用</span>' : '<span class="pill gone">已停用</span>') + '</td>' +
            '<td>' +
            '<button class="btn btn-sm" data-proj-rename="' + p.id + '" type="button">改名</button> ' +
            '<button class="btn btn-sm" data-proj-rate="' + p.id + '" type="button">改比例</button> ' +
            (p.active
              ? '<button class="btn btn-sm" data-proj-off="' + p.id + '" type="button">停用</button>'
              : '<button class="btn btn-sm" data-proj-on="' + p.id + '" type="button">启用</button>') +
            '</td></tr>';
        }).join('') +
        '</tbody></table></div>'
      : '<div class="adm-hint">还没有项目。登记了计提比例的项目，在录入界面选中后会自动填上比例。</div>') +
    '<div class="adm-hint">项目完工后请「停用」而不是删除：停用后不再进入本月结转的名册，但历史台账与开累数据完整保留。</div>'
  );
}

function bindProjectTab() {
  $('#mdProjAdd').addEventListener('click', function () {
    const unit = $('#mdProjUnit').value;
    const name = $('#mdProjInput').value.trim();
    const rate = $('#mdProjRate').value.trim();
    if (!unit) { toast('请先添加单位'); return; }
    if (!name) { toast('请输入项目名称'); return; }
    finApi('/api/master/projects', { method: 'POST', body: { unit: unit, name: name, rate: rate === '' ? null : rate } })
      .then(function (out) {
        toast(out.reactivated ? '已重新启用「' + out.name + '」' : '已添加「' + out.name + '」');
        return refresh();
      })
      .catch(function (err) { toast(err.message); });
  });

  each('[data-proj-rename]', function (btn) {
    btn.addEventListener('click', function () {
      const id = btn.getAttribute('data-proj-rename');
      const p = state.projects.filter(function (x) { return String(x.id) === id; })[0];
      if (!p) return;
      const to = prompt('把「' + p.name + '」改成什么名字？\n专项费用台账里的这个项目名会一并改写。', p.name);
      if (!to || to === p.name) return;
      finApi('/api/master/projects/' + id, { method: 'PATCH', body: { newName: to } })
        .then(function (out) { toast('已改名，连带更新 ' + out.records + ' 条台账'); return refresh(); })
        .catch(function (err) { toast(err.message); });
    });
  });

  each('[data-proj-rate]', function (btn) {
    btn.addEventListener('click', function () {
      const id = btn.getAttribute('data-proj-rate');
      const p = state.projects.filter(function (x) { return String(x.id) === id; })[0];
      if (!p) return;
      const v = prompt('「' + p.name + '」的计提比例（%）。留空表示不预设。', p.rate == null ? '' : String(p.rate));
      if (v === null) return;
      finApi('/api/master/projects/' + id, { method: 'PATCH', body: { rate: v.trim() === '' ? null : v.trim() } })
        .then(function () { toast('已更新比例'); return refresh(); })
        .catch(function (err) { toast(err.message); });
    });
  });

  each('[data-proj-off]', function (btn) {
    btn.addEventListener('click', function () {
      const id = btn.getAttribute('data-proj-off');
      if (!confirm('停用这个项目？停用后不再进入本月结转名册，历史数据保留。')) return;
      finApi('/api/master/projects/' + id, { method: 'DELETE' })
        .then(function () { toast('已停用'); return refresh(); })
        .catch(function (err) { toast(err.message); });
    });
  });

  each('[data-proj-on]', function (btn) {
    btn.addEventListener('click', function () {
      const id = btn.getAttribute('data-proj-on');
      finApi('/api/master/projects/' + id, { method: 'PATCH', body: { active: true } })
        .then(function () { toast('已启用'); return refresh(); })
        .catch(function (err) { toast(err.message); });
    });
  });
}

/* ---------------- 从既有台账归集 ---------------- */

function doSeed() {
  if (!confirm('扫描所有台账里出现过的单位与项目名称，把还不在清单里的补进来？\n同名会归并，已有条目不会被改动。')) return;
  finApi('/api/master/seed', { method: 'POST', body: {} })
    .then(function (out) {
      let msg = '已归集：新增单位 ' + out.addedUnits + ' 个、项目 ' + out.addedProjects + ' 个';
      if (out.drift && out.drift.length) {
        msg += '。注意有 ' + out.drift.length + ' 个名称存在写法差异，已归并为同一个，请核对台账';
        console.warn('[masterdata] 写法漂移：', out.drift);
      }
      toast(msg);
      return refresh();
    })
    .catch(function (err) { toast(err.message); });
}

function each(sel, fn) {
  Array.prototype.forEach.call($('#adminBody').querySelectorAll(sel), fn);
}
