import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cliAdapter, defaultAdapters, jsonAdapter, parseGetOutput, selfEntry, SERVER_NAME, winQuote,
  type ClientAdapter, type McpEntry, type Runner,
} from '../mcp/clients.js';
import { mcpInstallCommand, mcpUninstallCommand, pickAdapters } from '../commands/mcp.js';
import { agentEnv, redactPat } from '../mcp/probe.js';

const ENTRY: McpEntry = { command: '/opt/cx/cx', args: ['mcp'] };
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-clients-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const zcode = () => jsonAdapter({
  id: 'zcode', label: 'ZCode', file: path.join(home, '.zcode', 'cli', 'config.json'),
  detectDir: path.join(home, '.zcode'), keyPath: ['mcp', 'servers'],
});

describe('selfEntry', () => {
  it('编译二进制：command 即自身，args 只有 mcp', () => {
    expect(selfEntry('/usr/local/bin/cx', '/whatever')).toEqual({ command: '/usr/local/bin/cx', args: ['mcp'] });
  });
  it('bun/node 跑源码：带上脚本绝对路径', () => {
    expect(selfEntry('/usr/bin/bun', '/repo/cli/src/index.ts'))
      .toEqual({ command: '/usr/bin/bun', args: ['/repo/cli/src/index.ts', 'mcp'] });
    expect(selfEntry('C:\\bun\\bun.exe', '/repo/cli/src/index.ts').args).toEqual(['/repo/cli/src/index.ts', 'mcp']);
  });
  it('只认 bun/node 本名：bunny、node-helper 这类二进制不误判', () => {
    expect(selfEntry('/usr/local/bin/bunny', '/x').args).toEqual(['mcp']);
    expect(selfEntry('/opt/node-helper', '/x').args).toEqual(['mcp']);
  });
});

describe('jsonAdapter', () => {
  it('保留既有配置、只加 chexian 条目，写前备份，条目不含 env/PAT', () => {
    const file = path.join(home, '.zcode', 'cli', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const before = { theme: 'dark', mcp: { servers: { other: { command: 'x', args: [] } } } };
    fs.writeFileSync(file, JSON.stringify(before), { mode: 0o644 });

    zcode().install(ENTRY);

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.mcp.servers.other).toEqual({ command: 'x', args: [] });
    expect(after.mcp.servers[SERVER_NAME]).toEqual({ command: '/opt/cx/cx', args: ['mcp'] });
    expect(JSON.stringify(after)).not.toMatch(/cx_pat_|env/);
    expect(JSON.parse(fs.readFileSync(`${file}.cx-bak`, 'utf8'))).toEqual(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it('文件不存在时新建（0600），重复 install 幂等', () => {
    const a = zcode();
    a.install(ENTRY);
    a.install(ENTRY);
    const file = path.join(home, '.zcode', 'cli', 'config.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(a.state().entry).toEqual(ENTRY);
  });

  it('坏 JSON 拒绝写入且原文不变', () => {
    const file = path.join(home, '.zcode', 'cli', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ broken');
    expect(() => zcode().install(ENTRY)).toThrow(/不是合法 JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('uninstall 只删 chexian，其余条目与顶层字段保留；无条目返回 false', () => {
    const file = path.join(home, '.zcode', 'cli', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', mcp: { servers: { other: { command: 'x', args: [] } } } }));
    const a = zcode();
    a.install(ENTRY);
    expect(a.uninstall()).toBe(true);
    expect(a.uninstall()).toBe(false);
    expect(a.state().entry).toBeNull();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after).toEqual({ theme: 'dark', mcp: { servers: { other: { command: 'x', args: [] } } } });
  });

  it('备份只在首次写入前生成：重复 install 不覆盖原始配置', () => {
    const file = path.join(home, '.zcode', 'cli', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = { mcp: { servers: { other: { command: 'x', args: [] } } } };
    fs.writeFileSync(file, JSON.stringify(original));
    const a = zcode();
    a.install(ENTRY);
    a.install({ command: '/new/cx', args: ['mcp'] });
    expect(JSON.parse(fs.readFileSync(`${file}.cx-bak`, 'utf8'))).toEqual(original);
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('cx-tmp'))).toEqual([]);
  });

  it('配置文件是符号链接时写回真实目标，链接保持不变', () => {
    const real = path.join(home, 'dotfiles', 'mcp.json');
    const link = path.join(home, '.zcode', 'cli', 'config.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(real, '{}');
    fs.symlinkSync(real, link);
    zcode().install(ENTRY);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).mcp.servers[SERVER_NAME]).toEqual(ENTRY);
  });

  it('detected 取决于客户端目录是否存在', () => {
    expect(zcode().state().detected).toBe(false);
    fs.mkdirSync(path.join(home, '.zcode'));
    expect(zcode().state().detected).toBe(true);
  });
});

describe('cliAdapter', () => {
  function fakeRunner(installed: boolean) {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === '--version') return { ok: installed, stdout: '' };
      if (args[1] === 'get') return { ok: true, stdout: 'chexian:\n  Command: /opt/cx/cx\n  Args: mcp\n' };
      return { ok: true, stdout: '' };
    };
    return { run, calls };
  }
  const make = (run: Runner) => cliAdapter({
    id: 'claude-code', label: 'Claude Code', bin: 'claude',
    addArgs: (e) => ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', e.command, ...e.args],
    removeArgs: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
    getArgs: ['mcp', 'get', SERVER_NAME],
    parseEntry: parseGetOutput,
    run,
  });

  it('install 先读原条目、再删后加，命令里不带 -e/PAT', () => {
    const { run, calls } = fakeRunner(true);
    make(run).install(ENTRY);
    expect(calls).toEqual([
      ['claude', 'mcp', 'get', 'chexian'],
      ['claude', 'mcp', 'remove', '--scope', 'user', 'chexian'],
      ['claude', 'mcp', 'add', '--scope', 'user', 'chexian', '--', '/opt/cx/cx', 'mcp'],
    ]);
    expect(calls.flat().join(' ')).not.toMatch(/-e |cx_pat_/);
  });

  it('add 失败时把原条目加回去，并在错误里说明', () => {
    const calls: string[][] = [];
    let adds = 0;
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[1] === 'get') return { ok: true, stdout: 'chexian:\n  Command: /old/cx\n  Args: mcp\n' };
      if (args[1] === 'add') return { ok: ++adds > 1, stdout: adds > 1 ? '' : 'boom' };
      return { ok: true, stdout: '' };
    };
    expect(() => make(run).install(ENTRY)).toThrow(/已恢复原条目/);
    expect(calls.at(-1)).toEqual(['claude', 'mcp', 'add', '--scope', 'user', 'chexian', '--', '/old/cx', 'mcp']);
  });

  it('state 解析 mcp get 输出；未安装 CLI 视为未检测到', () => {
    expect(make(fakeRunner(true).run).state().entry).toEqual(ENTRY);
    expect(make(fakeRunner(false).run).state()).toMatchObject({ detected: false, entry: null });
  });
});

describe('parseGetOutput', () => {
  it('兼容 claude（Command:）与 codex（command:）两种输出', () => {
    expect(parseGetOutput('x:\n  Command: npx\n  Args: -y pkg\n')).toEqual({ command: 'npx', args: ['-y', 'pkg'] });
    expect(parseGetOutput('x\n  command: /a/cx\n  args: mcp\n  cwd: -\n')).toEqual({ command: '/a/cx', args: ['mcp'] });
    expect(parseGetOutput('No MCP server found')).toBeNull();
  });
});

describe('defaultAdapters', () => {
  it('覆盖五家客户端，Claude Desktop 路径按平台区分', () => {
    const ids = defaultAdapters(home, 'darwin', {}).map((a) => a.id);
    expect(ids).toEqual(['claude-code', 'codex', 'cursor', 'claude-desktop', 'zcode']);
    const win = defaultAdapters(home, 'win32', { APPDATA: 'C:\\AppData' }).find((a) => a.id === 'claude-desktop')!;
    expect(win.state().where).toContain(path.join('C:\\AppData', 'Claude'));
  });
});

describe('mcp install / uninstall 命令', () => {
  const fake = (id: string, detected: boolean) => {
    const log: string[] = [];
    const a: ClientAdapter = {
      id, label: id,
      state: () => ({ id, label: id, detected, entry: null, where: id }),
      install: () => { log.push('install'); },
      uninstall: () => { log.push('uninstall'); return true; },
    };
    return { a, log };
  };

  it('自检失败时不写任何配置', async () => {
    const c = fake('cursor', true);
    const probe = vi.fn().mockRejectedValue(new Error('Missing PAT: run `cx login` first'));
    await expect(mcpInstallCommand({}, { adapters: [c.a], entry: ENTRY, probe })).rejects.toThrow(/cx login/);
    expect(c.log).toEqual([]);
  });

  it('自动模式只写检测到的客户端；--client 显式指定时即使未检测到也写', async () => {
    const probe = vi.fn().mockResolvedValue({ tools: ['cx_query_kpi', 'cx_whoami'] });
    const seen = fake('cursor', true);
    const unseen = fake('zcode', false);
    await mcpInstallCommand({}, { adapters: [seen.a, unseen.a], entry: ENTRY, probe });
    expect(seen.log).toEqual(['install']);
    expect(unseen.log).toEqual([]);

    await mcpInstallCommand({ client: 'zcode' }, { adapters: [seen.a, unseen.a], entry: ENTRY, probe });
    expect(unseen.log).toEqual(['install']);
  });

  it('令牌只在 CX_PAT 环境变量里时，自检失败提示先 cx login', async () => {
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CX_PAT', 'cx_pat_envonly.SECRET');
    const probe = vi.fn().mockRejectedValue(new Error('cx mcp 提前退出'));
    const err = await mcpInstallCommand({}, { adapters: [fake('cursor', true).a], entry: ENTRY, probe }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/只在环境变量 CX_PAT 里.*cx login/s);
    expect((err as Error).message).not.toContain('SECRET');
    vi.unstubAllEnvs();
  });

  it('一个都没写入时报错', async () => {
    const probe = vi.fn().mockResolvedValue({ tools: [] });
    await expect(mcpInstallCommand({}, { adapters: [fake('cursor', false).a], entry: ENTRY, probe }))
      .rejects.toThrow(/没有写入任何客户端/);
  });

  it('未知客户端 id 报用法错误', () => {
    expect(() => pickAdapters([fake('cursor', true).a], 'vscode')).toThrow(/未知客户端: vscode/);
  });

  it('uninstall 默认遍历全部', () => {
    const x = fake('cursor', true);
    const y = fake('zcode', false);
    mcpUninstallCommand({}, [x.a, y.a]);
    expect([x.log, y.log]).toEqual([['uninstall'], ['uninstall']]);
  });
});

describe('winQuote（Windows shell 模式参数）', () => {
  it('空白与 cmd 元字符整体加引号，内部双引号按 cmd 规则写成两个', () => {
    expect(winQuote('C:\\cx\\cx.exe')).toBe('C:\\cx\\cx.exe');
    expect(winQuote('C:\\Program Files\\cx.exe')).toBe('"C:\\Program Files\\cx.exe"');
    for (const ch of ['&', '|', '<', '>', '^', '(', ')', '%', '!']) {
      expect(winQuote(`C:\\a${ch}b\\cx.exe`)).toBe(`"C:\\a${ch}b\\cx.exe"`);
    }
    expect(winQuote('a"b')).toBe('"a""b"');
  });
});

describe('agentEnv（自检按 Agent 运行时条件跑）', () => {
  it('去掉只在当前 shell 有效的 CX_PAT / CX_BASE_URL，其余保留', () => {
    expect(agentEnv({ CX_PAT: 'cx_pat_x.y', CX_BASE_URL: 'http://a', PATH: '/bin', HOME: '/h' }))
      .toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('redactPat', () => {
  it('子进程 stderr 回传前脱敏', () => {
    expect(redactPat('bad cx_pat_abcd1234.SECRET-x_y here')).toBe('bad cx_pat_*** here');
  });
});
