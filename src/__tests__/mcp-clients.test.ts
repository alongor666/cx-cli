import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeJsonEntry, cliAdapter, codexTomlEntry, codexTomlEntryFromFile, defaultAdapters, jsonAdapter,
  parseGetOutput, selfEntry, SERVER_NAME, winQuote,
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
  // 不提供默认 readEntry：每个用例显式声明无损源语义（返回条目/null/undefined/不提供）
  const make = (run: Runner, readEntry?: () => McpEntry | null | undefined) => cliAdapter({
    id: 'claude-code', label: 'Claude Code', bin: 'claude',
    addArgs: (e) => ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', e.command, ...e.args],
    removeArgs: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
    getArgs: ['mcp', 'get', SERVER_NAME],
    parseEntry: parseGetOutput,
    readEntry,
    run,
  });

  it('install 先读原条目、再删后加，命令里不带 -e/PAT', () => {
    const { run, calls } = fakeRunner(true);
    make(run, () => ({ command: '/opt/cx/cx', args: ['mcp'] })).install(ENTRY);
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
    expect(() => make(run, () => ({ command: '/old/cx', args: ['mcp'] })).install(ENTRY)).toThrow(/已恢复原条目/);
    expect(calls.at(-1)).toEqual(['claude', 'mcp', 'add', '--scope', 'user', 'chexian', '--', '/old/cx', 'mcp']);
  });

  it('state 解析 mcp get 输出；未安装 CLI 视为未检测到', () => {
    expect(make(fakeRunner(true).run).state().entry).toEqual(ENTRY);
    expect(make(fakeRunner(false).run).state()).toMatchObject({ detected: false, entry: null });
  });
});

describe('cliAdapter 回滚安全（含空格路径回归，R11）', () => {
  const SPACE_ARGS = ['/Users/John Doe/cx/dist/index.js', 'mcp'];
  // `claude mcp get` 的文本输出：args 用空格拼接，含空格的路径在这里被拆散（有损）
  const lossyGetOut = `chexian:\n  Command: /opt/old/cx\n  Args: ${SPACE_ARGS.join(' ')}\n`;
  const entryFile = () => {
    const file = path.join(home, '.claude.json');
    fs.mkdirSync(home, { recursive: true });
    // claude mcp add 的真实写入形态：恒带 type:"stdio" 与空 env
    fs.writeFileSync(file, JSON.stringify({
      mcpServers: { [SERVER_NAME]: { type: 'stdio', command: '/opt/old/cx', args: SPACE_ARGS, env: {} } },
    }));
    return file;
  };
  const runWithFailingAdd = (calls: string[][]) => {
    let adds = 0;
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[1] === 'get') return { ok: true, stdout: lossyGetOut };
      if (args[1] === 'add') return { ok: ++adds > 1, stdout: adds > 1 ? '' : 'boom' };
      return { ok: true, stdout: '' };
    };
    return run;
  };

  it('原条目路径含空格：回滚用配置文件读到的完整路径，不用 mcp get 拆散的文本', () => {
    const file = entryFile();
    const calls: string[][] = [];
    expect(() => {
      cliAdapter({
        id: 'claude-code', label: 'Claude Code', bin: 'claude',
        addArgs: (e) => ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', e.command, ...e.args],
        removeArgs: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
        getArgs: ['mcp', 'get', SERVER_NAME],
        parseEntry: parseGetOutput,
        readEntry: () => claudeJsonEntry(file),
        run: runWithFailingAdd(calls),
      }).install(ENTRY);
    }).toThrow(/已恢复原条目/);
    // 回滚 re-add 必须带完整路径，绝不能是 '/Users/John' + 'Doe/cx/...' 两截
    expect(calls.at(-1)).toEqual(
      ['claude', 'mcp', 'add', '--scope', 'user', 'chexian', '--', '/opt/old/cx', ...SPACE_ARGS],
    );
  });

  it('读不到无损源时拒绝替换：不执行 remove/add，提示 mcp list 确认 scope 后手动处理', () => {
    const calls: string[][] = [];
    const run = runWithFailingAdd(calls);
    expect(() => makeNoLossless(run).install(ENTRY))
      .toThrow(/未做任何改动.*claude mcp list.*确认 chexian 条目及其 scope/s);
    expect(calls).toEqual([['claude', 'mcp', 'get', 'chexian']]);
  });

  it('配置文件读出的条目与 mcp get 文本对不上（或确认无条目、或文件读不出）时同样拒绝替换', () => {
    const run = runWithFailingAdd([]);
    expect(() => makeNoLossless(run, () => ({ command: '/another/cx', args: ['mcp'] })).install(ENTRY))
      .toThrow(/与 mcp get 输出的条目不一致/);
    expect(() => makeNoLossless(run, () => null).install(ENTRY))
      .toThrow(/没有该条目（可能配置在 local\/project 等其他 scope）/);
    expect(() => makeNoLossless(run, () => undefined).install(ENTRY))
      .toThrow(/无法从其配置文件无损读取原条目（文件损坏，或条目带 env 等回滚会丢失的配置项）/);
  });

  it('mcp get 失败或解析不出时，配置文件读到的条目兜底回滚（不静默删掉用户条目）', () => {
    // get 失败（命令报错/超时/输出格式变化）：previous 以无损源为准，回滚用完整路径
    for (const get of [false, true]) {
      const calls: string[][] = [];
      let adds = 0;
      const run: Runner = (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[1] === 'get') return { ok: get, stdout: get ? 'http 型条目，无 Command 行' : 'boom' };
        if (args[1] === 'add') return { ok: ++adds > 1, stdout: adds > 1 ? '' : 'boom' };
        return { ok: true, stdout: '' };
      };
      expect(() => makeNoLossless(run, () => ({ command: '/opt/old/cx', args: SPACE_ARGS })).install(ENTRY))
        .toThrow(/已恢复原条目/);
      expect(calls.at(-1)).toEqual(
        ['claude', 'mcp', 'add', '--scope', 'user', 'chexian', '--', '/opt/old/cx', ...SPACE_ARGS],
      );
    }
  });

  it('配置文件确认无条目且 mcp get 也没给出条目：照常安装，不拒绝', () => {
    const run: Runner = (_cmd, args) => {
      if (args[1] === 'get') return { ok: false, stdout: 'No MCP server found' };
      return { ok: true, stdout: '' };
    };
    expect(() => makeNoLossless(run, () => null).install(ENTRY)).not.toThrow();
  });

  it('原本无条目：add 失败不回滚、错误里不提恢复（行为不变）', () => {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[1] === 'get') return { ok: false, stdout: 'No MCP server found' };
      if (args[1] === 'add') return { ok: false, stdout: 'boom' };
      return { ok: true, stdout: '' };
    };
    expect(() => makeNoLossless(run).install(ENTRY)).toThrow(/add 失败：boom$/);
    expect(calls.filter((c) => c[2] === 'add')).toHaveLength(1);
  });

  // 不带 readEntry 的适配器（模拟只实现了 mcp 子命令的客户端）：回滚必须走拒绝路径
  function makeNoLossless(run: Runner, readEntry?: () => McpEntry | null | undefined) {
    return cliAdapter({
      id: 'claude-code', label: 'Claude Code', bin: 'claude',
      addArgs: (e) => ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', e.command, ...e.args],
      removeArgs: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
      getArgs: ['mcp', 'get', SERVER_NAME],
      parseEntry: parseGetOutput,
      readEntry,
      run,
    });
  }
});

describe('claudeJsonEntry（~/.claude.json 无损读取）', () => {
  const file = () => path.join(home, '.claude.json');

  it('无文件 / 无 mcpServers / 无 chexian 条目 → null；有条目 → 原样返回', () => {
    expect(claudeJsonEntry(file())).toBeNull();
    fs.writeFileSync(file(), JSON.stringify({ theme: 'dark' }));
    expect(claudeJsonEntry(file())).toBeNull();
    fs.writeFileSync(file(), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
    expect(claudeJsonEntry(file())).toBeNull();
    const withSpace = { command: '/opt/old/cx', args: ['/Users/John Doe/cx/dist/index.js', 'mcp'] };
    fs.writeFileSync(file(), JSON.stringify({ mcpServers: { [SERVER_NAME]: withSpace } }));
    expect(claudeJsonEntry(file())).toEqual(withSpace);
  });

  it('坏 JSON / 条目形状不对 → undefined（读不出来，调用方拒绝替换）', () => {
    fs.writeFileSync(file(), '{ broken');
    expect(claudeJsonEntry(file())).toBeUndefined();
    fs.writeFileSync(file(), JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: 1 } } }));
    expect(claudeJsonEntry(file())).toBeUndefined();
  });

  it('条目带 command/args 之外的字段（env 等）或 args 元素非字符串 → undefined：回滚会丢字段，不谎报恢复', () => {
    fs.writeFileSync(file(), JSON.stringify({
      mcpServers: { [SERVER_NAME]: { command: '/opt/cx', args: ['mcp'], env: { X: '1' } } },
    }));
    expect(claudeJsonEntry(file())).toBeUndefined();
    fs.writeFileSync(file(), JSON.stringify({
      mcpServers: { [SERVER_NAME]: { command: '/opt/cx', args: [1, 'mcp'] } },
    }));
    expect(claudeJsonEntry(file())).toBeUndefined();
    fs.writeFileSync(file(), JSON.stringify({
      mcpServers: { [SERVER_NAME]: { type: 'sse', command: '/opt/cx', args: ['mcp'], env: {} } },
    }));
    expect(claudeJsonEntry(file())).toBeUndefined();
    fs.writeFileSync(file(), JSON.stringify({
      mcpServers: { [SERVER_NAME]: { command: '/opt/cx', args: ['mcp'], cwd: '/tmp' } },
    }));
    expect(claudeJsonEntry(file())).toBeUndefined();
  });

  it('claude mcp add 的真实写入形态（恒带 type:"stdio" 与空 env）正常读出——重装/升级不得被拒（复审 NEW-1）', () => {
    const realShape = { type: 'stdio', command: '/Users/John Doe/cx/dist/index.js', args: ['mcp'], env: {} };
    fs.writeFileSync(file(), JSON.stringify({ mcpServers: { [SERVER_NAME]: realShape } }));
    expect(claudeJsonEntry(file())).toEqual({
      command: '/Users/John Doe/cx/dist/index.js', args: ['mcp'],
    });
    // 无 type / 无 env 的最小形态同样可读（env:null 等价缺失）
    fs.writeFileSync(file(), JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: '/a', args: ['mcp'], env: null } } }));
    expect(claudeJsonEntry(file())).toEqual({ command: '/a', args: ['mcp'] });
  });
});

describe('codexTomlEntry（~/.codex/config.toml 无损读取）', () => {
  it('标准形态：提取 command/args，含空格路径与 Windows 路径转义', () => {
    const toml = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.chexian]',
      'command = "/opt/old/cx"',
      'args = ["/Users/John Doe/cx/dist/index.js", "mcp"]',
      '',
      '[mcp_servers.other]',
      'command = "x"',
      'args = ["y"]',
    ].join('\n');
    expect(codexTomlEntry(toml)).toEqual({
      command: '/opt/old/cx', args: ['/Users/John Doe/cx/dist/index.js', 'mcp'],
    });
    const winToml = '[mcp_servers.chexian]\ncommand = "C:\\\\Program Files\\\\cx\\\\cx.exe"\nargs = ["mcp"]';
    expect(codexTomlEntry(winToml)?.command).toBe('C:\\Program Files\\cx\\cx.exe');
  });

  it('引用的 server 名与 literal 字符串也认', () => {
    expect(codexTomlEntry('[mcp_servers."chexian"]\ncommand = "/a"\nargs = []')).toEqual({ command: '/a', args: [] });
    expect(codexTomlEntry("[mcp_servers.chexian]\ncommand = '/a b'\nargs = ['mcp']")).toEqual({ command: '/a b', args: ['mcp'] });
  });

  it('没有 chexian section → null；读不了的形态 → undefined', () => {
    expect(codexTomlEntry('[mcp_servers.other]\ncommand = "x"\nargs = ["y"]')).toBeNull();
    expect(codexTomlEntry('')).toBeNull();
    expect(codexTomlEntry('[mcp_servers.chexian]\nargs = [\n  "mcp",\n]\ncommand = "/a"')).toBeUndefined(); // 多行数组
    expect(codexTomlEntry('[mcp_servers.chexian]\ncommand = "x"\nargs = ["mcp"] # 注释')).toBeUndefined(); // 行内注释
    expect(codexTomlEntry('[mcp_servers.chexian]\ncommand = 42\nargs = []')).toBeUndefined(); // 非字符串
    expect(codexTomlEntry('[mcp_servers.chexian]\ncommand = "x"\nargs = [1]')).toBeUndefined(); // 非字符串数组
    expect(codexTomlEntry('[mcp_servers.chexian]\ncommand = "x"')).toBeUndefined(); // 只有 command 没有 args
    expect(codexTomlEntry('[mcp_servers.chexian]\ncommand = "a\\ubb"\nargs = []')).toBeUndefined(); // 不认识的转义
    expect(codexTomlEntry('[mcp_servers.chexian]\ncommand = "a\\bb"\nargs = []')).toBeUndefined(); // 不认识的转义
  });

  it('条目带额外字段（env 键或 env 子表）→ undefined：回滚会丢字段，不谎报恢复', () => {
    expect(codexTomlEntry('[mcp_servers.chexian]\ncommand = "x"\nargs = ["mcp"]\nenv = { X = "1" }')).toBeUndefined();
    expect(codexTomlEntry('[mcp_servers.chexian]\ncommand = "x"\nargs = ["mcp"]\n[mcp_servers.chexian.env]\nX = "1"')).toBeUndefined();
  });

  it('codexTomlEntryFromFile：无文件 → null；坏形状 → undefined', () => {
    const file = path.join(home, '.codex', 'config.toml');
    expect(codexTomlEntryFromFile(file)).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[mcp_servers.chexian]\ncommand = "/opt/cx"\nargs = ["mcp"]');
    expect(codexTomlEntryFromFile(file)).toEqual({ command: '/opt/cx', args: ['mcp'] });
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
