/**
 * 各 Agent 客户端的 MCP 配置写入（cx mcp install / uninstall / status）
 *
 * 写入的条目只有 `{ command: <cx 绝对路径>, args: ["mcp"] }`——PAT 由 cx mcp 自己从
 * cx login 的配置读，**任何客户端配置里都不出现令牌**。
 *
 * - Claude Code / Codex：调它们自带的 `mcp add/remove`（它们的配置文件会被运行中的进程并发改写，
 *   不直接动文件）；未装 CLI 即视为未检测到。add 失败需回滚时，原条目只从各自的配置文件
 *   （~/.claude.json / ~/.codex/config.toml）无损读取——`mcp get` 的文本输出会把含空格的
 *   路径拆散，读不到无损源时拒绝替换、提示手动处理，绝不把拆散的条目写回去。
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
  if (!a || a.command !== b.command) return false;
  // `<bin> mcp get` 的文本输出把 args 以空格拼接，含空格的路径会被拆散：按拼接后的字符串比较
  return a.args.join(' ') === b.args.join(' ');
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
      else if (next === undefined || next === null) {
        if (!create) return null;
        node[key] = {};
        node = node[key] as Json;
      } else {
        // 存在但不是对象（数组/字符串…）：可能是用户或其他工具的格式，覆盖即丢失其中的 server 配置
        if (!create) return null;
        throw new Error(`${opts.file} 中 ${opts.keyPath.join('.')} 不是对象，已跳过（未改动）。请手工检查后重试`);
      }
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
  /** 无损读现有条目（直读客户端配置文件）：返回原条目；null=配置里确认没有条目；undefined=文件在但读不出 */
  readEntry?: () => McpEntry | null | undefined;
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
      // 不让一次失败的升级把用户原有的 chexian 配置删掉。
      // 回滚用的原条目只认配置文件里的无损读取（readEntry）：`mcp get` 的文本输出把 args
      // 按空格拼接，含空格的路径回滚重加会被拆坏（R11）。已有条目却读不到无损源、或无损源
      // 与 mcp get 文本对不上时，宁可不动配置——提示用户手动处理。
      const got = run(opts.bin, opts.getArgs);
      const parsed = got.ok ? opts.parseEntry?.(got.stdout) ?? null : null;
      let previous: McpEntry | null = null;
      let refusal: string | null = null;
      if (opts.readEntry) {
        const lossless = opts.readEntry();
        if (lossless === undefined) {
          refusal = '无法从其配置文件无损读取原条目（文件损坏，或条目带 env 等回滚会丢失的配置项）';
        } else if (parsed) {
          if (lossless === null) refusal = '其用户级配置文件里没有该条目（可能配置在 local/project 等其他 scope）';
          else if (!sameEntry(lossless, parsed)) refusal = '其配置文件与 mcp get 输出的条目不一致';
          else previous = lossless;
        } else {
          // mcp get 没给出条目（命令失败/输出格式变化）：以配置文件为准兜底回滚，
          // 避免 remove 后 add 失败时静默删掉用户条目
          previous = lossless;
        }
      } else if (parsed) {
        refusal = '该客户端没有可用的无损配置源';
      }
      if (refusal) {
        throw new Error(
          `${opts.label} 已配置 chexian，但${refusal}——cx 需要无损读到原条目才敢替换`
          + `（\`${opts.bin} mcp get\` 的文本输出会把含空格的路径拆散，直接恢复可能改坏配置）。`
          + `本次未做任何改动，请先运行 \`${opts.bin} mcp list\` 确认 chexian 条目及其 scope，手动移除后重试 cx mcp install`,
        );
      }
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

// ── CLI 型客户端配置文件的无损读取（回滚恢复只信这里，不信 mcp get 的有损文本） ──

/** Claude Code user scope 的 MCP 条目存在 `~/.claude.json` 顶层 `mcpServers` */
export function claudeJsonEntry(file: string): McpEntry | null | undefined {
  if (!fs.existsSync(file)) return null;
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = (doc as Json | null)?.mcpServers;
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) return undefined;
    const entry = (v as Json)[SERVER_NAME];
    if (entry === undefined || entry === null) return null;
    const e = entry as Json;
    // 形状非法按"读不出"处理；额外字段里只容忍 claude 恒写的恒等键——type:"stdio" 与空 env，
    // 丢了等于没丢；非空 env（回滚 re-add 只写 command/args 会丢用户环境变量）与其他键（cwd 等）仍拒绝
    if (typeof e.command !== 'string' || !Array.isArray(e.args) || !e.args.every((x) => typeof x === 'string')) return undefined;
    if (e.type !== undefined && e.type !== 'stdio') return undefined;
    const env = e.env;
    if (env !== undefined && env !== null
      && (typeof env !== 'object' || Array.isArray(env) || Object.keys(env as Json).length > 0)) return undefined;
    if (Object.keys(e).some((k) => k !== 'command' && k !== 'args' && k !== 'type' && k !== 'env')) return undefined;
    return { command: e.command, args: e.args };
  } catch {
    return undefined;
  }
}

const TOML_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };

/** TOML 单行字符串解码；不是单行可解码字符串、或含不认识的转义时返回 undefined（保守，宁可不读） */
function tomlString(s: string): string | undefined {
  const basic = s.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (basic) {
    for (const m of basic[1].matchAll(/\\(.)/gs)) {
      if (!(m[1] in TOML_ESCAPES)) return undefined;
    }
    return basic[1].replace(/\\(.)/gs, (_, c: string) => TOML_ESCAPES[c]);
  }
  const literal = s.match(/^'([^']*)'$/);
  if (literal) return literal[1];
  return undefined;
}

/** TOML 单行字符串数组解码；多行/嵌套/带行内注释等读不了的形式返回 undefined */
function tomlStringArray(s: string): string[] | undefined {
  const m = s.match(/^\[(.*)\]$/s);
  if (!m) return undefined;
  const segs = m[1].split(/("(?:[^"\\]|\\.)*"|'[^']*')/g);
  const items: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (i % 2 === 1) { // 捕获组：字符串元素
      const v = tomlString(seg);
      if (v === undefined) return undefined;
      items.push(v);
    } else if (seg && !/^[\s,]+$/.test(seg)) return undefined; // 元素间只允许逗号/空白
  }
  return items;
}

/** 从 `~/.codex/config.toml` 抽 `[mcp_servers.<name>]` 的 command/args。
 *  null=没有可识别的 chexian section；undefined=解析不了或条目带 command/args 之外的
 *  字段（env 等）——回滚 re-add 只写 command/args 会丢字段，带额外字段的条目一律按读不出处理 */
export function codexTomlEntry(raw: string, server = SERVER_NAME): McpEntry | null | undefined {
  const esc = server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${esc}"|'${esc}'|${esc})\\]\\s*$`);
  const descendant = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${esc}"|'${esc}'|${esc})\\.`);
  let inSection = false;
  let hasExtra = false;
  let command: string | undefined;
  let args: string[] | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inSection = header.test(t);
      if (!inSection && descendant.test(t)) hasExtra = true; // [mcp_servers.chexian.env] 之类的子表
      continue;
    }
    if (!inSection || !t || t.startsWith('#')) continue;
    const kv = t.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!kv) return undefined;
    if (kv[1] === 'command') {
      if (command !== undefined) return undefined;
      command = tomlString(kv[2]);
      if (command === undefined) return undefined;
    } else if (kv[1] === 'args') {
      if (args !== undefined) return undefined;
      args = tomlStringArray(kv[2]);
      if (args === undefined) return undefined;
    } else {
      hasExtra = true; // env/cwd 等额外键
    }
  }
  if (command === undefined && args === undefined && !hasExtra) return null; // 没有 chexian section
  if (command === undefined || args === undefined || hasExtra) return undefined;
  return { command, args };
}

export function codexTomlEntryFromFile(file: string): McpEntry | null | undefined {
  if (!fs.existsSync(file)) return null;
  try {
    return codexTomlEntry(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
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
      readEntry: () => claudeJsonEntry(path.join(home, '.claude.json')),
    }),
    cliAdapter({
      id: 'codex', label: 'Codex', bin: 'codex',
      addArgs: (e) => ['mcp', 'add', SERVER_NAME, '--', e.command, ...e.args],
      removeArgs: ['mcp', 'remove', SERVER_NAME],
      getArgs: ['mcp', 'get', SERVER_NAME],
      parseEntry: parseGetOutput,
      readEntry: () => codexTomlEntryFromFile(path.join(home, '.codex', 'config.toml')),
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
