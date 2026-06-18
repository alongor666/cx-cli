/**
 * cx query --interactive (-i) 或不带 key 时进入交互式构建器。
 *
 * 设计要点：
 *   - zero-dep：用 node:readline/promises 内置
 *   - 收集 {key, params} 后委托 queryCommand —— 复用非交互路径全部下游逻辑（resolve / path-params / cxGet / 渲染 / 退出码）
 *   - TTY 不可用 → 打印用法并 exit USAGE，不挂死
 *   - 纯函数拆分（pickRouteFromInput / buildParamSpec / previewUrl）便于单测
 *   - 提示一律走 stderr，不污染 stdout 的最终 JSON/CSV 输出
 */
import readline from 'node:readline/promises';
import kleur from 'kleur';
import { fetchCatalog, type RouteMeta, searchRoutes } from './routes.js';
import { queryCommand, type QueryOpts } from './query.js';
import { failWith, EXIT } from '../exit-codes.js';
import type { OutputFormat } from '../output.js';
import { applyPathParams } from '../path-params.js';

export interface InteractiveOpts {
  format?: OutputFormat;
  limit?: number;
  timeoutMs?: number;
}

/** ----- 纯函数（可单测） ----- */

/** 把用户在「输入序号或 key」框里键入的字符串解析为 route：序号 / 大小写宽容 key / catalog path */
export function pickRouteFromInput(raw: string, routes: RouteMeta[]): RouteMeta | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed) - 1;
    return routes[idx] ?? null;
  }
  const norm = trimmed.toUpperCase().replace(/-/g, '_').replace(/^\/?/, '');
  const byKey = routes.find((r) => r.key === norm);
  if (byKey) return byKey;
  const pathCandidate = '/' + trimmed.replace(/^\//, '');
  return routes.find((r) => r.path === pathCandidate) ?? null;
}

/** wizard 要逐个 prompt 的参数 spec：先 path 模板 :var，再 query parameters，避免重复 */
export interface ParamSpec {
  name: string;
  required: boolean;
  inPath: boolean;
  type: string;
  description: string;
  enum?: string[];
}

export function buildParamSpec(route: RouteMeta): ParamSpec[] {
  const pathVars = Array.from(route.fullPath.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)).map((m) => m[1]);
  const out: ParamSpec[] = [];
  for (const name of pathVars) {
    const meta = (route.parameters ?? []).find((p) => p.name === name);
    out.push({
      name,
      required: true,
      inPath: true,
      type: meta?.type ?? 'string',
      description: meta?.description ?? '',
      enum: meta?.enum,
    });
  }
  for (const p of route.parameters ?? []) {
    if (pathVars.includes(p.name)) continue;
    out.push({
      name: p.name,
      required: Boolean(p.required),
      inPath: false,
      type: p.type ?? 'string',
      description: p.description ?? '',
      enum: p.enum,
    });
  }
  return out;
}

/** 预览 URL：仅用于展示，真正执行复用 queryCommand → applyPathParams 链路 */
export function previewUrl(route: RouteMeta, params: Record<string, string>): string {
  let resolvedPath: string;
  let restArgs: Record<string, string>;
  try {
    ({ resolvedPath, restArgs } = applyPathParams(route.fullPath, params));
  } catch (err) {
    return `${route.fullPath} (incomplete: ${(err as Error).message})`;
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(restArgs)) {
    if (v !== '' && v !== undefined && v !== null) qs.set(k, v);
  }
  const qsStr = qs.toString();
  return qsStr ? `${resolvedPath}?${qsStr}` : resolvedPath;
}

/** ----- 交互入口 ----- */

/**
 * wizard 是否应直接拒绝交互（缺 TTY）。
 *
 * 只检查 stdin — 因 prompt/进度全部走 stderr，stdout 是数据出口；
 * `cx query -i -f json > result.json`（stdin TTY 交互 + stdout 重定向）属正常用法，
 * 不应被 guard 拒。仅当 stdin 不是 TTY（如 `cx query < input.txt` 管道喂数据）时才拒。
 */
export function isInteractiveUnsupported(stdinTty: boolean | undefined): boolean {
  return !stdinTty;
}

export interface IO {
  question(prompt: string): Promise<string>;
  close(): void;
}

function defaultIO(): IO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return {
    question: (p) => rl.question(p),
    close: () => rl.close(),
  };
}

export interface InteractiveDeps {
  io?: IO;
  fetchRoutes?: () => Promise<RouteMeta[]>;
  invokeQuery?: (key: string, options: QueryOpts) => Promise<void>;
}

export async function interactiveQueryCommand(opts: InteractiveOpts, deps: InteractiveDeps = {}): Promise<void> {
  const usingDefaultIO = !deps.io;
  if (usingDefaultIO && isInteractiveUnsupported(process.stdin.isTTY)) {
    process.stderr.write(kleur.red('✘ 交互模式需要 stdin 是 TTY（stdout 可重定向到文件/管道）。请直接传 key + 参数：\n'));
    process.stderr.write(kleur.gray('  cx query <key|path> [--param=value ...]\n'));
    process.stderr.write(kleur.gray('  cx routes 列出可用路由\n'));
    process.exit(EXIT.USAGE);
  }
  const io = deps.io ?? defaultIO();
  try {
    process.stderr.write(kleur.bold().cyan('\n■ cx query 交互式构建器\n'));
    process.stderr.write(kleur.gray('  Ctrl-C 退出；可选项可直接回车跳过\n'));

    const routes = await (deps.fetchRoutes ?? (() => fetchCatalog(false)))();
    const route = await pickRouteInteractive(io, routes);
    if (!route) {
      process.stderr.write(kleur.red('\n✘ 未选择路由，已退出\n'));
      io.close();
      process.exit(EXIT.USAGE);
    }
    process.stderr.write(kleur.green(`\n✓ 已选 ${route.key}  `) + kleur.gray(route.path) + '\n');
    if (route.summary) process.stderr.write(kleur.gray(`  ${route.summary}\n`));

    const params = await collectParams(io, route);
    process.stderr.write(kleur.gray(`\n→ 预览: ${previewUrl(route, params)}\n`));
    const ans = (await io.question(kleur.cyan('运行？(Y/n): '))).trim().toLowerCase();
    io.close();
    if (ans === 'n' || ans === 'no') {
      process.stderr.write(kleur.gray('已取消\n'));
      return;
    }
    await (deps.invokeQuery ?? queryCommand)(route.key, {
      params,
      format: opts.format,
      limit: opts.limit,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    try { io.close(); } catch {}
    failWith(err);
  }
}

async function pickRouteInteractive(io: IO, routes: RouteMeta[]): Promise<RouteMeta | null> {
  const search = (await io.question(kleur.cyan('\n搜索关键词（key/path/summary，空回车看全部）: '))).trim();
  const filtered = search ? searchRoutes(routes, search) : routes;
  if (filtered.length === 0) {
    process.stderr.write(kleur.red(`✘ 无匹配路由\n`));
    return null;
  }
  const MAX = 30;
  const display = filtered.slice(0, MAX);
  process.stderr.write(kleur.gray(`\n候选 ${display.length}/${filtered.length}：\n`));
  for (let i = 0; i < display.length; i++) {
    const r = display[i];
    const tag = r.tags?.[0] ?? '';
    process.stderr.write(
      `  ${kleur.cyan(String(i + 1).padStart(2))}. ${kleur.bold(r.key)} ${kleur.gray(r.path)}${tag ? kleur.gray(' [' + tag + ']') : ''}\n`,
    );
    if (r.summary) process.stderr.write(kleur.gray(`      ${r.summary}\n`));
  }
  if (filtered.length > MAX) {
    process.stderr.write(kleur.gray(`  (省略 ${filtered.length - MAX} 条，请缩窄关键词)\n`));
  }
  const ans = await io.question(kleur.cyan('\n输入序号或 key: '));
  return pickRouteFromInput(ans, display);
}

async function collectParams(io: IO, route: RouteMeta): Promise<Record<string, string>> {
  const specs = buildParamSpec(route);
  if (specs.length === 0) {
    process.stderr.write(kleur.gray('\n（该路由无参数）\n'));
    return {};
  }
  process.stderr.write(kleur.gray('\n参数：\n'));
  const out: Record<string, string> = {};
  for (const s of specs) {
    const tag = s.inPath ? kleur.yellow('[path]') : s.required ? kleur.red('[必填]') : kleur.gray('[可选]');
    const desc = s.description ? kleur.gray(`  ${s.description}`) : '';
    const enumHint = s.enum?.length ? kleur.gray(`\n    可选值: ${s.enum.join(' | ')}`) : '';
    process.stderr.write(`\n${kleur.bold(s.name)} ${tag}${desc}${enumHint}\n`);
    while (true) {
      const v = (await io.question(kleur.cyan(`  ${s.name}= `))).trim();
      if (!v && (s.required || s.inPath)) {
        process.stderr.write(kleur.red('  ✘ 必填，请输入值\n'));
        continue;
      }
      if (v) out[s.name] = v;
      break;
    }
  }
  return out;
}
