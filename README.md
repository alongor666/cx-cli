# @chexian/cli — cx

chexian-api 只读命令行客户端。PAT（个人访问令牌）鉴权，权限完全继承令牌关联用户（数据范围 / 可访问路由），服务端架构层强制只读（任何 POST/PUT/DELETE 一律 403）。

## 安装与登录

```bash
# 仓库内开发运行
cd cli && bun install
bunx tsx src/index.ts --help

# 构建后以 cx 运行
bun run build && bun link

cx login                     # 交互式输入 PAT（或 --token cx_pat_xxx.yyy）
cx whoami                    # 验证身份与数据范围
```

PAT 在 Web 端「设置 → 访问令牌」生成。配置存 `~/.chexian/config.json`（chmod 600）。

## 命令总览

| 命令 | 说明 |
|---|---|
| `cx login` / `cx logout` | 保存 / 清除本地 PAT |
| `cx whoami [-f json]` | 当前用户、角色、数据范围、tokenId、baseUrl（不输出 PAT） |
| `cx capabilities` | 服务端登记的远程分析能力、参数 schema、固定参数、时间口径和目标领域 |
| `cx analyze <capability>` | 执行登记的远程聚合分析；多省账号必须显式指定 `--targetBranch`；`--evidence` 输出 skills 证据包 |
| `cx routes [--tag t] [--search kw] [--refresh]` | 列出全部查询路由（按 tag 分组；24h 本地缓存；含 timeWindow 时间口径列：window 任意窗口 / rolling 近 N 天 / policy-year 保单年度切片 / ytd-progress 年度计划进度 / cohort-development 批次发展 / snapshot 状态快照） |
| `cx query <key\|path> [--参数=值 ...]` | 调用查询路由（核心命令，见下） |
| `cx sql "<SELECT...>"` / `cx sql -` | DuckDB SQL 直通（强制聚合 + 行级权限自动注入；`-` 读 stdin） |
| `cx fields [--groupable]` | 字段注册表（含 PolicyFact 可查真值 column/queryable） |
| `cx metrics [--category c]` | 指标注册表 |
| `cx describe <relation>` | 自省视图 schema（列名/类型；联邦白名单内 PolicyFact / 派生视图） |
| `cx cube --metric=<id> [--dims=d1,d2]` | 语义层「指标 × 任意维度子集」可组合查询（续保族需 --start/--end/--cutoff） |
| `cx presets` | 筛选器 schema 与车型快捷预设 |
| `cx filters [--dimension d]` | 各筛选维度的可选值 |
| `cx data <version\|files\|metadata>` | 数据新鲜度 / 文件清单 / 数据集元数据 |
| `cx health` | 连通性诊断（服务存活 + 数据版本 + 延迟） |
| `cx batch [--concurrency n] [--summary]` | stdin 读 JSONL 批量调用（keep-alive 连接复用） |
| `cx config <get\|set\|unset\|list\|path>` | 本地配置管理（白名单：baseUrl） |
| `cx completion <bash\|zsh>` | 生成 shell 补全脚本（清单从命令注册运行时派生） |

## cx query 的三种寻址

```bash
cx query KPI --year=2026                  # 1) catalog key（大小写/中划线宽容：kpi、claims-detail-heatmap 均可）
cx query /kpi --year=2026                 # 2) catalog 登记的 path
cx query /repair/overview                 # 3) 任意 / 开头 path 直通（不依赖 catalog，服务端仍鉴权）
```

常用选项：`--format table|json|csv`（非终端默认 json）· `--limit n`（客户端截断）· `--timeout ms`。

## 全局选项

| 选项 | 说明 |
|---|---|
| `--format / -f` | 输出格式 table / json / csv（各命令一致；终端默认 table，管道默认 json） |
| `--no-color` | 禁用彩色（也尊重 `NO_COLOR` 环境变量） |
| `--quiet / -q` | 抑制提示性 stderr 输出（错误仍打印） |
| `--verbose` | stderr 打印请求 URL 与耗时 |

## 退出码契约

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 通用 / 服务端 / 网络错误 |
| 2 | 鉴权失败（PAT 缺失 / 失效，运行 `cx login`） |
| 3 | 权限不足（路由或数据范围受限） |
| 4 | 用法 / 参数错误 |
| 5 | 限流（429 重试后仍失败） |

## 管道与脚本示例

```bash
cx query KPI --year=2026 --format=json | jq '.[0]'
cx analyze operating-trend --startDate=2026-01-01 --endDate=2026-01-31 --targetBranch=SX
cx analyze agent-earned-loss-frequency --startDate=2026-01-01 --endDate=2026-12-31 \
  --dateField=policy_date --agentNames=中国邮政集团有限公司山西省分公司 \
  --targetBranch=SX --evidence --format=json
cx query TREND --granularity=week --format=csv > trend.csv
echo "SELECT org_level_3, SUM(premium) p FROM PolicyFact GROUP BY 1 ORDER BY p DESC" | cx sql -
cx routes --format=json | jq -r '.[].key'
cx data version --format=json | jq -r '.data_date // .date'
if ! cx health -q; then echo "服务异常"; fi
```

## 配置优先级

`CX_BASE_URL` / `CX_PAT` 环境变量 > `~/.chexian/config.json` > 默认 `https://chexian.cretvalu.com`。

CI / 脚本场景建议全程环境变量，不落盘：

```bash
CX_BASE_URL=http://localhost:3000 CX_PAT=cx_pat_xxx.yyy cx query KPI
```

## 能力边界（设计约束）

- **只读**：服务端 `readonlyMiddleware` 架构层拦截，CLI 无任何写操作
- **AI 问答（NL2SQL）与 PAT 自助管理**：需要会话登录，请使用 Web 端
- 路由能力由服务端 `route-catalog` 唯一事实源驱动，服务端新增查询路由后 CLI 自动可用：`cx query <新路由>` 在本地缓存未命中时会自动强制刷新缓存重试一次（无需手动 `cx routes --refresh`，缓存 TTL 24h）

详见 `开发文档/PAT_GUIDE.md`。

## 独立仓库镜像（alongor666/cx-cli）

本子目录是 SSOT，[`alongor666/cx-cli`](https://github.com/alongor666/cx-cli) 是从此自动同步的**只读镜像**。Windows 用户下载文档 / 截图脚本 / `index.html` 在 `manual/` 子目录。

**同步机制**：[`.github/workflows/sync-cx-cli.yml`](../.github/workflows/sync-cx-cli.yml) 监听 `main` 分支 `cli/**` 路径变更，自动 squash 同步到 `cx-cli` main。`manual/` 也走该流水线。

**不要直接改 cx-cli 仓库** — 任何改动会被下次同步覆盖。所有 PR 走 `alongor666/chexian-api`。

**镜像延迟**：PR 合并到 chexian-api main 后约 1-3 分钟出现在 cx-cli main（受 GitHub Actions 排队时间影响）。`gh run watch` 在 chexian-api 看 `Sync cli to cx-cli` workflow。

**首次设置**：需 user 创 PAT + 配 secret，见 workflow 文件顶部注释 step 1-2。
