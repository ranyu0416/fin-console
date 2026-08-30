/**
 * 运行配置：环境变量优先，其次 config.json，最后内置默认值。
 * 所有路径都解析为绝对路径，避免受启动时工作目录影响。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(HERE, '..');
export const PROJECT_ROOT = resolve(SERVER_ROOT, '..');

function readJsonFile(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[config] 无法解析 ${file}：${err.message}，已忽略该文件`);
    return {};
  }
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function abs(value, fallback) {
  const p = value && String(value).trim() ? String(value).trim() : fallback;
  return isAbsolute(p) ? p : resolve(SERVER_ROOT, p);
}

const fileCfg = readJsonFile(join(SERVER_ROOT, 'config.json'));
const env = process.env;

function pick(envKey, fileKey) {
  return env[envKey] !== undefined && env[envKey] !== '' ? env[envKey] : fileCfg[fileKey];
}

export const config = {
  /** 监听地址。默认只听回环，需要局域网访问时显式设为 0.0.0.0。 */
  host: pick('FIN_HOST', 'host') || '127.0.0.1',
  port: int(pick('FIN_PORT', 'port'), 8787),

  /** 数据目录：db 文件、备份、日志都在这里 */
  dataDir: abs(pick('FIN_DATA_DIR', 'dataDir'), join(SERVER_ROOT, 'data')),
  /** 前端静态目录（由 npm run build 生成） */
  publicDir: abs(pick('FIN_PUBLIC_DIR', 'publicDir'), join(SERVER_ROOT, 'public')),

  /** 单位名称，用于打印表头的默认「编制单位」 */
  orgName: pick('FIN_ORG_NAME', 'orgName') || '',

  /** 首次启动时创建的管理员账号 */
  bootstrapAdminUser: pick('FIN_ADMIN_USER', 'adminUser') || 'admin',
  bootstrapAdminPassword: pick('FIN_ADMIN_PASSWORD', 'adminPassword') || '',

  /** 会话有效期（小时）与空闲滑动续期 */
  sessionHours: int(pick('FIN_SESSION_HOURS', 'sessionHours'), 12),
  /** 生产环境走 HTTPS 时置为 true，Cookie 会带 Secure */
  cookieSecure: bool(pick('FIN_COOKIE_SECURE', 'cookieSecure'), false),
  /** 部署在 nginx/caddy 之后时置为 true，用 X-Forwarded-For 记录来访 IP */
  trustProxy: bool(pick('FIN_TRUST_PROXY', 'trustProxy'), false),

  /** 登录失败锁定：同一账号/IP 在窗口内失败达到上限后暂时拒绝 */
  loginMaxAttempts: int(pick('FIN_LOGIN_MAX_ATTEMPTS', 'loginMaxAttempts'), 8),
  loginWindowMinutes: int(pick('FIN_LOGIN_WINDOW_MINUTES', 'loginWindowMinutes'), 15),

  /** 自动备份：间隔小时数（0 表示关闭）与保留份数 */
  backupIntervalHours: int(pick('FIN_BACKUP_INTERVAL_HOURS', 'backupIntervalHours'), 24),
  backupKeep: int(pick('FIN_BACKUP_KEEP', 'backupKeep'), 30),

  /** 请求体上限（字节），默认 4MB，足够整册台账导入 */
  maxBodyBytes: int(pick('FIN_MAX_BODY_BYTES', 'maxBodyBytes'), 4 * 1024 * 1024),

  /** 单模块单次返回记录上限，防止异常数据把浏览器拖死 */
  maxRowsPerModule: int(pick('FIN_MAX_ROWS', 'maxRowsPerModule'), 20000),

  /**
   * gzip 压缩。默认开启：现场带宽常见只有 1 Mbps，压缩后前端首屏从 2.6 秒降到 0.7 秒，
   * 台账 JSON 的压缩比能到 20 倍。服务端 CPU 本来就闲着（单请求处理只要 2~3 ms）。
   * 若前面已有 nginx 做压缩，可设 FIN_COMPRESS=0 避免重复压。
   */
  compress: bool(pick('FIN_COMPRESS', 'compress'), true),

  /**
   * /api/health 是否返回各模块记录数。默认关闭：该接口无需登录（给探针用），
   * 端口一旦误暴露，匿名访问者就能推断账套规模。需要详细信息时用 /api/health?detail=1
   * 并带管理员会话，或显式打开这个开关。
   */
  healthDetail: bool(pick('FIN_HEALTH_DETAIL', 'healthDetail'), false),
};

export const paths = {
  dbFile: join(config.dataDir, 'fin.db'),
  backupDir: join(config.dataDir, 'backups'),
};
