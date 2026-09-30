/**
 * CLI 配置存取
 *
 * 两个视图，严禁混用：
 *   - loadConfig()      生效配置 = 环境变量 > ~/.chexian/config.json > 默认值（只读，用于发请求）
 *   - updateFileConfig  只改文件里的键 —— 绝不能把 loadConfig() 的结果回写，
 *                       否则 CX_PAT / CX_BASE_URL 环境变量会被静默持久化到磁盘。
 *
 * 写文件：临时文件 + rename 原子替换，并显式 chmod 600
 * （writeFileSync 的 mode 只在新建文件时生效，已存在的 644 文件不会被收紧）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CxConfig {
  baseUrl: string;
  token?: string;
  tokenId?: string;
}

export const DEFAULT_BASE_URL = 'https://chexian.cretvalu.com';

function configDir(): string {
  return path.join(os.homedir(), '.chexian');
}

function configFile(): string {
  return path.join(configDir(), 'config.json');
}

/** 配置文件绝对路径（cx config path 用） */
export function configFilePath(): string {
  return configFile();
}

/** cx_pat_<id>.<secret> → <id>；格式不符返回 undefined */
export function deriveTokenId(token: string): string | undefined {
  return token.match(/^cx_pat_([A-Za-z0-9]+)\./)?.[1];
}

/**
 * 校验并规范化 baseUrl：必须是 http(s)，不带凭据/查询串/锚点，去掉末尾斜杠。
 * 非法时抛错（错误文案可直接展示给用户）。
 */
export function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`baseUrl 必须是合法 URL（http/https），收到: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`baseUrl 必须是 http/https URL，收到协议: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('baseUrl 不能内嵌用户名/密码');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('baseUrl 不能带查询串或 # 锚点');
  }
  return parsed.href.replace(/\/+$/, '');
}

/** http:// 且非本机回环地址 —— PAT 将以明文在网络上传输 */
export function isInsecureBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:') return false;
    return !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** 只读文件中的配置（不含环境变量覆盖）。文件缺失/损坏返回 {}。 */
export function loadFileConfig(): Partial<CxConfig> {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<CxConfig>) : {};
  } catch {
    return {};
  }
}

export function loadConfig(): CxConfig {
  const envBase = process.env.CX_BASE_URL;
  const envToken = process.env.CX_PAT;
  const fileCfg = loadFileConfig();

  // token 来自环境变量时，tokenId 必须随之派生（避免显示文件里另一个 token 的 id）
  return {
    baseUrl: (envBase || fileCfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    token: envToken || fileCfg.token,
    tokenId: envToken ? deriveTokenId(envToken) : fileCfg.tokenId,
  };
}

/** ~/.chexian/config.json 里是否持久化了 PAT（不看环境变量；Agent 进程只能读到这一份） */
export function hasPersistedToken(): boolean {
  const token = loadFileConfig().token;
  return typeof token === 'string' && token.startsWith('cx_pat_');
}

/**
 * 只修改文件配置中的指定键：patch 中值为 undefined 的键会被删除。
 * 返回写入后的文件配置。
 */
export function updateFileConfig(patch: Partial<CxConfig>): Partial<CxConfig> {
  const next: Record<string, unknown> = { ...loadFileConfig() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  writeFileAtomic(configFile(), JSON.stringify(next, null, 2) + '\n');
  return next as Partial<CxConfig>;
}

export function clearToken(): void {
  updateFileConfig({ token: undefined, tokenId: undefined });
}

export function getCachePath(filename: string): string {
  const dir = path.join(configDir(), 'cache');
  ensurePrivateDir(dir);
  return path.join(dir, filename);
}

/** 临时文件 + rename 原子写，最终文件权限强制 600 */
export function writeFileAtomic(file: string, content: string | Buffer): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能未创建 */ }
    throw err;
  }
}

function ensurePrivateDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
