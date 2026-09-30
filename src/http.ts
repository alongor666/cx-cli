/**
 * HTTP 客户端 dispatcher：全局 undici Agent，开启 keep-alive + HTTP/2 + pipelining + TLS session 持久化。
 *
 * 无 import 副作用：由 api.ts 在某个 host 的首个请求前调用 attachTlsPersistence(host)，
 * 只构造一次 Agent。Bun 下 setGlobalDispatcher 无效但无害（Bun fetch 自带池化）。
 *
 * 收益：
 *   - 批量场景：单次 RTT 从 ~200ms（含 TLS）降到 ~10ms（复用 TLS）。
 *   - 跨进程：TLS session ticket 持久化到 ~/.chexian/tls-session-*.bin，第二次冷启动跳过完整 TLS 握手。
 */
import { Agent, buildConnector, setGlobalDispatcher } from 'undici';
import type { TLSSocket } from 'node:tls';
import { loadSession, saveSession } from './tls-session.js';

/**
 * 装配带 TLS session 复用的全局 Agent（自定义 connector 截获 TLSSocket 'session' 事件落盘）。
 * 失败时静默保留默认 dispatcher —— 这只是性能优化，绝不能影响请求本身。
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

    setGlobalDispatcher(new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      pipelining: 10,
      allowH2: true,
      connections: 16,
      connect: customConnector,
    }));
  } catch {
    // 兼容性兜底：buildConnector 签名不同 / Bun 下不可用时退回默认 dispatcher
  }
}
