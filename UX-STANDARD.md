# cx CLI 用户体验黄金标准

> `perf-baseline.json` 钉「快不快」，本标准钉「好不好用」。
> 可执行规范：[`scripts/ux-baseline.mjs`](scripts/ux-baseline.mjs) + 基线 [`ux-baseline.json`](ux-baseline.json)。
> 与 `bench:check` 对称——任何 PR 都能 `bun run ux:check` 验 UX 不退化。

## 跑法

```bash
bun run ux           # dry-run：跑一遍打人类报告，不写文件
bun run ux:write     # 建立 / 更新黄金基线（含离线三维）
bun run ux:write -- --journey   # 附带 live 旅程测量（需有效 PAT + 可达 server）
bun run ux:check     # 对照基线：渲染快照零漂移 + 无新增一致性违规 + 可发现性不退化 → 否则 exit 1
```

CI 闸：[`.github/workflows/cli-ux-sentinel.yml`](../.github/workflows/cli-ux-sentinel.yml)（`cli/**` 变更触发，跑 `ux:check`），与 `cli-perf-sentinel`（守"快不快"）对称。基线以 runner=tsx 采集，CI 同样用 tsx 跑以匹配。

## 四维

| 维度 | 钉什么 | oracle | 闸 |
|------|--------|--------|----|
| ① 一致性 | 跨命令退出码契约 / 报错前缀 / 帮助可达 | lint 规则 R1–R5 | 棘轮：不可新增违规 |
| ② 渲染 | 用户真正看到的字面（帮助 + 报错/离线输出） | 黄金快照逐字节 | 零漂移 |
| ③ 旅程 | 装→login→whoami→首次成功 query 的 time-to-first-success | live 功能门禁 + 计时 | 两步均 exit 0；计时记录不硬闸（网络噪声） |
| ④ 可发现性 | 报错是否给可操作下一步 | 报错可操作率 | 棘轮：比率不可下降 |

## 一致性规则（R1–R5）

| 规则 | 要求 |
|------|------|
| R1 | 每个子命令出现在根帮助 Commands 区 |
| R2 | 每个 `cx <cmd> --help` 退出码为 0 |
| R3 | 无 PAT 的鉴权失败统一 **exit 2**（带可操作提示 `Run: cx login`） |
| R4 | 用法错误（缺参数 / 缺子命令 / 未知命令）统一 **exit 4** |
| R5 | 错误信息统一以 `✘ ` 前缀打到 stderr（`failWith` 出口） |

退出码契约：`0` 成功 · `1` 通用/服务端 · `2` 鉴权失败 · `3` 权限不足 · `4` 用法错误 · `5` 限流（见 [`src/exit-codes.ts`](src/exit-codes.ts)）。

## 棘轮模型

一致性违规与可发现性比率存入基线作为「已知债务」。`ux:check` 只对**变坏**失败（新增违规 / 比率下降），不强求一次清零。修好一条债务后 `ux:write` 更新基线收紧——标准只进不退。

## 债务清零史（首次基线 → 棘轮收紧）

首次基线发现 `commander` 内置参数/命令校验**绕过 `failWith` 退出码契约**：`cx completion`（缺参数）/ `cx data`（缺子命令）/ `cx foobar`（未知命令）返回 `exit 1`（应 4）且用 `error:` 前缀（应 `✘ `）——违反 R4+R5 共 6 条，报错可操作率 50%。

**已修复**（[`src/index.ts`](src/index.ts) `applyExitContract`）：递归给所有命令挂 `exitOverride`，把内置错误重渲染为 `✘ ` + 可操作提示（`运行 cx --help …`），顶层 catch 按 commander 错误码映射——帮助/版本 → exit 0，用法错误 → exit 4。帮助走 stdout 不受影响，help 快照零漂移。

→ 现状：**0 条一致性违规**，报错可操作率 **100%**（6/6）。棘轮已收紧到干净，后续任何回退 `ux:check` 即拦。

## 维度状态

- ① 一致性 · ② 渲染 · ④ 可发现性：**已建基线、`ux:check` 可复现（0 diff）**
- ③ 旅程：**已测**（首次成功 ✓，2 步：whoami + 首次 query）。⚠️ time-to-first-success 计时 **CV 高**（冷连接 TLS 离群，p50≈850ms / p95 可达 10s+）——故设计上**只记录不硬闸**，仅功能门禁（首次成功与否）参与判定，计时数字仅供参考
