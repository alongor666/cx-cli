/**
 * 全局 CLI 状态（--quiet / --verbose）+ NO_COLOR 预处理
 *
 * 本模块必须是 index.ts 的第一个 import：
 * kleur 在模块加载时读取 NO_COLOR 决定是否着色，--no-color 必须在其之前写入 env。
 */
if (process.argv.includes('--no-color')) {
  process.env.NO_COLOR = '1';
}

export const cliState = {
  /** 抑制提示性 stderr 输出（错误仍打印） */
  quiet: false,
  /** stderr 打印请求 URL 与耗时 */
  verbose: false,
};

/** 提示性 stderr 输出（--quiet 时静默；错误请走 failWith） */
export function note(message: string): void {
  if (!cliState.quiet) console.error(message);
}
