/**
 * CLI 配置存取
 *
 * 优先级：环境变量 > ~/.chexian/config.json
 * 写文件时强制 chmod 600，避免同机其他用户读到 token。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CxConfig {
  baseUrl: string;
  token?: string;
  tokenId?: string;
}

const DEFAULT_BASE_URL = 'https://chexian.cretvalu.com';

function configDir(): string {
  return path.join(os.homedir(), '.chexian');
}

function configFile(): string {
  return path.join(configDir(), 'config.json');
}

export function loadConfig(): CxConfig {
  const envBase = process.env.CX_BASE_URL;
  const envToken = process.env.CX_PAT;

  let fileCfg: Partial<CxConfig> = {};
  try {
    if (fs.existsSync(configFile())) {
      const raw = fs.readFileSync(configFile(), 'utf-8');
      fileCfg = JSON.parse(raw);
    }
  } catch {
    // 文件损坏忽略，走环境变量或默认
  }

  return {
    baseUrl: envBase || fileCfg.baseUrl || DEFAULT_BASE_URL,
    token: envToken || fileCfg.token,
    tokenId: fileCfg.tokenId,
  };
}

export function saveConfig(cfg: CxConfig): void {
  const dir = configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function clearToken(): void {
  const cfg = loadConfig();
  delete cfg.token;
  delete cfg.tokenId;
  saveConfig(cfg);
}

export function getCachePath(filename: string): string {
  const dir = path.join(configDir(), 'cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, filename);
}
