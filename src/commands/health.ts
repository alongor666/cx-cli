/**
 * cx health [-f table|json|csv]
 *
 * 一站式连通性诊断：
 *   1) GET {baseUrl}/health        — 服务存活（无鉴权）
 *   2) GET /api/data/version       — 鉴权 + 数据新鲜度（需 PAT；未配置时标记 skipped）
 * 输出 endpoint / status / latency_ms / detail，任一失败 exit 1。
 */
import kleur from 'kleur';
import { cxGet, CxApiError } from '../api.js';
import { loadConfig } from '../config.js';
import { renderOutput, type OutputFormat } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { note } from '../cli-state.js';

interface CheckRow {
  endpoint: string;
  status: 'ok' | 'fail' | 'skipped';
  latency_ms: number | '';
  detail: string;
}

export async function healthCommand(opts: { format?: OutputFormat }): Promise<void> {
  const cfg = loadConfig();
  const rows: CheckRow[] = [];

  // 1) /health（无鉴权）
  {
    const started = Date.now();
    try {
      const res = await fetch(`${cfg.baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      rows.push({
        endpoint: '/health',
        status: res.ok ? 'ok' : 'fail',
        latency_ms: Date.now() - started,
        detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status}`,
      });
    } catch (err) {
      rows.push({
        endpoint: '/health',
        status: 'fail',
        latency_ms: Date.now() - started,
        detail: (err as Error).message,
      });
    }
  }

  // 2) /api/data/version（鉴权 + 数据新鲜度）
  if (!cfg.token) {
    rows.push({ endpoint: '/api/data/version', status: 'skipped', latency_ms: '', detail: '未配置 PAT（cx login）' });
  } else {
    const started = Date.now();
    try {
      const resp = await cxGet<{ success: boolean; data: Record<string, unknown> }>('/api/data/version', {
        timeoutMs: 15_000,
      });
      rows.push({
        endpoint: '/api/data/version',
        status: 'ok',
        latency_ms: Date.now() - started,
        detail: JSON.stringify(resp.data ?? {}),
      });
    } catch (err) {
      rows.push({
        endpoint: '/api/data/version',
        status: 'fail',
        latency_ms: Date.now() - started,
        detail: err instanceof CxApiError ? `${err.status}: ${err.message}` : (err as Error).message,
      });
    }
  }

  const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
  console.log(renderOutput(rows, fmt));
  note(kleur.gray(`baseUrl: ${cfg.baseUrl}`));

  if (rows.some((r) => r.status === 'fail')) process.exit(EXIT.GENERAL);
}
