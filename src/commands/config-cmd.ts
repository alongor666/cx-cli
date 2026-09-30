/**
 * cx config <get|set|unset|list|path>
 *
 * 管理 ~/.chexian/config.json 的本地配置。
 * 可配置项白名单：baseUrl（生产/本地切换）。
 * token 不可经此命令读写（写入走 cx login，清除走 cx logout）。
 */
import kleur from 'kleur';
import {
  loadConfig, loadFileConfig, updateFileConfig, configFilePath, DEFAULT_BASE_URL,
  normalizeBaseUrl, isInsecureBaseUrl,
} from '../config.js';
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

/** 校验并返回规范化后的值（baseUrl：http/https、无凭据/查询串、去尾斜杠） */
export function validateConfigValue(key: EditableKey, value: string): string {
  if (key === 'baseUrl') return normalizeBaseUrl(value);
  return value;
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
    const normalized = validateConfigValue(key, value);
    // 只改文件里的这一个键：绝不回写 loadConfig()（其中含 CX_PAT 等环境变量）
    updateFileConfig({ [key]: normalized });
    console.error(kleur.green(`✔ ${key} = ${normalized}`));
    if (key === 'baseUrl' && isInsecureBaseUrl(normalized)) {
      console.error(kleur.yellow(`⚠ ${normalized} 不是 https：PAT 将以明文在网络上传输`));
    }
    warnEnvOverride(key);
  } catch (err) {
    failUsage(err);
  }
}

export function configUnsetCommand(key: string): void {
  try {
    validateConfigKey(key);
    updateFileConfig({ [key]: undefined });
    console.error(kleur.green(`✔ 已清除 ${key}（恢复默认 ${DEFAULT_BASE_URL}）`));
    warnEnvOverride(key);
  } catch (err) {
    failUsage(err);
  }
}

/** 环境变量优先于文件：写了文件但当前 shell 不会生效时要明说 */
function warnEnvOverride(key: EditableKey): void {
  if (key === 'baseUrl' && process.env.CX_BASE_URL) {
    console.error(kleur.yellow(`⚠ 环境变量 CX_BASE_URL=${process.env.CX_BASE_URL} 优先于配置文件，当前 shell 中本次修改不生效`));
  }
}

export function configListCommand(): void {
  const cfg = loadConfig();
  const file = loadFileConfig();
  const view = {
    baseUrl: cfg.baseUrl,
    baseUrlSource: process.env.CX_BASE_URL ? 'env:CX_BASE_URL' : file.baseUrl ? 'file' : 'default',
    token: cfg.token ? maskToken(cfg.token) : '(未配置，运行 cx login)',
    tokenSource: process.env.CX_PAT ? 'env:CX_PAT' : file.token ? 'file' : 'none',
    tokenId: cfg.tokenId ?? '',
  };
  console.log(JSON.stringify(view, null, 2));
}

export function configPathCommand(): void {
  console.log(configFilePath());
}

export { EXIT };
