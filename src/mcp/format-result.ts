/**
 * 把 /api/* 响应信封转成 MCP 工具结果文本。
 *
 * 两条硬约束：
 *   1. 信封除 success 外的键（data 以外如 meta：window_start / effective_start /
 *      latest_data_date / cutoffDate / rowCount …）原样保留——这是服务端给调用方的
 *      口径披露通道，丢掉它 LLM 就只能凭工具描述猜时间窗与数据截止日。
 *   2. 输出有字节上限：超限时优先按行截断数组型 data，并在文本头部明示「已截断」，
 *      让 LLM 知道拿到的是子集、应加筛选收窄，而不是把几 MB 结果灌进上下文。
 */

/** 默认单次工具结果字节上限（UTF-8）；CX_MCP_MAX_BYTES 可覆盖 */
export const DEFAULT_MAX_BYTES = 100_000;

export interface FormattedResult {
  text: string;
  truncated: boolean;
}

const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

/**
 * 剥掉 success 标志；只剩 data 时直接返回 data，否则保留其余信封键（meta 等），
 * 且把它们排在 data **之前**——硬截断从尾部砍，口径元数据必须在头部幸存。
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const { success: _success, ...rest } = body as Record<string, unknown>;
  const keys = Object.keys(rest);
  if (keys.length === 1 && keys[0] === 'data') return rest.data;
  if (!('data' in rest)) return rest;
  const { data, ...others } = rest;
  return { ...others, data };
}

export function resolveMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CX_MCP_MAX_BYTES);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : DEFAULT_MAX_BYTES;
}

function truncationNotice(detail: string): string {
  return `【结果已截断：${detail}。这是子集而非全量，请加筛选条件或缩小时间窗后重查，勿据此回答合计/排名类问题】\n`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

interface ArrayCandidate { path: string[]; rows: unknown[] }

/** 可按行截断的数组候选：顶层数组 / 顶层各键下的数组 / data 对象下一层的数组，按体积降序 */
function arrayCandidates(payload: unknown): ArrayCandidate[] {
  const candidates: ArrayCandidate[] = [];
  if (Array.isArray(payload)) candidates.push({ path: [], rows: payload });
  else if (isPlainObject(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      if (Array.isArray(v)) candidates.push({ path: [k], rows: v });
      else if (k === 'data' && isPlainObject(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          if (Array.isArray(v2)) candidates.push({ path: ['data', k2], rows: v2 });
        }
      }
    }
  }
  const size = (c: ArrayCandidate) => (JSON.stringify(c.rows) ?? '').length;
  return candidates.filter((c) => c.rows.length > 0).sort((a, b) => size(b) - size(a));
}

/** 不可变地替换 path 处的值 */
function setAt(root: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...tail] = path;
  const obj = root as Record<string, unknown>;
  return { ...obj, [head]: setAt(obj[head], tail, value) };
}

const labelOf = (c: ArrayCandidate) => (c.path.length > 0 ? c.path.join('.') : '结果');

/**
 * 从体积最大的数组起逐个按行截断：当前数组二分出最大可保留行数，装得下即返回；
 * 清空仍装不下就记为 0 行、继续截下一个。每个被截数组都在头部注明「保留 / 原行数」。
 */
function truncateArrays(payload: unknown, maxBytes: number): string | null {
  let current = payload;
  const notes: string[] = [];
  for (const target of arrayCandidates(payload)) {
    const render = (kept: number) => {
      const detail = [...notes, `${labelOf(target)} 仅返回前 ${kept} / ${target.rows.length} 行`].join('；');
      return truncationNotice(detail) + JSON.stringify(setAt(current, target.path, target.rows.slice(0, kept)));
    };
    let lo = 0;
    let hi = target.rows.length;
    let best: string | null = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const text = render(mid);
      if (byteLength(text) <= maxBytes) {
        best = text;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return best;
    current = setAt(current, target.path, []);
    notes.push(`${labelOf(target)} 仅返回前 0 / ${target.rows.length} 行`);
  }
  return null;
}

/** 按字节截断字符串，避免切断多字节字符 */
function sliceBytes(s: string, maxBytes: number): string {
  const bytes = encoder.encode(s);
  if (bytes.length <= maxBytes) return s;
  // 负数会被 Uint8Array.slice 解释为「砍掉末尾」而非「取 0 字节」，必须钳到 0（评审 F1）
  return new TextDecoder().decode(bytes.slice(0, Math.max(0, maxBytes))).replace(/\uFFFD+$/, '');
}

export function formatResult(body: unknown, maxBytes: number = DEFAULT_MAX_BYTES): FormattedResult {
  const payload = unwrapEnvelope(body);
  const full = JSON.stringify(payload) ?? 'null';
  if (byteLength(full) <= maxBytes) return { text: full, truncated: false };

  // 优先按行截断数组（信封其余键原样保留，meta 不丢）
  const fitted = truncateArrays(payload, maxBytes);
  if (fitted) return { text: fitted, truncated: true };

  // 非数组或单行即超限：退化为按字节硬截断（结果不再是合法 JSON，文案已明示）
  const notice = truncationNotice(`原文 ${byteLength(full)} 字节，仅保留前 ${maxBytes} 字节，末尾 JSON 不完整`);
  const room = maxBytes - byteLength(notice);
  // 上限连提示都放不下时只给截短的提示：上限对任意入参都必须成立
  if (room <= 0) return { text: sliceBytes(notice, maxBytes), truncated: true };
  return { text: notice + sliceBytes(full, room), truncated: true };
}
