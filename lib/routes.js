/** REST API 路由。所有 /api 路径都在这里分发。 */
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import {
  SESSION_COOKIE,
  ROLES,
  activeAdminCount,
  can,
  clearLoginAttempts,
  createSession,
  createUser,
  findUserByName,
  listUsers,
  loginBlocked,
  passwordProblem,
  recordLoginAttempt,
  revokeSession,
  revokeUserSessions,
  setPassword,
  updateUser,
  verifyPassword,
} from './auth.js';
import { listBackups, runBackup } from './backup.js';
import { businessErrors } from './business.js';
import { CARRY_MODULES, applyCarry, missingEntriesAll, previewCarry } from './carry.js';
import { createCustomModule, removeCustomModule } from './custom_modules.js';
import { HttpError, clientIp, cookieHeader, readJsonBody, sameOriginOk, sendAttachment, sendJson } from './http.js';
import {
  addProject,
  addUnit,
  listProjects,
  listUnits,
  renameProject,
  renameUnit,
  seedFromRecords,
  updateProject,
  updateUnit,
  validateMasterData,
} from './masterdata.js';
import { MODULE_KEYS, MODULES, normalizeProperties, resolveModule, schemaOf } from './schema.js';
import {
  ConflictError,
  LockedError,
  NotFoundError,
  SETTING_KEYS,
  ValidationError,
  assertPeriod,
  audit,
  countRecords,
  createRecord,
  currentWorkPeriod,
  deleteModuleRecords,
  deleteRecord,
  exportAll,
  getRecord,
  getPref,
  getSetting,
  countMatching,
  importAll,
  importRecords,
  isClosed,
  listAudit,
  listClosures,
  listRecords,
  masterDataStrict,
  PREF_KEYS,
  moduleSummaries,
  setClosed,
  setPref,
  setSetting,
  setViewPeriod,
  updateRecord,
  viewPeriodOf,
} from './store.js';

function requireAuth(ctx) {
  if (!ctx.session) throw new HttpError(401, '未登录或会话已过期', 'unauthenticated');
  return ctx.session.user;
}

/**
 * 首登强制改口令：以前这只是前端的一个弹窗，服务端毫无约束——
 * 实测未改口令的账号可以直接写台账、甚至调 /api/export 把整套账拉走。
 * 初始口令是打印在控制台/写在部署脚本里的，暴露面比设计意图大得多。
 * 这里在服务端兜住：mustChange 未清除时，除改口令与查看自身信息外一律拒绝。
 */
function requirePasswordChanged(ctx) {
  const user = requireAuth(ctx);
  if (user.mustChange) {
    throw new HttpError(403, '请先修改初始口令后再继续操作', 'must_change_password');
  }
  return user;
}

function requireCap(ctx, capability, message) {
  const user = requirePasswordChanged(ctx);
  if (!can(user.role, capability)) throw new HttpError(403, message || '当前账号没有该操作权限', 'forbidden');
  return user;
}

function requireModule(idOrKey) {
  const mod = resolveModule(idOrKey);
  if (!mod) throw new HttpError(404, `未知模块：${idOrKey}`, 'unknown_module');
  return mod;
}

/** 写操作前的结账锁校验：记录所属期间已结账则拒绝 */
function guardClosure(mod, period) {
  const p = period || currentWorkPeriod();
  if (isClosed(mod.key, p)) {
    throw new LockedError(`「${mod.name}」${p} 已结账为只读，请先重开该期间再修改。`);
  }
}

function periodFromProps(mod, properties, fallbackRecord) {
  if (!mod.periodField) return currentWorkPeriod();
  const raw = properties?.[mod.periodField];
  const value = raw && typeof raw === 'object' ? raw.date ?? raw.text : raw;
  const s = String(value || fallbackRecord?.[mod.periodField] || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : currentWorkPeriod();
}

function actorOf(ctx) {
  return ctx.session ? ctx.session.user.username : '';
}

/**
 * 写入前校验受控清单：单位与项目名称必须已在清单里。
 * 这一层不是形式主义——名称错一个字就会把计提链条打断，
 * 上期基数丢失后本期计提金额会静默翻倍，事后极难发现。
 */
function guardMasterData(mod, properties, existing) {
  if (!masterDataStrict()) return;
  const { data } = normalizeProperties(mod, properties, { partial: true });
  const merged = {
    单位: data['单位'] ?? existing?.['单位'] ?? '',
    项目名称: data['项目名称'] ?? existing?.['项目名称'] ?? '',
  };
  // 只有实际提交了这两个字段时才校验，避免改备注也被拦
  const touched =
    Object.prototype.hasOwnProperty.call(data, '单位') || Object.prototype.hasOwnProperty.call(data, '项目名称');
  if (!touched && existing) return;
  const errors = validateMasterData(mod, merged, { require: true });
  if (errors.length) throw new ValidationError(errors.join('；'));
}

function mePayload(ctx) {
  const u = ctx.session.user;
  const caps = ROLES[u.role] || ROLES.viewer;
  return {
    user: { username: u.username, displayName: u.displayName, role: u.role, roleLabel: caps.label, mustChange: u.mustChange },
    can: { write: caps.canWrite, close: caps.canClose, admin: caps.canAdmin },
    modules: MODULE_KEYS.map((k) => ({
      key: k,
      name: MODULES[k].name,
      entity: MODULES[k].entity,
      legacyDbId: MODULES[k].legacyDbId,
      periodField: MODULES[k].periodField,
      sortField: MODULES[k].sortField,
    })),
    /*
     * 两个期间，语义完全不同，前端要分别用：
     *   workPeriod —— 全局账套期间。结账锁与结转的权威基准，全账套一个值，
     *                 只有能结账的角色可以推进。界面上应显示为「账套期间」。
     *   viewPeriod —— 我自己想看哪个月。只影响本账号的筛选默认值与新增预填，
     *                 谁都可以改自己的，改了不影响任何其他人。
     * 没设过 viewPeriod 时它等于 workPeriod，所以新用户看到的就是账套当前月份。
     */
    workPeriod: currentWorkPeriod(),
    viewPeriod: viewPeriodOf(u.id),
    hiddenModules: getPref(u.id, PREF_KEYS.hiddenModules, []),
    closures: listClosures(),
    orgName: getSetting(SETTING_KEYS.orgName, config.orgName || ''),
    printProfiles: getSetting(SETTING_KEYS.printProfiles, {}) || {},
    masterDataStrict: masterDataStrict(),
    units: listUnits(),
    projects: listProjects(),
    carryModules: Object.keys(CARRY_MODULES),
    serverTime: new Date().toISOString(),
  };
}

export async function handleApi(ctx) {
  const { req, res, method, path } = ctx;

  // 写方法必须同源（配合 SameSite=Strict Cookie 防 CSRF）
  if (method !== 'GET' && method !== 'HEAD' && !sameOriginOk(req)) {
    throw new HttpError(403, '跨站请求被拒绝', 'cross_origin');
  }

  /* ---------- 会话 ---------- */

  if (path === '/api/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const ip = clientIp(req);
    if (!username || !password) throw new HttpError(400, '请输入账号与口令');
    /*
     * 限流按三个维度分别计数，因为单一维度都能被绕开：
     *   用户名@IP —— 原来只有这一个。换个用户名就重置计数，
     *                所以对同一台机器上的账号枚举完全无效；
     *                而且 trustProxy 打开时 X-Forwarded-For 是可伪造的，
     *                每次换一个假 IP 就能无限重试。
     *   ip:<IP>   —— 挡住「同一来源换着用户名试」的枚举。
     *   user:<账号> —— 挡住「换 IP 试同一个账号」的分布式撞库，
     *                 这也是伪造 XFF 唯一挡不住的那条路。
     * 阈值给用户名维度放宽一倍：正常人自己输错口令不该因为同事也在输错而被连坐。
     */
    const subjects = [`${username}@${ip}`, `ip:${ip}`, `user:${username}`];
    const limits = [config.loginMaxAttempts, config.loginMaxAttempts * 2, config.loginMaxAttempts * 2];
    for (let i = 0; i < subjects.length; i += 1) {
      if (loginBlocked(subjects[i], limits[i])) {
        audit({ actor: username, ip, action: 'login.blocked', detail: `触发限流：${subjects[i]}` });
        throw new HttpError(429, `登录失败次数过多，请 ${config.loginWindowMinutes} 分钟后再试`);
      }
    }
    const user = findUserByName(username);
    const ok = !!user && !user.disabled && verifyPassword(password, user.pwd_salt, user.pwd_hash);
    for (const s of subjects) recordLoginAttempt(s, ok);
    if (!ok) {
      audit({ actor: username, ip, action: 'login.fail' });
      throw new HttpError(401, '账号或口令不正确');
    }
    for (const s of subjects) clearLoginAttempts(s);
    const { token, expiresAt } = createSession(user.id, { ip, agent: req.headers['user-agent'] || '' });
    audit({ actor: user.username, ip, action: 'login.ok' });
    ctx.session = {
      token,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        mustChange: !!user.must_change,
      },
    };
    sendJson(res, 200, { ok: true, ...mePayload(ctx) }, {
      'Set-Cookie': cookieHeader(SESSION_COOKIE, token, { maxAgeSeconds: config.sessionHours * 3600 }),
    });
    return;
  }

  if (path === '/api/logout' && method === 'POST') {
    if (ctx.session) {
      revokeSession(ctx.session.token);
      audit({ actor: actorOf(ctx), ip: clientIp(req), action: 'logout' });
    }
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(SESSION_COOKIE, '', { maxAgeSeconds: 0 }) });
    return;
  }

  if (path === '/api/me' && method === 'GET') {
    if (!ctx.session) {
      sendJson(res, 200, { authenticated: false });
      return;
    }
    sendJson(res, 200, { authenticated: true, ...mePayload(ctx) });
    return;
  }

  if (path === '/api/password' && method === 'POST') {
    const user = requireAuth(ctx);
    const body = await readJsonBody(req);
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');
    const row = findUserByName(user.username);
    if (!row || !verifyPassword(current, row.pwd_salt, row.pwd_hash)) throw new HttpError(400, '当前口令不正确');
    const bad = passwordProblem(next);
    if (bad) throw new HttpError(400, bad);
    if (next === current) throw new HttpError(400, '新口令不能与当前口令相同');
    setPassword(row.id, next, { mustChange: 0 });
    revokeUserSessions(row.id);
    audit({ actor: user.username, ip: clientIp(req), action: 'password.change' });
    sendJson(res, 200, { ok: true, message: '口令已修改，请重新登录' }, {
      'Set-Cookie': cookieHeader(SESSION_COOKIE, '', { maxAgeSeconds: 0 }),
    });
    return;
  }

  /* ---------- 元数据 ---------- */

  if (path === '/api/schema' && method === 'GET') {
    requireAuth(ctx);
    sendJson(res, 200, { modules: MODULE_KEYS.map((k) => schemaOf(MODULES[k])) });
    return;
  }

  const schemaMatch = path.match(/^\/api\/modules\/([^/]+)\/schema$/);
  if (schemaMatch && method === 'GET') {
    requireAuth(ctx);
    sendJson(res, 200, schemaOf(requireModule(decodeURIComponent(schemaMatch[1]))));
    return;
  }

  /* ---------- 记录 ---------- */

  const recordsMatch = path.match(/^\/api\/modules\/([^/]+)\/records$/);
  if (recordsMatch) {
    const mod = requireModule(decodeURIComponent(recordsMatch[1]));

    if (method === 'GET') {
      const user = requireAuth(ctx);
      const filter = {
        period: ctx.url.searchParams.get('period') || '',
        unit: ctx.url.searchParams.get('unit') || '',
      };
      const limit = ctx.url.searchParams.get('limit') || config.maxRowsPerModule;
      const rows = listRecords(mod, { ...filter, limit });
      /*
       * total 是「符合条件的真实总数」，不是「这次返回了几条」。
       *
       * 原来这里写 total: rows.length，也就是截断后的长度——
       * 于是前端永远看到 total === results.length，无法察觉数据被截断。
       * 而截断砍掉的是最新期间（排序是 period ASC），链式计提少了最后一段
       * 照样能算出一个自洽但错误的金额。truncated 让前端可以直接拒绝计算。
       */
      const total = countMatching(mod, filter);
      sendJson(res, 200, {
        results: rows,
        total,
        returned: rows.length,
        truncated: rows.length < total,
        module: mod.key,
        workPeriod: currentWorkPeriod(),
        viewPeriod: viewPeriodOf(user.id),
      });
      return;
    }

    if (method === 'POST') {
      const user = requireCap(ctx, 'canWrite', '只读账号不能新增记录');
      const body = await readJsonBody(req);
      const properties = body.properties || body;
      const period = periodFromProps(mod, properties, null);
      guardClosure(mod, period);
      guardMasterData(mod, properties, null);
      const { record, unknown } = createRecord(mod, properties, user.username);
      audit({
        actor: user.username,
        ip: clientIp(req),
        action: 'record.create',
        module: mod.key,
        recId: record._id,
        detail: JSON.stringify(properties),
      });
      sendJson(res, 201, { ok: true, record, ignoredFields: unknown });
      return;
    }

    if (method === 'DELETE') {
      const user = requireCap(ctx, 'canWrite', '只读账号不能清空数据');
      const period = ctx.url.searchParams.get('period') || '';
      if (period) {
        assertPeriod(period);
        guardClosure(mod, period);
      } else if (listClosures().some((c) => c.module === mod.key)) {
        throw new LockedError(`「${mod.name}」存在已结账期间，无法整模块清空；请先重开相关期间或按期间清空。`);
      }
      const n = deleteModuleRecords(mod, { period });
      audit({
        actor: user.username,
        ip: clientIp(req),
        action: 'record.clear',
        module: mod.key,
        detail: `清空 ${n} 条${period ? `（期间 ${period}）` : '（全部期间）'}`,
      });
      sendJson(res, 200, { ok: true, deleted: n });
      return;
    }
  }

  const recordMatch = path.match(/^\/api\/modules\/([^/]+)\/records\/([^/]+)$/);
  if (recordMatch) {
    const mod = requireModule(decodeURIComponent(recordMatch[1]));
    const id = decodeURIComponent(recordMatch[2]);

    if (method === 'PATCH' || method === 'PUT') {
      const user = requireCap(ctx, 'canWrite', '只读账号不能修改记录');
      const body = await readJsonBody(req);
      const properties = body.properties || body;
      const before = getRecord(mod, id);
      if (!before) throw new NotFoundError('记录不存在或已被其他人删除');
      // 写入前就校验：原期间与目标期间都不能是已结账期间
      const prevPeriod = recordPeriod(mod, before);
      const nextPeriod = periodFromProps(mod, properties, before);
      for (const p of new Set([prevPeriod, nextPeriod].filter(Boolean))) guardClosure(mod, p);
      guardMasterData(mod, properties, before);
      // 乐观锁：前端把读到的 _rev 回传，版本不一致就 409，避免静默覆盖别人的修改。
      // 不传 rev 视为放弃校验（兼容老前端与脚本），传了就必须对得上。
      const expectedRev = body.rev ?? body._rev ?? properties?._rev ?? null;
      const { record, unknown } = updateRecord(mod, id, properties, user.username, { expectedRev });
      audit({
        actor: user.username,
        ip: clientIp(req),
        action: 'record.update',
        module: mod.key,
        recId: id,
        detail: JSON.stringify({ before: stripMeta(before), after: stripMeta(record) }),
      });
      sendJson(res, 200, { ok: true, record, ignoredFields: unknown });
      return;
    }

    if (method === 'DELETE') {
      const user = requireCap(ctx, 'canWrite', '只读账号不能删除记录');
      const target = getRecord(mod, id);
      if (!target) throw new NotFoundError('记录不存在或已被其他人删除');
      guardClosure(mod, recordPeriod(mod, target));
      deleteRecord(mod, id);
      audit({
        actor: user.username,
        ip: clientIp(req),
        action: 'record.delete',
        module: mod.key,
        recId: id,
        detail: JSON.stringify(stripMeta(target)),
      });
      sendJson(res, 200, { ok: true, deleted: id });
      return;
    }

    if (method === 'GET') {
      requireAuth(ctx);
      const found = getRecord(mod, id);
      if (!found) throw new NotFoundError('记录不存在');
      sendJson(res, 200, { record: found });
      return;
    }
  }

  const importMatch = path.match(/^\/api\/modules\/([^/]+)\/import$/);
  if (importMatch && method === 'POST') {
    const user = requireCap(ctx, 'canWrite', '只读账号不能导入数据');
    const mod = requireModule(decodeURIComponent(importMatch[1]));
    const body = await readJsonBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const replace = !!body.replace;
    if (replace && listClosures().some((c) => c.module === mod.key)) {
      throw new LockedError(`「${mod.name}」存在已结账期间，不能整模块覆盖导入。`);
    }
    // 导入的每一行也要落在未结账期间内，并且名称必须在受控清单里。
    // 例外：管理员做历史数据迁移时可以带 allowNewNames，先把数据搬进来，
    // 再用 /api/master/seed 把出现过的名称一次性归集成清单（这一步会写审计）。
    // 同一个通道也跳过业务校验：历史脏数据里可能本就有负数/倒挂，
    // 迁移不该被拦死，进来之后走「数据体检」（/api/master/seed）与人工核对。
    const bypass = !!body.allowNewNames && can(user.role, 'canAdmin');
    const strict = masterDataStrict() && !bypass;
    const out = importRecords(mod, rows, user.username, {
      replace,
      businessCheck: !bypass,
      validateRow: (data) => {
        const errs = [];
        const p = periodFromProps(mod, data, null);
        if (isClosed(mod.key, p)) errs.push(`期间 ${p} 已结账，不能导入`);
        if (strict) errs.push(...validateMasterData(mod, data, { require: true }));
        return errs;
      },
    });
    audit({
      actor: user.username,
      ip: clientIp(req),
      action: 'record.import',
      module: mod.key,
      detail: `导入 ${out.inserted} 条，跳过 ${out.skipped} 条，replace=${replace}${bypass ? '，跳过受控清单与业务校验' : ''}`,
    });
    sendJson(res, 200, { ok: true, ...out, bypassedMasterData: bypass, bypassedBusiness: bypass });
    return;
  }

  /* 粘贴导入的预检：只校验不写库，让用户先看清哪一行有问题 */
  const dryRunMatch = path.match(/^\/api\/modules\/([^/]+)\/import\/check$/);
  if (dryRunMatch && method === 'POST') {
    requireCap(ctx, 'canWrite', '只读账号不能导入数据');
    const mod = requireModule(decodeURIComponent(dryRunMatch[1]));
    const body = await readJsonBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const strict = masterDataStrict();
    const results = rows.map((raw, i) => {
      const { data, errors, unknown } = normalizeProperties(mod, raw, { partial: false });
      const all = errors.slice();
      if (!all.length) {
        const p = periodFromProps(mod, data, null);
        if (isClosed(mod.key, p)) all.push(`期间 ${p} 已结账，不能导入`);
        if (strict) all.push(...validateMasterData(mod, data, { require: true }));
        // 预检与正式导入同一套业务规则，避免「预检全绿、导入被拒」的体验断层
        all.push(...businessErrors(mod, data, { touched: new Set(Object.keys(data)) }));
      }
      return { index: i, ok: all.length === 0, errors: all, ignoredFields: unknown, data };
    });
    sendJson(res, 200, {
      ok: true,
      total: results.length,
      valid: results.filter((r) => r.ok).length,
      rows: results,
    });
    return;
  }

  /* ---------- 单位 / 项目 受控清单 ---------- */

  if (path === '/api/master/units' && method === 'GET') {
    requireAuth(ctx);
    const includeInactive = ctx.url.searchParams.get('all') === '1';
    sendJson(res, 200, { units: listUnits({ includeInactive }), strict: masterDataStrict() });
    return;
  }

  if (path === '/api/master/units' && method === 'POST') {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可维护单位清单');
    const body = await readJsonBody(req);
    const out = addUnit(body, user.username);
    audit({ actor: user.username, ip: clientIp(req), action: 'master.unit.add', detail: out.name });
    sendJson(res, 201, { ok: true, ...out, units: listUnits() });
    return;
  }

  const unitMatch = path.match(/^\/api\/master\/units\/([^/]+)$/);
  if (unitMatch && (method === 'PATCH' || method === 'DELETE')) {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可维护单位清单');
    const name = decodeURIComponent(unitMatch[1]);
    if (method === 'DELETE') {
      updateUnit(name, { active: false }, user.username);
      audit({ actor: user.username, ip: clientIp(req), action: 'master.unit.disable', detail: name });
      sendJson(res, 200, { ok: true, units: listUnits() });
      return;
    }
    const body = await readJsonBody(req);
    if (body.newName) {
      const out = renameUnit(name, body.newName, user.username);
      audit({
        actor: user.username,
        ip: clientIp(req),
        action: 'master.unit.rename',
        detail: `${out.from} → ${out.to}，连带更新 ${out.records} 条台账`,
      });
      sendJson(res, 200, { ok: true, ...out, units: listUnits(), projects: listProjects() });
      return;
    }
    const updated = updateUnit(name, body, user.username);
    audit({ actor: user.username, ip: clientIp(req), action: 'master.unit.update', detail: name });
    sendJson(res, 200, { ok: true, unit: updated, units: listUnits() });
    return;
  }

  if (path === '/api/master/projects' && method === 'GET') {
    requireAuth(ctx);
    sendJson(res, 200, {
      projects: listProjects({
        unit: ctx.url.searchParams.get('unit') || '',
        includeInactive: ctx.url.searchParams.get('all') === '1',
      }),
    });
    return;
  }

  if (path === '/api/master/projects' && method === 'POST') {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可维护项目清单');
    const body = await readJsonBody(req);
    const out = addProject(body, user.username);
    audit({ actor: user.username, ip: clientIp(req), action: 'master.project.add', detail: `${out.unit}/${out.name}` });
    sendJson(res, 201, { ok: true, ...out, projects: listProjects() });
    return;
  }

  const projectMatch = path.match(/^\/api\/master\/projects\/(\d+)$/);
  if (projectMatch && (method === 'PATCH' || method === 'DELETE')) {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可维护项目清单');
    const id = Number(projectMatch[1]);
    if (method === 'DELETE') {
      updateProject(id, { active: false });
      audit({ actor: user.username, ip: clientIp(req), action: 'master.project.disable', detail: String(id) });
      sendJson(res, 200, { ok: true, projects: listProjects() });
      return;
    }
    const body = await readJsonBody(req);
    if (body.newName) {
      const out = renameProject(id, body.newName, user.username);
      audit({
        actor: user.username,
        ip: clientIp(req),
        action: 'master.project.rename',
        detail: `${out.unit}：${out.from} → ${out.to}，连带更新 ${out.records} 条台账`,
      });
      sendJson(res, 200, { ok: true, ...out, projects: listProjects() });
      return;
    }
    const updated = updateProject(id, body);
    audit({ actor: user.username, ip: clientIp(req), action: 'master.project.update', detail: String(id) });
    sendJson(res, 200, { ok: true, project: updated, projects: listProjects() });
    return;
  }

  if (path === '/api/master/seed' && method === 'POST') {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可归集清单');
    const out = seedFromRecords(user.username);
    audit({
      actor: user.username,
      ip: clientIp(req),
      action: 'master.seed',
      detail: `新增单位 ${out.addedUnits}、项目 ${out.addedProjects}`,
    });
    sendJson(res, 200, { ok: true, ...out, units: listUnits(), projects: listProjects() });
    return;
  }

  if (path === '/api/master/strict' && method === 'POST') {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可修改受控清单开关');
    const body = await readJsonBody(req);
    const on = !!body.strict;
    setSetting(SETTING_KEYS.masterDataStrict, on, user.username);
    audit({ actor: user.username, ip: clientIp(req), action: 'master.strict', detail: on ? '开启' : '关闭' });
    sendJson(res, 200, { ok: true, strict: masterDataStrict() });
    return;
  }

  /* ---------- 本月结转 ---------- */

  const carryMatch = path.match(/^\/api\/carry\/([^/]+)$/);
  if (carryMatch) {
    const modKey = decodeURIComponent(carryMatch[1]);
    const mod = requireModule(modKey);

    if (method === 'GET') {
      requireAuth(ctx);
      const to = ctx.url.searchParams.get('to') || currentWorkPeriod();
      const from = ctx.url.searchParams.get('from') || '';
      /* 与 POST 同一口径：预览也只对真实存在的年月给出结果，
         否则 2026-13 这种值会预览出一批落不进库的「幽灵名册」 */
      assertPeriod(to);
      if (from) assertPeriod(from);
      sendJson(res, 200, previewCarry(mod.key, to, { fromPeriod: from }));
      return;
    }

    if (method === 'POST') {
      const user = requireCap(ctx, 'canWrite', '只读账号不能结转');
      const body = await readJsonBody(req);
      const to = String(body.to || currentWorkPeriod());
      assertPeriod(to);
      guardClosure(mod, to);
      const out = applyCarry(mod.key, to, body.values || {}, user.username, { fromPeriod: body.from || '' });
      audit({
        actor: user.username,
        ip: clientIp(req),
        action: 'record.carry',
        module: mod.key,
        detail: `${out.from} → ${out.to}，新增 ${out.inserted} 条，跳过 ${out.skipped} 条`,
      });
      sendJson(res, 200, { ok: true, ...out });
      return;
    }
  }

  /* ---------- 期间与结账 ---------- */

  /*
   * 期间是两层的，两个接口分工明确：
   *
   *   /api/view-period  个人视图期间。「我想看哪个月」是个人选择，
   *                     只读账号也能改自己的，改了不影响任何其他人。
   *
   *   /api/period       全局账套期间。它决定无期间字段模块（设施摊销、
   *                     固定资产折旧、减值准备）的记录归属哪一期，从而决定
   *                     结账锁住哪些数据，也决定结转的默认目标期间。
   *                     推进它等于宣布「这套账进入下个月」，属于结账动作的一部分，
   *                     所以要 canClose 权限（管理员/记账员）。
   *
   * 以前只有一个 /api/period 且只校验登录，于是只读账号可以把全公司的
   * 当前期间改掉——这既是权限漏洞，也让「看自己的月份」这个正常需求
   * 不得不去动全局状态。分成两层之后两个问题一起解决。
   */

  if (path === '/api/period' && method === 'GET') {
    const user = requireAuth(ctx);
    sendJson(res, 200, {
      workPeriod: currentWorkPeriod(),
      viewPeriod: viewPeriodOf(user.id),
      closures: listClosures(),
    });
    return;
  }

  if (path === '/api/period' && method === 'POST') {
    const user = requireCap(ctx, 'canClose', '只读账号不能推进账套期间；如果只想切换查看的月份，请改「查看期间」');
    const body = await readJsonBody(req);
    const period = assertPeriod(body.period);
    const before = currentWorkPeriod();
    setSetting(SETTING_KEYS.workPeriod, period, user.username);
    audit({
      actor: user.username,
      ip: clientIp(req),
      action: 'period.set',
      detail: `账套期间 ${before} → ${period}`,
    });
    sendJson(res, 200, {
      ok: true,
      workPeriod: period,
      viewPeriod: viewPeriodOf(user.id),
      closures: listClosures(),
    });
    return;
  }

  if (path === '/api/view-period' && method === 'POST') {
    // 个人偏好，任何已登录账号都能改自己的；不写审计——这不是业务动作，
    // 每次翻月份都记一条只会把审计表冲淡。
    const user = requirePasswordChanged(ctx);
    const body = await readJsonBody(req);
    const period = setViewPeriod(user.id, body.period);
    sendJson(res, 200, { ok: true, viewPeriod: period, workPeriod: currentWorkPeriod() });
    return;
  }

  if (path === '/api/view-period' && method === 'DELETE') {
    // 取消个人选择，回到跟随账套期间
    const user = requirePasswordChanged(ctx);
    setPref(user.id, PREF_KEYS.viewPeriod, null);
    sendJson(res, 200, { ok: true, viewPeriod: currentWorkPeriod(), workPeriod: currentWorkPeriod() });
    return;
  }

  if (path === '/api/closures' && method === 'GET') {
    requireAuth(ctx);
    sendJson(res, 200, { closures: listClosures() });
    return;
  }

  if (path === '/api/closures' && method === 'POST') {
    const user = requireCap(ctx, 'canClose', '只读账号不能结账或重开');
    const body = await readJsonBody(req);
    const mod = requireModule(body.module);
    const period = assertPeriod(body.period);
    const on = !!body.closed;
    const closures = setClosed(mod.key, period, on, user.username, body.note || '');
    audit({
      actor: user.username,
      ip: clientIp(req),
      action: on ? 'period.close' : 'period.reopen',
      module: mod.key,
      detail: period,
    });
    sendJson(res, 200, { ok: true, closures });
    return;
  }

  /* ---------- 共享设置 ---------- */

  if (path === '/api/settings' && method === 'GET') {
    requireAuth(ctx);
    sendJson(res, 200, {
      orgName: getSetting(SETTING_KEYS.orgName, config.orgName || ''),
      printProfiles: getSetting(SETTING_KEYS.printProfiles, {}) || {},
      workPeriod: currentWorkPeriod(),
      masterDataStrict: masterDataStrict(),
    });
    return;
  }

  if (path === '/api/settings' && method === 'POST') {
    const user = requireCap(ctx, 'canWrite', '只读账号不能修改共享设置');
    const body = await readJsonBody(req);
    if (body.orgName !== undefined) setSetting(SETTING_KEYS.orgName, String(body.orgName || '').slice(0, 120), user.username);
    if (body.printProfiles !== undefined) {
      if (!body.printProfiles || typeof body.printProfiles !== 'object') throw new HttpError(400, 'printProfiles 必须是对象');
      setSetting(SETTING_KEYS.printProfiles, body.printProfiles, user.username);
    }
    audit({ actor: user.username, ip: clientIp(req), action: 'settings.update', detail: Object.keys(body).join(',') });
    sendJson(res, 200, {
      ok: true,
      orgName: getSetting(SETTING_KEYS.orgName, ''),
      printProfiles: getSetting(SETTING_KEYS.printProfiles, {}) || {},
    });
    return;
  }

  /* ---------- 概览：一次取回所有模块，供总览页使用 ---------- */

  /*
   * 总览页数据。
   *
   * 默认只返回各模块的汇总数字（条数、涉及单位数、最近期间分布、最后更新时间），
   * 响应体固定几百字节。以前这里是把 6 个模块的全部明细一次性返回，300 条数据
   * 就有 98.8 KB，且随数据量线性增长——在 1 Mbps 的现场，光这一个请求就要 0.8 秒，
   * 而页面上真正显示的只是每个模块的几个合计数。
   *
   * 明细仍然可以要（?detail=1），因为各模块的计提金额口径复杂（按启用日期、
   * 残值率、上期累计逐条推算），目前只有前端有这套算法。总览页改为：
   * 先拿汇总把框架画出来，用户点进某个模块时才拉那个模块的明细。
   */
  if (path === '/api/overview' && method === 'GET') {
    const user = requireAuth(ctx);
    const base = {
      workPeriod: currentWorkPeriod(),
      viewPeriod: viewPeriodOf(user.id),
      closures: listClosures(),
      summaries: moduleSummaries(),
    };
    if (ctx.url.searchParams.get('detail') === '1') {
      const modules = {};
      for (const key of MODULE_KEYS) {
        modules[key] = listRecords(MODULES[key], { limit: config.maxRowsPerModule });
      }
      base.modules = modules;
    }
    /*
     * 漏录提醒：上期有、本期还没录的名册条目。
     * 少计提在账面上每一条都是对的，只有拿总数对账才会发现，
     * 所以必须主动摆到总览页上，而不是等人去查。
     */
    base.missing = missingEntriesAll(base.workPeriod);
    sendJson(res, 200, base);
    return;
  }

  /* ---------- 审计 ---------- */

  if (path === '/api/audit' && method === 'GET') {
    requireAuth(ctx);
    const rows = listAudit({
      module: ctx.url.searchParams.get('module') || '',
      /* ?recId=xxx 追一条记录的完整修改历史，按时间正序返回 */
      recId: ctx.url.searchParams.get('recId') || '',
      limit: ctx.url.searchParams.get('limit') || 200,
      offset: ctx.url.searchParams.get('offset') || 0,
    });
    sendJson(res, 200, { rows });
    return;
  }

  /* ---------- 备份与全量导出（管理员） ---------- */

  if (path === '/api/export' && method === 'GET') {
    requireCap(ctx, 'canAdmin', '仅管理员可导出整套账数据');
    const payload = exportAll();
    audit({ actor: actorOf(ctx), ip: clientIp(req), action: 'data.export' });
    sendAttachment(res, `财务管理台备份-${new Date().toISOString().slice(0, 10)}.json`, payload);
    return;
  }

  /*
   * 从备份 JSON 恢复整套账。
   *
   * 项目原来只有 /api/export 没有任何导入入口——那份备份实际上只能看不能用，
   * 真出事时唯一的恢复路径是手工拼 SQL。备份的价值等于恢复能力。
   *
   * 三重闸门，因为这是全项目破坏性最大的操作：
   *   1. 必须管理员；
   *   2. 必须先带 dryRun 看清将覆盖多少条（响应给出逐模块的现有条数 vs 待入条数）；
   *   3. 正式执行要显式带 confirm:'替换全部数据'，避免误点。
   * 执行前自动做一次热备份，给「恢复错了」留退路。
   */
  if (path === '/api/import' && method === 'POST') {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可恢复备份');
    const body = await readJsonBody(req);
    const payload = body.payload ?? body.data ?? body;
    const dryRun = body.dryRun !== false && body.confirm !== '替换全部数据';
    if (dryRun) {
      const preview = importAll(payload, user.username, { dryRun: true });
      sendJson(res, 200, {
        ...preview,
        hint: '这是预演结果，未写入任何数据。确认无误后再带 confirm:"替换全部数据" 重新提交。',
      });
      return;
    }
    const backupFile = await runBackup();   // 恢复前先留一份现状，给「恢复错了」留退路
    const out = importAll(payload, user.username);
    audit({
      actor: user.username,
      ip: clientIp(req),
      action: 'data.import',
      detail: `恢复备份（导出于 ${out.exportedAt || '未知时间'}），恢复前已备份至 ${backupFile}`,
    });
    sendJson(res, 200, { ...out, backupBefore: backupFile });
    return;
  }

  if (path === '/api/backup' && method === 'GET') {
    requireCap(ctx, 'canAdmin', '仅管理员可查看备份');
    sendJson(res, 200, { backups: listBackups() });
    return;
  }

  if (path === '/api/backup' && method === 'POST') {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可触发备份');
    const file = await runBackup();
    audit({ actor: user.username, ip: clientIp(req), action: 'data.backup', detail: file });
    sendJson(res, 200, { ok: true, file, backups: listBackups() });
    return;
  }

  /* ---------- 模块显隐自选（个人偏好，只影响自己） ---------- */

  if (path === '/api/prefs/modules' && method === 'POST') {
    const user = requirePasswordChanged(ctx);
    const body = await readJsonBody(req);
    const hidden = Array.isArray(body.hidden) ? body.hidden.map(String).filter((k) => MODULE_KEYS.includes(k)) : [];
    if (new Set(hidden).size !== hidden.length) throw new HttpError(400, 'hidden 列表有重复项');
    setPref(user.id, PREF_KEYS.hiddenModules, hidden);
    sendJson(res, 200, { ok: true, hidden });
    return;
  }

  /* ---------- 界面自定义模块（管理员创建，立即生效，无需重启） ---------- */

  if (path === '/api/modules-custom' && method === 'POST') {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可新建模块');
    const body = await readJsonBody(req);
    let def;
    try {
      def = createCustomModule(body, user.username);
    } catch (err) {
      // 定义不合法（重名/字段超限/选项缺失等）是调用方的问题，回 400 而不是 500
      throw new HttpError(400, err.message);
    }
    audit({
      actor: user.username,
      ip: clientIp(req),
      action: 'module.custom.create',
      detail: `${def.name}（${def.fields.length} 字段，${def.monthly ? '按月记录' : '常设台账'}）`,
    });
    sendJson(res, 201, { ok: true, module: def });
    return;
  }

  const customDelMatch = path.match(/^\/api\/modules-custom\/([^/]+)$/);
  if (customDelMatch && method === 'DELETE') {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可删除自定义模块');
    const key = decodeURIComponent(customDelMatch[1]);
    removeCustomModule(key, user.username);
    audit({ actor: user.username, ip: clientIp(req), action: 'module.custom.delete', detail: key });
    sendJson(res, 200, { ok: true });
    return;
  }

  /* ---------- 用户管理（管理员） ---------- */

  if (path === '/api/users' && method === 'GET') {
    requireCap(ctx, 'canAdmin', '仅管理员可管理账号');
    sendJson(res, 200, { users: listUsers(), roles: Object.entries(ROLES).map(([k, v]) => ({ key: k, label: v.label })) });
    return;
  }

  if (path === '/api/users' && method === 'POST') {
    const user = requireCap(ctx, 'canAdmin', '仅管理员可新增账号');
    const body = await readJsonBody(req);
    const password = String(body.password || '') || `${randomBytes(4).toString('hex')}Aa1`;
    if (findUserByName(body.username)) throw new HttpError(409, '该用户名已存在');
    const created = createUser({
      username: body.username,
      password,
      displayName: body.displayName,
      role: body.role || 'accountant',
      mustChange: 1,
    });
    audit({ actor: user.username, ip: clientIp(req), action: 'user.create', detail: `${created.username}/${created.role}` });
    sendJson(res, 201, {
      ok: true,
      user: { username: created.username, role: created.role, displayName: created.display_name },
      initialPassword: body.password ? undefined : password,
    });
    return;
  }

  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && (method === 'PATCH' || method === 'DELETE')) {
    const admin = requireCap(ctx, 'canAdmin', '仅管理员可管理账号');
    const target = findUserByName(decodeURIComponent(userMatch[1]));
    if (!target) throw new NotFoundError('用户不存在');

    if (method === 'DELETE') {
      if (target.username === admin.username) throw new HttpError(400, '不能停用自己的账号');
      // updateUser 内部还会拦「最后一个管理员」，这里只拦「停用自己」
      updateUser(target.id, { disabled: true });
      audit({ actor: admin.username, ip: clientIp(req), action: 'user.disable', detail: target.username });
      sendJson(res, 200, { ok: true });
      return;
    }

    const body = await readJsonBody(req);
    if (body.password !== undefined) {
      setPassword(target.id, String(body.password), { mustChange: 1 });
      revokeUserSessions(target.id);
      audit({ actor: admin.username, ip: clientIp(req), action: 'user.reset_password', detail: target.username });
    }
    /*
     * 自我降级防护：DELETE 分支早就拦了「停用自己」，但 PATCH 改 role 没拦，
     * 于是唯一的管理员可以把自己改成 viewer——此后 /api/users 全部 403，
     * 再也改不回来，只能停服跑 CLI（而 reset-password 只能改口令不能改角色）。
     * updateUser 里有「最后一个管理员」的兜底，这里额外给一条更直白的提示。
     */
    if (target.username === admin.username && body.role !== undefined && !can(String(body.role), 'canAdmin')) {
      if (activeAdminCount() <= 1) {
        throw new HttpError(400, '你是当前唯一的管理员，不能把自己降级；请先另设一名管理员');
      }
    }
    const next = updateUser(target.id, {
      displayName: body.displayName,
      role: body.role,
      disabled: body.disabled,
    });
    audit({ actor: admin.username, ip: clientIp(req), action: 'user.update', detail: `${next.username}/${next.role}` });
    sendJson(res, 200, { ok: true, user: { username: next.username, role: next.role, disabled: !!next.disabled } });
    return;
  }

  /*
   * 健康检查。无需登录（探针要用），因此默认不返回任何业务数据——
   * 以前它会列出每个模块的记录数，端口一旦误暴露，匿名访问者就能推断账套规模。
   * 需要看条数有两条路：带管理员会话访问 ?detail=1，或显式设 FIN_HEALTH_DETAIL=1。
   */
  if (path === '/api/health' && method === 'GET') {
    const wantDetail = ctx.url.searchParams.get('detail') === '1';
    const allowed = config.healthDetail || (ctx.session && can(ctx.session.user.role, 'canAdmin'));
    const payload = { ok: true, time: new Date().toISOString() };
    if (wantDetail && allowed) {
      const counts = {};
      for (const key of MODULE_KEYS) counts[key] = countRecords(MODULES[key]);
      payload.records = counts;
    }
    sendJson(res, 200, payload);
    return;
  }

  throw new HttpError(404, `未知接口：${method} ${path}`, 'unknown_route');
}

function stripMeta(rec) {
  if (!rec) return rec;
  const out = {};
  for (const [k, v] of Object.entries(rec)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

/** 记录归属的会计期间：无期间字段的模块按当前处理期间对待 */
function recordPeriod(mod, rec) {
  if (!mod.periodField) return currentWorkPeriod();
  const s = String(rec?.[mod.periodField] || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : '';
}

export { ValidationError, NotFoundError, LockedError, ConflictError };
