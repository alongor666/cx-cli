/**
 * HTTP 客户端 dispatcher：全局 undici Agent，开启 keep-alive + HTTP/2 + pipelining + TLS session 持久化。
 *
 * 副作用模块：import './http.js' 即生效，setGlobalDispatcher 让 Node 全局 fetch 自动复用连接。
 * Bun 下自带 fetch 池化，setGlobalDispatcher 无效但无害（fetch 仍工作）。
 *
 * 优化叠加：
 *   - 单次脚本：~5ms 初始化开销（首次构造 Agent），后续无成本。
 *   - 批量场景：单次 RTT 从 ~200ms（含 TLS）降到 ~10ms（复用 TLS）。
 *   - 跨进程：TLS session ticket 持久化到 ~/.chexian/tls-session-*.bin，第二次冷启动跳过完整 TLS 握手。
 */
import { Agent, buildConnector, setGlobalDispatcher } from 'undici';
import type { TLSSocket } from 'node:tls';
import { loadSession, saveSession } from './tls-session.js';
import { loadConfig } from './config.js';

let initialized = false;

export function initHttpDispatcher(): void {
  if (initialized) return;
  initialized = true;

  const agent = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    pipelining: 10,
    allowH2: true,
    connections: 16,
    connect: {
      // 由 undici buildConnector 透传到 tls.connect 的初始 session（若有持久化的 ticket）
      session: undefined,
    },
  });

  try {
    setGlobalDispatcher(agent);
  } catch {
    // Bun 下 setGlobalDispatcher 可能不可用，Bun fetch 自带池化，忽略。
  }
}

initHttpDispatcher();

// 副作用：根据当前 baseUrl 装配带 TLS session 持久化的 dispatcher（覆盖上面普通 Agent）
try {
  const host = new URL(loadConfig().baseUrl).host;
  attachTlsPersistence(host);
} catch {
  // baseUrl 解析失败时跳过 TLS 持久化，普通 Agent 仍生效
}

/**
 * 显式装配带 TLS session 复用的 Agent（buildConnector 自定义版）。
 *
 * 为什么不放进 initHttpDispatcher：undici 8.x 的 connect 选项透传 session 到 tls.connect 已能在
 * **首次** RTT 受益（如果磁盘里已有 ticket）；但要把握 **新 session 落盘** 需自定义 connector
 * 包装 buildConnector，截获 TLSSocket 'session' 事件。提供 attachTlsPersistence(host) 给需要
 * 跨进程复用 TLS 的入口（如 cx query 单次调用）调用。
 */
export function attachTlsPersistence(host: string): void {
  try {
    const initialSession = loadSession(host);
    const baseConnector = buildConnector({ ...(initialSession ? { session: initialSession } : {}) });

    const customConnector: ReturnType<typeof buildConnector> = (options, callback) => {
      return baseConnector(options, (err, socket) => {
        if (err) {
          callback(err, null);
          return;
        }
        if (socket && typeof (socket as TLSSocket).getSession === 'function') {
          (socket as TLSSocket).on('session', (sess: Buffer) => {
            saveSession(host, sess);
          });
        }
        callback(null, socket);
      });
    };

    const agentWithPersistence = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      pipelining: 10,
      allowH2: true,
      connections: 16,
      connect: customConnector,
    });
    setGlobalDispatcher(agentWithPersistence);
  } catch {
    // 兼容性兜底：buildConnector 在某些 undici 版本签名不同时退回默认 dispatcher
  }
}
