import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApiUrl } from '../url.js';
import { parseRetryAfter } from '../api.js';
import { renderOutput, neutralizeFormula } from '../output.js';
import {
  updateFileConfig, loadFileConfig, loadConfig, clearToken, normalizeBaseUrl, isInsecureBaseUrl, deriveTokenId,
} from '../config.js';

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
    expect(neutralizeFormula('+86 138')).toBe("'+86 138");
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

  it.skipIf(process.platform === 'win32')('已存在的 644 配置文件写入后被收紧为 600', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{}', { mode: 0o644 });
    fs.chmodSync(file(), 0o644);
    updateFileConfig({ baseUrl: 'https://file.test' });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
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
