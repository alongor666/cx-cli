/**
 * 各 Agent 客户端的 MCP 配置写入（cx mcp install / uninstall / status）
 *
 * 写入的条目只有 `{ command: <cx 绝对路径>, args: ["mcp"] }`——PAT 由 cx mcp 自己从
 * cx login 的配置读，**任何客户端配置里都不出现令牌**。
 *
 * - Claude Code / Codex：调它们自带的 `mcp add/remove`（它们的配置文件会被运行中的进程并发改写，
 *   不直接动文件）；未装 CLI 即视为未检测到。
 * - Cursor / Claude Desktop / ZCode：合并 JSON，写前备份 `<文件>.cx-bak`，原子替换，
 *   解析失败时拒绝写入（绝不覆盖用户配置）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactPat } from './probe.js';

export const SERVER_NAME = 'chexian';

export interface McpEntry {
  command: string;
  args: string[];
}

export interface ClientState {
  id: string;
  label: string;
  detected: boolean;
  /** 已写入的条目（未写入为 null） */
  entry: McpEntry | null;
  where: string;
}

export interface ClientAdapter {
  id: string;
  label: string;
  state(): ClientState;
  install(entry: McpEntry): void;
  uninstall(): boolean;
}

/** 当前 cx 的启动命令：编译二进制时就是 execPath；bun/node 跑源码时带上脚本路径 */
export function selfEntry(execPath = process.execPath, script = process.argv[1]): McpEntry {
  const base = (execPath.split(/[\\/]/).pop() ?? '').toLowerCase(); // 兼容 Windows 反斜杠路径
  if (/^(bun|node)(\.exe)?$/.test(base) && script) {
    return { command: execPath, args: [path.resolve(script), 'mcp'] };
  }
  return { command: execPath, args: ['mcp'] };
}

export function sameEntry(a: McpEntry | null, b: McpEntry): boolean {
  return !!a && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args);
}

// ── JSON 文件型客户端 ─────────────────────────────────────────────

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json;
  } catch { /* fallthrough */ }
  throw new Error(`${file} 不是合法 JSON 对象，已跳过（未改动）。请手工修复后重试`);
}

function writeJsonAtomic(linkOrFile: string, data: Json): void {
  // 配置常被 dotfiles 软链管理：rename 到链接路径会把链接替换成普通文件（真实目标静默分叉），
  // 所以先解析到真实目标再原子替换
  const file = fs.existsSync(linkOrFile) ? fs.realpathSync(linkOrFile) : linkOrFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode: number | undefined;
  if (fs.existsSync(file)) {
    mode = fs.statSync(file).mode & 0o777;
    // 只在首次写入前备份：.cx-bak = cx 第一次改动前的原始配置（不是「上一版」），重复 install 不覆盖它
    const bak = `${file}.cx-bak`;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  }
  const tmp = `${file}.cx-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: mode ?? 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** keyPath 指向 servers 映射所在位置，如 ['mcpServers'] 或 ['mcp', 'servers'] */
export function jsonAdapter(opts: {
  id: string; label: string; file: string; detectDir: string; keyPath: string[];
}): ClientAdapter {
  const servers = (doc: Json, create: boolean): Json | null => {
    let node: Json = doc;
    for (const key of opts.keyPath) {
      const next = node[key];
      if (next && typeof next === 'object' && !Array.isArray(next)) node = next as Json;
      else if (create) { node[key] = {}; node = node[key] as Json; }
      else return null;
    }
    return node;
  };
  const toEntry = (v: unknown): McpEntry | null => {
    const e = v as Partial<McpEntry> | undefined;
    return e && typeof e.command === 'string' ? { command: e.command, args: Array.isArray(e.args) ? e.args : [] } : null;
  };
  return {
    id: opts.id,
    label: opts.label,
    state() {
      const detected = fs.existsSync(opts.detectDir);
      let entry: McpEntry | null = null;
      try { entry = toEntry(servers(readJson(opts.file), false)?.[SERVER_NAME]); } catch { /* 坏文件按未配置显示 */ }
      return { id: opts.id, label: opts.label, detected, entry, where: opts.file };
    },
    install(entry) {
      const doc = readJson(opts.file);
      servers(doc, true)![SERVER_NAME] = { command: entry.command, args: entry.args };
      writeJsonAtomic(opts.file, doc);
    },
    uninstall() {
      if (!fs.existsSync(opts.file)) return false;
      const doc = readJson(opts.file);
      const node = servers(doc, false);
      if (!node || !(SERVER_NAME in node)) return false;
      delete node[SERVER_NAME];
      writeJsonAtomic(opts.file, doc);
      return true;
    },
  };
}

// ── 自带 mcp 子命令的客户端 ───────────────────────────────────────

export type Runner = (cmd: string, args: string[]) => { ok: boolean; stdout: string };

// Windows 上 claude / codex 多为 npm 的 .cmd 垫片，必须经 shell（Node 禁止无 shell 直接 spawn .cmd）；
// shell 模式不转义参数：含空白或 cmd 元字符的参数整体加双引号（引号内 & | < > ^ ( ) 不再被 cmd 解释），
// 内部双引号按 cmd 规则写成 ""。残余：引号内的 %VAR% 仍会被展开——参数只来自 cx 自身路径，非远程输入。
export const winQuote = (a: string) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

const defaultRunner: Runner = (cmd, args) => {
  const win = process.platform === 'win32';
  const r = spawnSync(cmd, win ? args.map(winQuote) : args, { encoding: 'utf8', shell: win, timeout: 60_000 });
  return { ok: r.status === 0, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

export function cliAdapter(opts: {
  id: string; label: string; bin: string;
  addArgs: (e: McpEntry) => string[]; removeArgs: string[]; getArgs: string[];
  /** 从 `<bin> mcp get` 输出里判断条目；拿不到精确命令时返回 null */
  parseEntry?: (out: string) => McpEntry | null;
  run?: Runner;
}): ClientAdapter {
  const run = opts.run ?? defaultRunner;
  const detected = () => run(opts.bin, ['--version']).ok;
  return {
    id: opts.id,
    label: opts.label,
    state() {
      if (!detected()) return { id: opts.id, label: opts.label, detected: false, entry: null, where: `${opts.bin} (未找到)` };
      const got = run(opts.bin, opts.getArgs);
      const entry = got.ok ? (opts.parseEntry?.(got.stdout) ?? { command: '(已配置)', args: [] }) : null;
      return { id: opts.id, label: opts.label, detected: true, entry, where: `${opts.bin} mcp` };
    },
    install(entry) {
      // 先删后加：重复执行幂等，也能把旧路径更新成新路径。add 失败时把原条目加回去，
      // 不让一次失败的升级把用户原有的 chexian 配置删掉
      const got = run(opts.bin, opts.getArgs);
      const previous = got.ok ? opts.parseEntry?.(got.stdout) ?? null : null;
      run(opts.bin, opts.removeArgs);
      const r = run(opts.bin, opts.addArgs(entry));
      if (r.ok) return;
      const restored = previous ? run(opts.bin, opts.addArgs(previous)).ok : false;
      const tail = previous
        ? (restored ? '；已恢复原条目' : '；⚠ 原条目恢复失败，请重跑 cx mcp install')
        : '';
      throw new Error(`${opts.bin} mcp add 失败：${redactPat(r.stdout.trim()).slice(0, 300)}${tail}`);
    },
    uninstall() {
      return run(opts.bin, opts.removeArgs).ok;
    },
  };
}

/** 从 `claude mcp get` / `codex mcp get` 的文本输出中抽 command/args（尽力而为） */
export function parseGetOutput(out: string): McpEntry | null {
  const cmd = out.match(/^\s*command:\s*(.+?)\s*$/im)?.[1];
  if (!cmd) return null;
  const argsLine = out.match(/^\s*args:\s*(.*?)\s*$/im)?.[1] ?? '';
  return { command: cmd, args: argsLine ? argsLine.split(/\s+/) : [] };
}

export function defaultAdapters(home = os.homedir(), platform = process.platform, env = process.env): ClientAdapter[] {
  const desktopDir = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32'
      ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude')
      : path.join(home, '.config', 'Claude');
  return [
    cliAdapter({
      id: 'claude-code', label: 'Claude Code', bin: 'claude',
      addArgs: (e) => ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', e.command, ...e.args],
      removeArgs: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
      getArgs: ['mcp', 'get', SERVER_NAME],
      parseEntry: parseGetOutput,
    }),
    cliAdapter({
      id: 'codex', label: 'Codex', bin: 'codex',
      addArgs: (e) => ['mcp', 'add', SERVER_NAME, '--', e.command, ...e.args],
      removeArgs: ['mcp', 'remove', SERVER_NAME],
      getArgs: ['mcp', 'get', SERVER_NAME],
      parseEntry: parseGetOutput,
    }),
    jsonAdapter({
      id: 'cursor', label: 'Cursor', file: path.join(home, '.cursor', 'mcp.json'),
      detectDir: path.join(home, '.cursor'), keyPath: ['mcpServers'],
    }),
    jsonAdapter({
      id: 'claude-desktop', label: 'Claude Desktop', file: path.join(desktopDir, 'claude_desktop_config.json'),
      detectDir: desktopDir, keyPath: ['mcpServers'],
    }),
    jsonAdapter({
      id: 'zcode', label: 'ZCode', file: path.join(home, '.zcode', 'cli', 'config.json'),
      detectDir: path.join(home, '.zcode'), keyPath: ['mcp', 'servers'],
    }),
  ];
}
