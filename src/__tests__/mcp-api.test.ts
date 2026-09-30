import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMcpConfig, mcpGet } from '../mcp/api.js';

const TOKEN = 'cx_pat_abcdefgh.SECRETSECRET';
let home: string;

beforeEach(() => {
  // 隔离 ~/.chexian：loadMcpConfig 与 cx 同源，会读 HOME 下的 config.json
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-mcp-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CX_BASE_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeCxConfig(cfg: Record<string, string>): void {
  fs.mkdirSync(path.join(home, '.chexian'), { recursive: true });
  fs.writeFileSync(path.join(home, '.chexian', 'config.json'), JSON.stringify(cfg));
}

describe('loadMcpConfig', () => {
  it('环境变量与 cx 配置都没有令牌时快速失败，提示 cx login', () => {
    vi.stubEnv('CX_PAT', '');
    expect(() => loadMcpConfig()).toThrow(/cx login/);
  });

  it('前缀错误快速失败，且错误文案不回显令牌', () => {
    vi.stubEnv('CX_PAT', 'bad_SECRETSECRET');
    expect(() => loadMcpConfig()).toThrow(/must start with cx_pat_/);
    expect(() => loadMcpConfig()).not.toThrow(/SECRET/);
  });

  it('缺省 baseUrl 为生产', () => {
    vi.stubEnv('CX_PAT', TOKEN);
    expect(loadMcpConfig()).toEqual({ baseUrl: 'https://chexian.cretvalu.com', token: TOKEN });
  });

  it('无环境变量时读 cx login 写入的 ~/.chexian/config.json', () => {
    vi.stubEnv('CX_PAT', '');
    writeCxConfig({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN });
    expect(loadMcpConfig()).toEqual({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN });
  });

  it('CX_PAT 环境变量优先于配置文件', () => {
    const envToken = 'cx_pat_zzzzzzzz.ENVTOKEN';
    vi.stubEnv('CX_PAT', envToken);
    writeCxConfig({ token: TOKEN });
    expect(loadMcpConfig().token).toBe(envToken);
  });
});

describe('mcpGet', () => {
  const cfg = { baseUrl: 'http://mock', token: TOKEN };

  it('GET + Bearer，undefined 参数不进 query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true,"data":1}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await mcpGet(cfg, '/api/query/kpi', { a: 1, b: undefined });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://mock/api/query/kpi?a=1');
    expect(init.method).toBeUndefined();
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('非 2xx 映射为服务端错误文案，且不回显令牌', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{"success":false,"error":{"message":"Invalid PAT format"}}', { status: 401 }),
    ));
    const err = await mcpGet(cfg, '/api/x').catch((e: Error) => e);
    expect((err as Error).message).toBe('API 401: Invalid PAT format');
    expect((err as Error).message).not.toContain('SECRET');
  });

  it('非 JSON 错误体回落 HTTP 状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })));
    await expect(mcpGet(cfg, '/api/x')).rejects.toThrow('API 502: HTTP 502');
  });
});
