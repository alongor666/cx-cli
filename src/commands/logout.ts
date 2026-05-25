/**
 * cx logout
 *
 * 清除本地保存的 PAT。注意：这不会吊销服务端的 token，
 * 如需彻底失效请到 Web UI 删除或调 DELETE /api/auth/tokens/:id。
 */
import kleur from 'kleur';
import { clearToken } from '../config.js';

export function logoutCommand(): void {
  clearToken();
  console.error(kleur.green('✔ Local token cleared.'));
  console.error(kleur.gray('  Note: token still exists on server. Revoke via web UI to fully invalidate.'));
}
