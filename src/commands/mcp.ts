/**
 * cx mcp install | uninstall | status
 *
 * install：先自检（拉起 cx mcp 列工具，顺带验证 PAT 与网络），通过后才写各客户端配置。
 * 客户端配置只含 cx 路径，不含 PAT（见 mcp/clients.ts）。
 */
import kleur from 'kleur';
import { CliUsageError } from '../exit-codes.js';
import {
  defaultAdapters, sameEntry, selfEntry, type ClientAdapter, type McpEntry,
} from '../mcp/clients.js';
import { probeServer } from '../mcp/probe.js';
import { hasPersistedToken } from '../config.js';

export function pickAdapters(all: ClientAdapter[], client?: string): ClientAdapter[] {
  if (!client || client === 'auto') return all;
  const wanted = client.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !all.some((a) => a.id === w));
  if (unknown.length) {
    throw new CliUsageError(`未知客户端: ${unknown.join(', ')}（可选: ${all.map((a) => a.id).join(', ')}）`);
  }
  return all.filter((a) => wanted.includes(a.id));
}

export async function mcpInstallCommand(
  opts: { client?: string; skipCheck?: boolean },
  deps: { adapters?: ClientAdapter[]; entry?: McpEntry; probe?: typeof probeServer } = {},
): Promise<void> {
  const entry = deps.entry ?? selfEntry();
  const explicit = Boolean(opts.client && opts.client !== 'auto');
  const targets = pickAdapters(deps.adapters ?? defaultAdapters(), opts.client);

  if (!opts.skipCheck) {
    process.stderr.write(kleur.gray('自检：按 Agent 运行时条件启动 cx mcp 并列出工具…\n'));
    let tools: string[];
    try {
      ({ tools } = await (deps.probe ?? probeServer)(entry));
    } catch (err) {
      // Agent 进程不继承 shell 的 CX_PAT：令牌只在环境变量里时，写出去的配置在 Agent 里必然无鉴权
      const envOnly = process.env.CX_PAT && !hasPersistedToken();
      throw new Error(envOnly
        ? `${(err as Error).message}\n当前 PAT 只在环境变量 CX_PAT 里，Agent 进程读不到——先运行 cx login 保存到本机配置`
        : (err as Error).message);
    }
    const queryTools = tools.filter((t) => t.startsWith('cx_query_')).length;
    process.stderr.write(kleur.green(`✔ 自检通过：${tools.length} 个工具（其中 cx_query_* ${queryTools} 个）\n`));
  }

  let written = 0;
  for (const adapter of targets) {
    const state = adapter.state();
    if (!state.detected && !explicit) {
      process.stderr.write(kleur.gray(`- ${adapter.label}：未检测到，跳过\n`));
      continue;
    }
    try {
      adapter.install(entry);
      written++;
      process.stderr.write(kleur.green(`✔ ${adapter.label}：已写入 ${state.where}\n`));
    } catch (err) {
      process.stderr.write(kleur.red(`✘ ${adapter.label}：${(err as Error).message}\n`));
    }
  }
  if (written === 0) {
    throw new Error('没有写入任何客户端。用 --client 指定，如 --client cursor,claude-desktop');
  }
  process.stderr.write(kleur.cyan(`完成。重启对应 Agent 后可见 chexian 工具；配置中不含 PAT。\n`));
}

export function mcpUninstallCommand(opts: { client?: string }, adapters = defaultAdapters()): void {
  for (const adapter of pickAdapters(adapters, opts.client)) {
    let removed = false;
    try { removed = adapter.uninstall(); } catch (err) {
      process.stderr.write(kleur.red(`✘ ${adapter.label}：${(err as Error).message}\n`));
      continue;
    }
    process.stderr.write(removed ? kleur.green(`✔ ${adapter.label}：已移除\n`) : kleur.gray(`- ${adapter.label}：无条目\n`));
  }
  process.stderr.write(kleur.gray('PAT 仍保存在本机，如需一并清除运行 cx logout。\n'));
}

export function mcpStatusCommand(adapters = defaultAdapters(), entry = selfEntry()): void {
  process.stdout.write(`当前 cx：${[entry.command, ...entry.args].join(' ')}\n`);
  for (const adapter of adapters) {
    const s = adapter.state();
    const mark = !s.detected ? kleur.gray('未检测到')
      : !s.entry ? kleur.yellow('未配置')
        : sameEntry(s.entry, entry) || s.entry.command === '(已配置)' ? kleur.green('已配置')
          : kleur.yellow(`已配置但指向 ${s.entry.command}（重跑 cx mcp install 更新）`);
    process.stdout.write(`${s.label.padEnd(15)} ${mark}  ${kleur.gray(s.where)}\n`);
  }
}
