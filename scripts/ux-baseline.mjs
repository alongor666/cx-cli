#!/usr/bin/env node
/**
 * cx CLI 用户体验黄金标准 harness — 与 benchmark.mjs / perf-baseline.json 对称。
 *
 * perf-baseline 钉「快不快」；ux-baseline 钉「好不好用」。落库 cli/ux-baseline.json。
 *
 * 四维（iteration 1 实现确定性离线两维，旅程/可发现性 live 维见 _status: pending）：
 *   ① 一致性 (consistency)  跨命令的退出码契约 / 报错前缀 / 帮助可达性 lint
 *   ② 渲染   (rendering)    帮助文本 + 报错/离线输出的黄金快照（用户真正看到的字面）
 *   ③ 旅程   (journey)      装→login→whoami→首次成功 query 的 time-to-first-success（需 live PAT）
 *   ④ 可发现 (discoverability) 报错是否给可操作提示 / 可用值；帮助是否自解释（部分需 live）
 *
 * 棘轮模型：一致性违规存入 known_violations；--check 只对「新增违规」失败，
 * 已知违规消失则提示「已修复，请 --write 更新基线」（与 perf 的 hard/aspirational target 同理）。
 *
 * 用法：
 *   node cli/scripts/ux-baseline.mjs            # dry-run：跑一遍打人类报告，不写文件
 *   node cli/scripts/ux-baseline.mjs --write    # 覆盖 ux-baseline.json（建立/更新黄金标准）
 *   node cli/scripts/ux-baseline.mjs --check     # 对照基线，快照漂移 / 新增违规 → exit 1
 *   node cli/scripts/ux-baseline.mjs --json      # 机器可读输出当前测量
 *
 * 确定性：固定 NO_COLOR=1 + 隔离空 HOME（无 PAT → 鉴权路径恒定 exit 2）+ 剥离 tsx dev 噪声。
 * 优先用 dist/cx 编译产物（=生产用户真正所见，无 DEP 噪声），缺失则回退 tsx。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = resolve(CLI_ROOT, 'ux-baseline.json');
const BIN_PATH = resolve(CLI_ROOT, 'dist/cx');
const ENTRY = resolve(CLI_ROOT, 'src/index.ts');
const ISOLATED_HOME = join(tmpdir(), 'cx-ux-harness-home');

const args = process.argv.slice(2);
const flags = {
  write: args.includes('--write'),
  check: args.includes('--check'),
  json: args.includes('--json'),
  journey: args.includes('--journey'),
  n: Number(args.find((a) => a.startsWith('--n='))?.slice('--n='.length) ?? 5),
};

/** 全部子命令（help 元命令不计） */
const COMMANDS = [
  'login', 'logout', 'whoami', 'routes', 'query', 'sql', 'fields',
  'metrics', 'presets', 'filters', 'data', 'health', 'batch', 'config', 'completion',
];

/**
 * 离线确定性快照清单：帮助（全命令） + 报错/离线行为面。
 * 每条都不依赖网络 / PAT，固定环境下字节级稳定。
 */
const SNAPSHOTS = [
  { id: 'help-root', argv: ['--help'], doc: '根帮助' },
  ...COMMANDS.map((c) => ({ id: `help-${c}`, argv: [c, '--help'], doc: `${c} 帮助` })),
  { id: 'err-whoami-nopat', argv: ['whoami'], doc: '无 PAT whoami（应 exit 2 + 可操作提示）' },
  { id: 'err-query-nopat', argv: ['query', 'KPI', '--year=2026'], doc: '无 PAT query（应 exit 2）' },
  { id: 'err-sql-nopat', argv: ['sql', 'SELECT 1'], doc: '无 PAT sql（应 exit 2）' },
  { id: 'err-completion-noarg', argv: ['completion'], doc: 'completion 缺参数（用法错误）' },
  { id: 'err-data-nosub', argv: ['data'], doc: 'data 缺子命令（用法错误）' },
  { id: 'err-unknown-cmd', argv: ['foobar'], doc: '未知命令（用法错误）' },
  { id: 'ok-config-get', argv: ['config', 'get', 'baseUrl'], doc: 'config get（离线 exit 0）' },
];

/** 一致性 lint 规则文档（人类可读，写入基线供追溯） */
const CONSISTENCY_RULES = {
  R1_help_listed: '每个子命令出现在根帮助 Commands 区',
  R2_help_exit0: '每个子命令 <cmd> --help 退出码为 0',
  R3_auth_exit2: '无 PAT 的鉴权失败统一 exit 2（鉴权失败契约）',
  R4_usage_exit4: '用法错误（缺参数 / 缺子命令 / 未知命令）统一 exit 4（用法错误契约）',
  R5_error_prefix: '错误信息统一以 "✘ " 前缀打到 stderr（failWith 出口）',
};

/** 剥离非确定性噪声：tsx 的 DEP 警告、node:pid 前缀、experimental 提示 */
function normalize(s) {
  return (s || '')
    .split('\n')
    .filter((l) => !/DeprecationWarning|module\.register|ExperimentalWarning|trace-deprecation/.test(l))
    .filter((l) => !/^\(node:\d+\)/.test(l))
    .filter((l) => !/\(Use `node /.test(l))
    // bunx/bun 首次安装依赖噪声（冷启动 CI 会出现，依赖已装则无 → 不剥离必漂移）
    .filter((l) => !/Resolving dependencies|Resolved, downloaded|Saved lockfile|^bun add|installed /.test(l))
    .join('\n')
    .replace(/\s+$/g, '');
}

function runnerKind() {
  return existsSync(BIN_PATH) ? 'compiled-bin' : 'tsx';
}

function runCx(argv) {
  const useBin = existsSync(BIN_PATH);
  const cmd = useBin ? BIN_PATH : 'bunx';
  const cmdArgs = useBin ? argv : ['tsx', ENTRY, ...argv];
  const res = spawnSync(cmd, cmdArgs, {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: ISOLATED_HOME,
      CX_PAT: '',
      CX_BASE_URL: '',
    },
  });
  return {
    exitCode: res.status === null ? -1 : res.status,
    stdout: normalize(res.stdout),
    stderr: normalize(res.stderr),
  };
}

/** 采集全部快照 */
function capture() {
  // 隔离空 HOME：确保无 ~/.chexian/config.json → 鉴权路径恒定
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
  mkdirSync(ISOLATED_HOME, { recursive: true });
  const snapshots = {};
  for (const s of SNAPSHOTS) {
    const r = runCx(s.argv);
    snapshots[s.id] = { argv: s.argv, doc: s.doc, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
  return snapshots;
}

/** 基于快照跑一致性 lint，返回 violations 列表 */
function lint(snapshots) {
  const violations = [];
  const add = (rule, id, detail) => violations.push({ key: `${rule}:${id}`, rule, id, detail });

  // R1: 子命令在根帮助 Commands 区可达
  const rootHelp = snapshots['help-root']?.stdout || '';
  const commandsBlock = rootHelp.split(/Commands:/)[1] || '';
  for (const c of COMMANDS) {
    if (!new RegExp(`(^|\\n)\\s+${c}\\b`).test(commandsBlock)) add('R1_help_listed', c, `根帮助未列出命令 ${c}`);
  }

  // R2: 每命令 --help exit 0
  for (const c of COMMANDS) {
    const snap = snapshots[`help-${c}`];
    if (snap && snap.exitCode !== 0) add('R2_help_exit0', c, `${c} --help 退出码 ${snap.exitCode}≠0`);
  }

  // R3: 无 PAT 鉴权失败 → exit 2
  for (const id of ['err-whoami-nopat', 'err-query-nopat', 'err-sql-nopat']) {
    const snap = snapshots[id];
    if (snap && snap.exitCode !== 2) add('R3_auth_exit2', id, `${id} 退出码 ${snap.exitCode}≠2`);
  }

  // R4: 用法错误 → exit 4
  for (const id of ['err-completion-noarg', 'err-data-nosub', 'err-unknown-cmd']) {
    const snap = snapshots[id];
    if (snap && snap.exitCode !== 4) add('R4_usage_exit4', id, `${id} 退出码 ${snap.exitCode}≠4（用法错误应为 4）`);
  }

  // R5: 错误信息以 "✘ " 前缀打到 stderr
  for (const id of ['err-whoami-nopat', 'err-query-nopat', 'err-sql-nopat',
    'err-completion-noarg', 'err-data-nosub', 'err-unknown-cmd']) {
    const snap = snapshots[id];
    if (snap && snap.exitCode !== 0 && !snap.stderr.startsWith('✘')) {
      add('R5_error_prefix', id, `${id} stderr 未用 "✘ " 前缀: ${JSON.stringify(snap.stderr.slice(0, 50))}`);
    }
  }

  return violations;
}

/**
 * ④ 可发现性（离线）：报错是否给可操作下一步。
 * 可操作 = stderr 含 "Run: cx" / "cx <子命令>" / "可用" / "available" / "--help" 等引导。
 * 评分 = 可操作报错数 / 全部非零退出报错数，目标 1.0。
 */
function scoreDiscoverability(snapshots) {
  const errorIds = Object.keys(snapshots).filter((id) => id.startsWith('err-') && snapshots[id].exitCode !== 0);
  // 锚定到明确的"下一步"标记，避免裸词 available 把 "not available" 误判为可操作
  const actionableRe = /Run: cx|cx (login|routes|query|filters|whoami|<)|可用值|可用维度|available values?:|--help|请直接传|请运行/i;
  const nonActionable = [];
  for (const id of errorIds) {
    const text = `${snapshots[id].stdout}\n${snapshots[id].stderr}`;
    if (!actionableRe.test(text)) nonActionable.push({ id, stderr: snapshots[id].stderr.slice(0, 60) });
  }
  const ratio = errorIds.length === 0 ? 1 : (errorIds.length - nonActionable.length) / errorIds.length;
  return {
    _doc: '报错可操作率 = 给出下一步的报错 / 全部报错。目标 1.0，棘轮：不可下降。',
    errors_total: errorIds.length,
    errors_actionable_ratio: Number(ratio.toFixed(3)),
    target: 1.0,
    non_actionable: nonActionable,
  };
}

function stats(samples) {
  if (samples.length === 0) return { n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / samples.length;
  const std = Math.sqrt(variance);
  return {
    n: samples.length,
    p50: Math.round(sorted[Math.floor(0.5 * sorted.length)]),
    p95: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]),
    mean: Math.round(mean),
    cv: mean === 0 ? 0 : Number((std / mean).toFixed(3)),
  };
}

/** 用真实 HOME（含 PAT）跑 live 命令并计时 */
function runCxLive(argv) {
  const useBin = existsSync(BIN_PATH);
  const cmd = useBin ? BIN_PATH : 'bunx';
  const cmdArgs = useBin ? argv : ['tsx', ENTRY, ...argv];
  const t0 = performance.now();
  const res = spawnSync(cmd, cmdArgs, { cwd: CLI_ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, NO_COLOR: '1' } });
  const ms = performance.now() - t0;
  return { exitCode: res.status === null ? -1 : res.status, stdout: res.stdout || '', ms };
}

/**
 * ③ 旅程（live）：已配置用户的 time-to-first-success = whoami（鉴权确认）+ 首次成功 query。
 * 前置：~/.chexian/config.json 有 PAT 且 server 可达。功能性门禁（成功与否），计时仅记录不硬闸（网络噪声）。
 */
function measureJourney(n) {
  const probe = runCxLive(['whoami']);
  if (probe.exitCode !== 0) {
    return { _status: 'unavailable', _note: `whoami 退出码 ${probe.exitCode}（需有效 PAT + 可达 server），跳过旅程测量` };
  }
  const whoamiMs = [];
  const firstQueryMs = [];
  let querySucceeded = true;
  for (let i = 0; i < n; i++) {
    const w = runCxLive(['whoami']);
    const q = runCxLive(['query', 'KPI', '--year=2026', '--format=json', '--limit=1']);
    if (w.exitCode !== 0 || q.exitCode !== 0 || !q.stdout.trim()) querySucceeded = false;
    whoamiMs.push(w.ms);
    firstQueryMs.push(q.ms);
  }
  const total = whoamiMs.map((w, i) => w + firstQueryMs[i]);
  return {
    _status: 'measured',
    _doc: 'time-to-first-success：新用户 login 后，whoami 确认身份 + 首次成功 query 的总耗时。功能门禁=两步均 exit 0，计时记录不硬闸。',
    steps_after_login: 2,
    first_success: querySucceeded,
    whoami_ms: stats(whoamiMs),
    first_query_ms: stats(firstQueryMs),
    time_to_first_success_ms: stats(total),
  };
}

function measure() {
  const snapshots = capture();
  const violations = lint(snapshots);
  const journey = flags.journey
    ? measureJourney(flags.n)
    : { _status: 'pending', _note: '加 --journey 触发 live 测量（需 PAT + server）' };
  return {
    runner: runnerKind(),
    consistency: { rules: CONSISTENCY_RULES, violations },
    rendering: { snapshots },
    journey,
    discoverability: scoreDiscoverability(snapshots),
  };
}

function buildBaseline(m) {
  return {
    version: 1,
    _doc: 'cx CLI 用户体验黄金标准基线。--check 强校验渲染快照零漂移 + 一致性无新增违规。',
    measured_at: new Date().toISOString(),
    runner: m.runner,
    dimensions: {
      consistency: {
        _doc: '跨命令退出码契约 / 报错前缀 / 帮助可达性。known_violations 为已知债务（棘轮：不可新增）。',
        rules: m.consistency.rules,
        known_violations: m.consistency.violations,
      },
      rendering: {
        _doc: '帮助 + 报错/离线输出的黄金快照 = 用户真正看到的字面，逐字节守护。',
        snapshots: m.rendering.snapshots,
      },
      journey: m.journey,
      discoverability: m.discoverability,
    },
  };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function printReport(m) {
  const v = m.consistency.violations;
  console.log(`\n=== cx UX 基线测量（runner: ${m.runner}）===`);
  console.log(`① 一致性: ${Object.keys(m.rendering.snapshots).length} 快照 / ${v.length} 条违规`);
  for (const x of v) console.log(`     ⚠️  [${x.rule}] ${x.detail}`);
  const d = m.discoverability;
  console.log(`④ 可发现性: 报错可操作率 ${(d.errors_actionable_ratio * 100).toFixed(0)}% (${d.errors_total - d.non_actionable.length}/${d.errors_total}，目标 100%)`);
  for (const x of d.non_actionable) console.log(`     ⚠️  无下一步引导: ${x.id} — ${JSON.stringify(x.stderr)}`);
  const j = m.journey;
  if (j._status === 'measured') {
    console.log(`③ 旅程: 首次成功=${j.first_success ? '✓' : '✗'} · time-to-first-success p50 ${j.time_to_first_success_ms.p50}ms / p95 ${j.time_to_first_success_ms.p95}ms / CV ${j.time_to_first_success_ms.cv}`);
  } else {
    console.log(`③ 旅程: ${j._status}`);
  }
}

// ---- 主流程 ----
if (flags.write) {
  const m = measure();
  const baseline = buildBaseline(m);
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  printReport(m);
  console.log(`\n✓ 已写入 ${BASELINE_PATH}`);
  console.log(`  其中 ${m.consistency.violations.length} 条一致性违规登记为 known_violations（棘轮基线）。`);
  process.exit(0);
}

if (flags.check) {
  const baseline = loadBaseline();
  if (!baseline) {
    console.error('✘ 基线不存在，请先 node cli/scripts/ux-baseline.mjs --write');
    process.exit(1);
  }
  const m = measure();
  let failed = false;

  // 0) runner 一致性：tsx↔编译产物切换可能改变帮助渲染，快照对比前先提示
  if (baseline.runner && baseline.runner !== m.runner) {
    console.log(`ℹ️  [runner] 基线 runner=${baseline.runner} 当前=${m.runner} — 渲染差异会在快照对比中暴露；如有意切换请 --write 重建基线`);
  }

  // 1) 渲染快照漂移
  const baseSnaps = baseline.dimensions.rendering.snapshots;
  const nowSnaps = m.rendering.snapshots;
  for (const id of Object.keys(baseSnaps)) {
    const b = baseSnaps[id];
    const n = nowSnaps[id];
    if (!n) { console.error(`✘ [渲染] 快照缺失: ${id}`); failed = true; continue; }
    if (b.exitCode !== n.exitCode || b.stdout !== n.stdout || b.stderr !== n.stderr) {
      console.error(`✘ [渲染] 快照漂移: ${id} (${b.doc})`);
      if (b.exitCode !== n.exitCode) console.error(`    exit ${b.exitCode} → ${n.exitCode}`);
      if (b.stdout !== n.stdout) console.error(`    stdout 变化`);
      if (b.stderr !== n.stderr) console.error(`    stderr 变化`);
      failed = true;
    }
  }

  // 2) 一致性：新增违规 fail；消失违规提示更新
  const known = new Set((baseline.dimensions.consistency.known_violations || []).map((x) => x.key));
  const now = new Set(m.consistency.violations.map((x) => x.key));
  for (const x of m.consistency.violations) {
    if (!known.has(x.key)) { console.error(`✘ [一致性] 新增违规: [${x.rule}] ${x.detail}`); failed = true; }
  }
  for (const key of known) {
    if (!now.has(key)) console.log(`ℹ️  [一致性] 已知违规已修复: ${key} — 请 --write 更新基线（棘轮收紧）`);
  }

  // 3) 可发现性棘轮：报错可操作率不可下降
  const baseRatio = baseline.dimensions.discoverability?.errors_actionable_ratio ?? 0;
  const nowRatio = m.discoverability.errors_actionable_ratio;
  if (nowRatio < baseRatio) {
    console.error(`✘ [可发现性] 报错可操作率退化: ${baseRatio} → ${nowRatio}`);
    failed = true;
  } else if (nowRatio > baseRatio) {
    console.log(`ℹ️  [可发现性] 可操作率提升: ${baseRatio} → ${nowRatio} — 请 --write 更新基线（棘轮收紧）`);
  }

  if (failed) { console.error('\n✘ UX 基线校验失败'); process.exit(1); }
  console.log('✓ UX 基线校验通过（快照零漂移 + 无新增一致性违规）');
  process.exit(0);
}

// 默认：dry-run + 可选 --json
const m = measure();
if (flags.json) console.log(JSON.stringify(m, null, 2));
else printReport(m);
process.exit(0);
