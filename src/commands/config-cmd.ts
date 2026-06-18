/**
 * cx config <get|set|unset|list|path>
 *
 * 管理 ~/.chexian/config.json 的本地配置。
 * 可配置项白名单：baseUrl（生产/本地切换）。
 * token 不可经此命令读写（写入走 cx login，清除走 cx logout）。
 */
import kleur from 'kleur';
import { loadConfig, saveConfig, configFilePath, DEFAULT_BASE_URL } from '../config.js';
import { EXIT } from '../exit-codes.js';

/** config 子命令的错误都是用法错误：stderr + exit 4 */
function failUsage(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(kleur.red(`✘ ${msg}`) + '\n');
  process.exit(EXIT.USAGE);
}

const EDITABLE_KEYS = ['baseUrl'] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

export function validateConfigKey(key: string): asserts key is EditableKey {
  if (key === 'token' || key === 'tokenId') {
    throw new Error('token 不可经 cx config 操作：写入用 cx login，清除用 cx logout');
  }
  if (!(EDITABLE_KEYS as readonly string[]).includes(key)) {
    throw new Error(`未知配置项: ${key}（可配置: ${EDITABLE_KEYS.join(', ')}）`);
  }
}

export function validateConfigValue(key: EditableKey, value: string): void {
  if (key === 'baseUrl') {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`baseUrl 必须是合法 URL（http/https），收到: ${value}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`baseUrl 必须是 http/https URL，收到协议: ${parsed.protocol}`);
    }
  }
}

/** token 脱敏：cx_pat_<id8>.<secret> → cx_pat_<id8>.*** */
export function maskToken(token: string): string {
  const m = token.match(/^(cx_pat_[A-Za-z0-9]+)\./);
  return m ? `${m[1]}.***` : '***';
}

export function configGetCommand(key: string): void {
  try {
    validateConfigKey(key);
    const cfg = loadConfig();
    console.log(String(cfg[key] ?? ''));
  } catch (err) {
    failUsage(err);
  }
}

export function configSetCommand(key: string, value: string): void {
  try {
    validateConfigKey(key);
    validateConfigValue(key, value);
    const cfg = loadConfig();
    saveConfig({ ...cfg, [key]: value.replace(/\/+$/, '') });
    console.error(kleur.green(`✔ ${key} = ${value}`));
  } catch (err) {
    failUsage(err);
  }
}

export function configUnsetCommand(key: string): void {
  try {
    validateConfigKey(key);
    const cfg = loadConfig();
    saveConfig({ ...cfg, baseUrl: DEFAULT_BASE_URL });
    console.error(kleur.green(`✔ 已清除 ${key}（恢复默认 ${DEFAULT_BASE_URL}）`));
  } catch (err) {
    failUsage(err);
  }
}

export function configListCommand(): void {
  const cfg = loadConfig();
  const view = {
    baseUrl: cfg.baseUrl,
    token: cfg.token ? maskToken(cfg.token) : '(未配置，运行 cx login)',
    tokenId: cfg.tokenId ?? '',
  };
  console.log(JSON.stringify(view, null, 2));
}

export function configPathCommand(): void {
  console.log(configFilePath());
}

export { EXIT };
