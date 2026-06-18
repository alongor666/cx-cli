/**
 * TLS 1.3 session ticket 跨进程持久化：让短命 cx 进程之间复用 TLS session。
 *
 * 收益：第二次 cx 启动的首请求跳过完整 TLS 握手（节省 ~80-100ms RTT）。
 *
 * 存储：~/.chexian/tls-session-<host>.bin（chmod 600，6h TTL）。
 * 触发：undici secureConnect 后通过 TLSSocket 'session' 事件拿到 NewSessionTicket。
 *
 * 兼容：session 只对**同一 host** 有效；不同 baseUrl 各存一份。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const CACHE_DIR = path.join(os.homedir(), '.chexian');
const SESSION_TTL_MS = 6 * 3600 * 1000;

function sessionPath(host: string): string {
  const safe = crypto.createHash('sha256').update(host).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, `tls-session-${safe}.bin`);
}

export function loadSession(host: string): Buffer | undefined {
  try {
    const p = sessionPath(host);
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > SESSION_TTL_MS) return undefined;
    return fs.readFileSync(p);
  } catch {
    return undefined;
  }
}

export function saveSession(host: string, buf: Buffer): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sessionPath(host), buf, { mode: 0o600 });
  } catch {
    // 静默失败：磁盘只读 / 权限问题不影响 cx 工作，只是少一次性能优化
  }
}
