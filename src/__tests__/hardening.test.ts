import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApiUrl } from '../url.js';
import { parseRetryAfter, CxApiError } from '../api.js';
import { renderOutput, neutralizeFormula } from '../output.js';
import {
  updateFileConfig, loadFileConfig, loadConfig, clearToken, normalizeBaseUrl, isInsecureBaseUrl, deriveTokenId,
} from '../config.js';
import { loginCommand } from '../commands/login.js';
import { mcpGet, resolveTimeoutMs } from '../mcp/api.js';

const mocks = vi.hoisted(() => ({ cxGet: vi.fn() }));
vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  cxGet: mocks.cxGet,
}));

describe('buildApiUrl', () => {
  it('相对 path 拼在 baseUrl 之后，去掉 baseUrl 尾斜杠，undefined 参数不进 query', () => {
    expect(buildApiUrl('https://h.test/', '/api/query/kpi', { a: 1, b: undefined }).href)
      .toBe('https://h.test/api/query/kpi?a=1');
  });

  it('保留 baseUrl 的路径前缀（反向代理场景）', () => {
    expect(buildApiUrl('https://h.test/prefix', '/api/x').href).toBe('https://h.test/prefix/api/x');
  });

  it('拒绝绝对 URL / 协议相对 URL —— PAT 不得发往其他 origin', () => {
    expect(() => buildApiUrl('https://h.test', 'https://evil.test/api')).toThrow(/非法 API path/);
    expect(() => buildApiUrl('https://h.test', '//evil.test/api')).toThrow(/非法 API path/);
  });

  it('拒绝 . / .. 路径段（含 %2e 编码），防止逃逸出 /api/query', () => {
    expect(() => buildApiUrl('https://h.test', '/api/query/a/../../auth/tokens')).toThrow(/\.\./);
    expect(() => buildApiUrl('https://h.test', '/api/query/a/%2e%2e/x')).toThrow(/\.\./);
    expect(() => buildApiUrl('https://h.test', '/api/query/./x')).toThrow(/\.\./);
  });

  it('拒绝反斜杠与控制字符：WHATWG 解析器会把它们规范化成 ..', () => {
    expect(() => buildApiUrl('https://h.test/p', '/api/query/x/..\\..\\auth/tokens')).toThrow(/反斜杠或控制字符/);
    expect(() => buildApiUrl('https://h.test/p', '/api/query/x/.\t./.\n./auth')).toThrow(/反斜杠或控制字符/);
  });

  it('baseUrl（含 CX_BASE_URL 环境变量）不得带凭据/查询串（含空 ? / #），且必须是 http(s)', () => {
    expect(() => buildApiUrl('https://u:p@h.test', '/api/x')).toThrow(/baseUrl/);
    expect(() => buildApiUrl('https://h.test?a=1', '/api/x')).toThrow(/baseUrl/);
    expect(() => buildApiUrl('https://h.test?', '/api/x')).toThrow(/baseUrl/);
    expect(() => buildApiUrl('https://h.test#', '/api/x')).toThrow(/baseUrl/);
    expect(() => buildApiUrl('file:///etc', '/api/x')).toThrow(/http\/https/);
  });

  it('..%2f / ..%5c（路径参数里的 ../ ..\\ 编码后）同样拒绝', () => {
    expect(() => buildApiUrl('https://h.test', `/api/query/x/${encodeURIComponent('../auth')}`)).toThrow(/\.\./);
    expect(() => buildApiUrl('https://h.test', `/api/query/x/${encodeURIComponent('..\\auth')}`)).toThrow(/\.\./);
  });

  it('path 参数中经 encodeURIComponent 的斜杠不会被拆成路径段', () => {
    expect(buildApiUrl('https://h.test', `/api/query/x/${encodeURIComponent('a/b')}`).pathname)
      .toBe('/api/query/x/a%2Fb');
  });
});

describe('parseRetryAfter', () => {
  it('秒数', () => expect(parseRetryAfter('7')).toBe(7));
  it('缺失/非法 → 60', () => {
    expect(parseRetryAfter(null)).toBe(60);
    expect(parseRetryAfter('soon')).toBe(60);
    for (const v of ['1.5', '-5', 'a 1', 'Mon 1', '1 Jan']) expect(parseRetryAfter(v)).toBe(60);
  });
  it('HTTP-date → 距今秒数，过去时间截为 0', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
  });
});

describe('CSV 安全', () => {
  it('含 \\r 的字段被引号包裹', () => {
    expect(renderOutput([{ note: 'a\rb' }], 'csv')).toBe('note\n"a\rb"');
  });

  it('公式注入：文本单元格前缀单引号，数值与纯数字文本不受影响', () => {
    const out = renderOutput([{ name: '=HYPERLINK("http://x")', delta: -5, txt: '-12.5' }], 'csv');
    expect(out.split('\n')[1]).toBe(`"'=HYPERLINK(""http://x"")",-5,-12.5`);
  });

  it('neutralizeFormula', () => {
    expect(neutralizeFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeFormula('-1+cmd|\' /C calc\'!A0')).toBe("'-1+cmd|' /C calc'!A0");
    expect(neutralizeFormula('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(neutralizeFormula('\t=1')).toBe("'\t=1");
    // 无函数/引用的格式化数值是业务值，不得篡改
    for (const v of ['-3.2%', '-1,234', '+86 138', '-', '-1.5e3', '2024-01-01', '-1.2万', '+5.1pp', '-3.2‰']) {
      expect(neutralizeFormula(v)).toBe(v);
    }
    // 单位走白名单且必须有数字：全角运算符/字母、纯汉字后缀都中和
    for (const v of ['-＝１', '-＋ｃｍｄ', '-Ａ１', '-亿亿亿亿', '+x']) expect(neutralizeFormula(v)).toBe(`'${v}`);
    // 两道约束各自锁住：有数字但后缀不在白名单 / 后缀在白名单但没有数字
    expect(neutralizeFormula('-1＋ｃｍ')).toBe("'-1＋ｃｍ");
    expect(neutralizeFormula('-万')).toBe("'-万");
    expect(neutralizeFormula('1e5')).toBe('1e5');
    expect(neutralizeFormula('普通文本')).toBe('普通文本');
  });
});

describe('config：环境变量绝不落盘', () => {
  let home: string;
  const file = () => path.join(home, '.chexian', 'config.json');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-cfg-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CX_PAT', 'cx_pat_envenv00.ENVSECRET');
    vi.stubEnv('CX_BASE_URL', 'https://env.test/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('updateFileConfig 只写 patch 中的键，不把 CX_PAT / CX_BASE_URL 写进文件', () => {
    updateFileConfig({ baseUrl: 'https://file.test' });
    const raw = fs.readFileSync(file(), 'utf-8');
    expect(raw).not.toContain('ENVSECRET');
    expect(raw).not.toContain('env.test');
    expect(loadFileConfig()).toEqual({ baseUrl: 'https://file.test' });
    // 生效配置仍是环境变量优先，且 baseUrl 尾斜杠被规范化
    expect(loadConfig().baseUrl).toBe('https://env.test');
  });

  it('clearToken 只删 token/tokenId，保留文件里的其他键，且不引入环境变量', () => {
    updateFileConfig({ baseUrl: 'https://file.test', token: 'cx_pat_file0000.S', tokenId: 'file0000' });
    clearToken();
    expect(loadFileConfig()).toEqual({ baseUrl: 'https://file.test' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('无权限读取的配置文件：写拒绝覆盖', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{"token":"cx_pat_FAKEKEEP.fake"}');
    fs.chmodSync(file(), 0o000);
    try {
      expect(() => updateFileConfig({ baseUrl: 'https://file.test' })).toThrow(/无法读取/);
    } finally {
      fs.chmodSync(file(), 0o600);
    }
    expect(fs.readFileSync(file(), 'utf-8')).toBe('{"token":"cx_pat_FAKEKEEP.fake"}');
  });

  it.skipIf(process.platform === 'win32')('已存在的 644 配置文件写入后被收紧为 600', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{}', { mode: 0o644 });
    fs.chmodSync(file(), 0o644);
    updateFileConfig({ baseUrl: 'https://file.test' });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('软链接的配置文件写到链接目标，链接本身保留', () => {
    const real = path.join(home, 'dotfiles-config.json');
    fs.writeFileSync(real, '{}');
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.symlinkSync(real, file());
    updateFileConfig({ baseUrl: 'https://file.test' });
    expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf-8'))).toEqual({ baseUrl: 'https://file.test' });
  });

  it('损坏的配置文件：读按空配置，写拒绝覆盖（否则冲掉其中的令牌）', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{"token":"cx_pat_keep0000.S",');
    expect(() => updateFileConfig({ baseUrl: 'https://file.test' })).toThrow(/不是合法的 JSON 对象/);
    expect(fs.readFileSync(file(), 'utf-8')).toBe('{"token":"cx_pat_keep0000.S",');
  });

  it('类型不对的字段忽略，不让每条命令崩在 .replace 上', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{"baseUrl":123,"token":"cx_pat_file0000.S"}');
    vi.stubEnv('CX_BASE_URL', '');
    expect(loadFileConfig()).toEqual({ token: 'cx_pat_file0000.S' });
    expect(loadConfig().baseUrl).toMatch(/^https:/);
  });

  it('损坏的配置文件按空配置处理', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{not json');
    expect(loadFileConfig()).toEqual({});
  });
});

describe('baseUrl 校验', () => {
  it('规范化尾斜杠，拒绝非 http(s)、内嵌凭据、查询串', () => {
    expect(normalizeBaseUrl('https://h.test///')).toBe('https://h.test');
    expect(() => normalizeBaseUrl('ftp://h.test')).toThrow(/协议/);
    expect(() => normalizeBaseUrl('https://u:p@h.test')).toThrow(/用户名/);
    expect(() => normalizeBaseUrl('https://h.test/?x=1')).toThrow(/查询串/);
    expect(() => normalizeBaseUrl('https://h.test?')).toThrow(/查询串/);
    expect(() => normalizeBaseUrl('https://h.test#')).toThrow(/查询串/);
  });

  it('明文 http 仅对非回环地址告警', () => {
    expect(isInsecureBaseUrl('http://intranet.corp')).toBe(true);
    expect(isInsecureBaseUrl('http://127.0.0.1:3000')).toBe(false);
    expect(isInsecureBaseUrl('https://h.test')).toBe(false);
  });

  it('deriveTokenId', () => {
    expect(deriveTokenId('cx_pat_abcd1234.secret')).toBe('abcd1234');
    expect(deriveTokenId('cx_pat_nodot')).toBeUndefined();
  });
});

// 一眼可辨的假令牌（形状满足 cx_pat_<id>.<secret> 校验即可）
const OLD_PAT = 'cx_pat_FAKEOLD0.fake';
const NEW_PAT = 'cx_pat_FAKENEW0.fake';
const ENV_PAT = 'cx_pat_FAKEENV0.fake';

describe('cx login', () => {
  let home: string;
  let errors: string[];
  const file = () => path.join(home, '.chexian', 'config.json');
  const ORIGINAL = { baseUrl: 'https://file.test', token: OLD_PAT, tokenId: 'FAKEOLD0' };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-login-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CX_PAT', '');
    vi.stubEnv('CX_BASE_URL', '');
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(ORIGINAL));
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    mocks.cxGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('校验失败：原有令牌与文件原样保留', async () => {
    mocks.cxGet.mockRejectedValue(new CxApiError(401, 'Invalid token'));
    await expect(loginCommand({ token: NEW_PAT })).rejects.toThrow(/exit 2/);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual(ORIGINAL);
  });

  it('用候选 PAT 显式校验，不被 CX_PAT 环境变量覆盖；成功后才落盘且不写入环境变量', async () => {
    vi.stubEnv('CX_PAT', ENV_PAT);
    mocks.cxGet.mockResolvedValue({ success: true, data: { username: 'u', role: 'r' } });
    await loginCommand({ token: NEW_PAT });
    expect(mocks.cxGet).toHaveBeenCalledWith('/api/auth/me', { token: NEW_PAT, baseUrl: 'https://file.test' });
    const saved = fs.readFileSync(file(), 'utf-8');
    expect(JSON.parse(saved)).toEqual({ ...ORIGINAL, token: NEW_PAT, tokenId: 'FAKENEW0' });
    expect(saved).not.toContain('FAKEENV0');
  });

  it('CX_BASE_URL 与文件 baseUrl 不一致时提示；仅大小写/尾斜杠不同不误报', async () => {
    mocks.cxGet.mockResolvedValue({ success: true, data: {} });
    vi.stubEnv('CX_BASE_URL', 'https://staging.test');
    await loginCommand({ token: NEW_PAT });
    expect(errors.join('\n')).toMatch(/CX_BASE_URL=https:\/\/staging\.test 优先于配置文件/);

    errors = [];
    vi.stubEnv('CX_BASE_URL', 'https://FILE.test/');
    await loginCommand({ token: NEW_PAT });
    expect(errors.join('\n')).not.toMatch(/优先于配置文件/);
  });
});

describe('mcp/api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolveTimeoutMs：默认 120s；非法与超出 setTimeout 上限的值回落默认', () => {
    expect(resolveTimeoutMs({})).toBe(120_000);
    expect(resolveTimeoutMs({ CX_MCP_TIMEOUT_MS: '5000' })).toBe(5000);
    for (const v of ['0', '-1', '1.5', 'abc', String(2 ** 31)]) expect(resolveTimeoutMs({ CX_MCP_TIMEOUT_MS: v })).toBe(120_000);
  });

  it('cxGet 的显式 token 优先于 CX_PAT（login 校验候选令牌靠它）', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-api-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CX_PAT', ENV_PAT);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { cxGet } = await vi.importActual<typeof import('../api.js')>('../api.js');
      await cxGet('/api/auth/me', { token: NEW_PAT, baseUrl: 'https://h.test' });
      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${NEW_PAT}`);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('mcpGet 拒绝绝对 URL，请求不发出（令牌不外泄）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(mcpGet({ baseUrl: 'https://h.test', token: 't' }, 'https://evil.test/api/x')).rejects.toThrow(/非法 API path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
