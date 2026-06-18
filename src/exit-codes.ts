/**
 * cx 退出码契约（文档见 cli/README.md）
 *
 * 0 成功 · 1 通用/服务端错误 · 2 鉴权失败 · 3 权限不足 · 4 用法错误 · 5 限流
 */
import kleur from 'kleur';
import { CxApiError } from './api.js';

export const EXIT = {
  OK: 0,
  GENERAL: 1,
  AUTH: 2,
  FORBIDDEN: 3,
  USAGE: 4,
  RATE_LIMITED: 5,
} as const;

export function exitCodeForError(err: unknown): number {
  if (err instanceof CxApiError) {
    if (err.status === 401) return EXIT.AUTH;
    if (err.status === 403) return EXIT.FORBIDDEN;
    if (err.status === 429) return EXIT.RATE_LIMITED;
  }
  return EXIT.GENERAL;
}

/** 统一错误出口：stderr 打印可操作信息 + 按契约退出 */
export function failWith(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(kleur.red(`✘ ${msg}`) + '\n');
  process.exit(exitCodeForError(err));
}
