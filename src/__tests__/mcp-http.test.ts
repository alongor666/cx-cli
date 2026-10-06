// @vitest-environment node
/**
 * HTTP 入口（CX-ADR-f03914）：真起 node:http 服务器（随机端口、回环），用裸 fetch 发
 * JSON-RPC over POST（ChatGPT connector 的实际形态，enableJsonResponse 下响应即 JSON）——
 * 鉴权、路由、无状态、SQL 工具双面剔除都走协议验证，不是互相 import。
 * 不用 SDK 客户端连接：vitest 环境下其 AbortSignal 与 fetch 的 realm 不一致（实测 TypeError）。
 * 工具面与 handleCall 用注入夹具，不依赖网络。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpHandler, httpConfigFromEnv, routeRequest, redactPath, HTTP_EXCLUDED_TOOLS } from '../mcp/http.js';
import { buildToolsFromRoutes, type McpTool, type RouteMeta } from '../mcp/build-tools.js';

const TOKEN = 'a'.repeat(24) + 'B9_-cdefghijklmnop'; // 40 字符，合法字符集

const mkTool = (name: string): McpTool => ({
  name,
  description: `${name} 描述`,
  inputSchema: { type: 'object', properties: {} },
});

// 夹具工具面故意包含 cx_query_sql 与行级明细 ledger：证明 HTTP 入口把它们从列表和执行面同时剔除
const tools: McpTool[] = [mkTool('cx_query_kpi'), mkTool('cx_query_sql'), mkTool('cx_query_network_outlet_ledger'), mkTool('cx_whoami')];
const handleCall = vi.fn(async (name: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ tool: name }) }],
}));

let server: http.Server;
let base: string;
const logs: string[] = [];

beforeAll(async () => {
  const handler = createHttpHandler({ version: 'test', tools, handleCall }, TOKEN, (l) => { logs.push(l); });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let nextId = 0;

/** 单次 JSON-RPC 请求（无状态：每次独立 POST，不带会话头）；非 2xx 时把响应体带进错误便于定位 */
async function rpc(path: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}: ${text.slice(0, 300)}`);
  return { status: res.status, body: JSON.parse(text) as { result?: Record<string, unknown>; error?: unknown } };
}

/** initialize + 目标方法（对齐客户端常规握手序列） */
async function session(path: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  const init = await rpc(path, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cx-http-test', version: '0' } }, headers);
  expect(init.status).toBe(200);
  return rpc(path, method, params, headers);
}

describe('HTTP 入口 · 协议回路', () => {
  it('Bearer 令牌：列表不含 cx_query_sql，正常工具调用透传', async () => {
    const headers = { authorization: `Bearer ${TOKEN}` };
    const list = await session('/mcp', 'tools/list', {}, headers);
    const names = ((list.body.result as { tools: { name: string }[] }).tools).map((t) => t.name);
    expect(names).toEqual(['cx_query_kpi', 'cx_whoami']);
    expect(names).not.toContain('cx_query_sql');
    const call = await session('/mcp', 'tools/call', { name: 'cx_query_kpi', arguments: {} }, headers);
    const result = call.body.result as { content: [{ text: string }] };
    expect(JSON.parse(result.content[0].text)).toEqual({ tool: 'cx_query_kpi' });
  });

  it('cx_query_sql 列表外直呼也拒绝：isError + 裁定文案，handleCall 不被触达', async () => {
    handleCall.mockClear(); // spy 跨用例共享：只断言本用例期间无触达
    const r = await session(`/mcp/${TOKEN}`, 'tools/call', { name: 'cx_query_sql', arguments: { sql: 'SELECT 1' } });
    const result = r.body.result as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CX-ADR-f03914');
    expect(handleCall).not.toHaveBeenCalled();
  });

  it('路径令牌（ChatGPT 连接器形态）：/mcp/<令牌> 不带请求头也能列工具', async () => {
    const list = await session(`/mcp/${TOKEN}`, 'tools/list', {});
    const names = ((list.body.result as { tools: { name: string }[] }).tools).map((t) => t.name);
    expect(names).toEqual(['cx_query_kpi', 'cx_whoami']);
  });

  it('无状态：不携带任何会话头，连续多轮 initialize+list 各自成功（进程重启对客户端透明的语义）', async () => {
    for (let i = 0; i < 2; i++) {
      const list = await session(`/mcp/${TOKEN}`, 'tools/list', {});
      expect(((list.body.result as { tools: unknown[] }).tools)).toHaveLength(2);
    }
  });

  it('错令牌 / 无令牌 → 401，响应体不回显令牌；日志里路径令牌已打码', async () => {
    for (const [url, headers] of [
      [`${base}/mcp`, {}],
      [`${base}/mcp`, { authorization: `Bearer ${TOKEN}x` }],
      [`${base}/mcp/${TOKEN.slice(0, -1)}`, {}],
    ] as const) {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain(TOKEN.slice(0, 10));
    }
    expect(logs.some((l) => l.includes('/mcp/***'))).toBe(true);
    expect(logs.every((l) => !l.includes(TOKEN.slice(0, -1)))).toBe(true);
  });

  it('其它路径 → 404', async () => {
    expect((await fetch(`${base}/`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await fetch(`${base}/mcp/${TOKEN}/extra`)).status).toBe(404);
  });

  it('畸形 request-target 原始请求 → 404 且服务存活（评审 F1 协议回路级回归锁：曾 unhandled-rejection 打崩进程）', async () => {
    const r1 = await fetch(`${base}//`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r1.status).toBe(404);
    // 崩溃环判据：畸形请求之后，正常鉴权请求仍能得到 2xx 响应
    const list = await session(`/mcp/${TOKEN}`, 'tools/list', {});
    expect(((list.body.result as { tools: unknown[] }).tools)).toHaveLength(2);
  });

  it('GET（非 SSE accept）→ 4xx 拒绝形态，不挂起（评审 F5 回路）', async () => {
    const r = await fetch(`${base}/mcp/${TOKEN}`, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it('DELETE（stateless 会话终结形态）→ 非 5xx 且服务存活（评审 F5 回路）', async () => {
    const r = await fetch(`${base}/mcp/${TOKEN}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
    expect(r.status).toBeLessThan(500);
    const list = await session(`/mcp/${TOKEN}`, 'tools/list', {});
    expect(((list.body.result as { tools: unknown[] }).tools)).toHaveLength(2);
  });
});

describe('routeRequest / redactPath（纯函数）', () => {
  it('畸形 request-target 判 404 不抛异常（评审 F1 回归锁：absolute-form/协议相对 URL 曾打崩进程）', () => {
    expect(routeRequest('//', `Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: false, status: 404 });
    expect(routeRequest('http://evil.example.com/mcp', undefined, TOKEN)).toEqual({ ok: false, status: 404 });
    expect(routeRequest('://bad', undefined, TOKEN)).toEqual({ ok: false, status: 404 });
  });

  it('两种携带方式互不串：/mcp 只看请求头，/mcp/<令牌> 只看路径', () => {
    expect(routeRequest('/mcp', `Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true });
    expect(routeRequest('/mcp/', `bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true });
    expect(routeRequest(`/mcp/${TOKEN}`, undefined, TOKEN)).toEqual({ ok: true });
    // 路径段鉴权后忽略请求头：错 Bearer + 对路径令牌仍放行
    expect(routeRequest(`/mcp/${TOKEN}`, 'Bearer wrong', TOKEN)).toEqual({ ok: true });
    expect(routeRequest('/mcp/wrong', `Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: false, status: 401 });
    expect(routeRequest('/mcp', undefined, TOKEN)).toEqual({ ok: false, status: 401 });
    expect(routeRequest('/other', `Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: false, status: 404 });
    expect(routeRequest(undefined, `Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: false, status: 404 });
  });

  it('查询串不影响路径段鉴权', () => {
    expect(routeRequest(`/mcp/${TOKEN}?x=1`, undefined, TOKEN)).toEqual({ ok: true });
  });

  it('打码只遮令牌段', () => {
    expect(redactPath(`/mcp/${TOKEN}?x=1`)).toBe('/mcp/***?x=1');
    expect(redactPath('/mcp')).toBe('/mcp');
  });

  it('多段形态全遮蔽（部署验收实测 P1 #1421：token 在非首段曾完整落 journald）', () => {
    expect(redactPath(`/mcp/junk/${TOKEN}`)).toBe('/mcp/***');
    expect(redactPath(`/mcp/a/b/${TOKEN}?x=1`)).toBe('/mcp/***?x=1');
  });
});

describe('httpConfigFromEnv · 无令牌即不对外服务', () => {
  it('齐全时构造；默认回环 127.0.0.1:8788', () => {
    expect(httpConfigFromEnv({ CX_MCP_HTTP_TOKEN: TOKEN })).toEqual({ token: TOKEN, host: '127.0.0.1', port: 8788 });
    expect(httpConfigFromEnv({ CX_MCP_HTTP_TOKEN: TOKEN, CX_MCP_HTTP_HOST: '100.113.70.55', CX_MCP_HTTP_PORT: '9000' }))
      .toEqual({ token: TOKEN, host: '100.113.70.55', port: 9000 });
  });

  it.each([
    [{}, /至少 32 个字符/],
    [{ CX_MCP_HTTP_TOKEN: 'short' }, /至少 32 个字符/],
    [{ CX_MCP_HTTP_TOKEN: `${TOKEN}/x` }, /只许字母/],
    [{ CX_MCP_HTTP_TOKEN: `${TOKEN}.y` }, /只许字母/],
    [{ CX_MCP_HTTP_TOKEN: TOKEN, CX_MCP_HTTP_HOST: '0.0.0.0' }, /不许监听全部网卡/],
    [{ CX_MCP_HTTP_TOKEN: TOKEN, CX_MCP_HTTP_HOST: '::' }, /不许监听全部网卡/],
    [{ CX_MCP_HTTP_TOKEN: TOKEN, CX_MCP_HTTP_HOST: '' }, /不许监听全部网卡/],
    [{ CX_MCP_HTTP_TOKEN: TOKEN, CX_MCP_HTTP_PORT: '70000' }, /不是合法端口/],
    [{ CX_MCP_HTTP_TOKEN: TOKEN, CX_MCP_HTTP_PORT: 'abc' }, /不是合法端口/],
    [{ CX_MCP_HTTP_TOKEN: TOKEN, CX_MCP_HTTP_PORT: '0' }, /不是合法端口/],
  ])('拒绝 %j', (env, re) => {
    expect(() => httpConfigFromEnv(env)).toThrow(re);
  });
});

describe('HTTP_EXCLUDED_TOOLS · 工具面红线', () => {
  it('剔除名单 = SQL 直通 + 行级明细 ledger，别无其他（防止悄悄扩大剔除面）', () => {
    expect([...HTTP_EXCLUDED_TOOLS]).toEqual(['cx_query_sql', 'cx_query_network_outlet_ledger']);
  });

  it('名单与真实工具名对账（复审 F2 / DSH F-1：SSOT 生成名必须命中名单，否则剔除静默失效）', () => {
    // key/path 抄自 server/src/config/query-routes-metadata.ts（:978 SQL 直通、:1373 ledger 明细）——
    // fixture 只搬最小集，改名的瞬间本测试红，黑名单失效不再静默
    const routes: RouteMeta[] = [
      {
        key: 'SQL', path: '/sql', fullPath: '/api/query/sql', method: 'GET',
        summary: 'SQL 直通', description: 'd', parameters: [], tags: [],
      },
      {
        key: 'NETWORK_OUTLET_LEDGER', path: '/network-outlet/ledger', fullPath: '/api/query/network-outlet/ledger', method: 'GET',
        summary: '网点台账明细', description: 'd', parameters: [], tags: [],
      },
    ];
    const generated = buildToolsFromRoutes(routes).tools.map((t) => t.name);
    for (const name of generated) {
      expect(HTTP_EXCLUDED_TOOLS.has(name)).toBe(true);
    }
    for (const excluded of HTTP_EXCLUDED_TOOLS) {
      expect(generated).toContain(excluded);
    }
  });
});
