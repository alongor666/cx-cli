# cx — 车险数据只读 CLI

`cx` 是车险数据分析平台的命令行客户端，通过 PAT（Personal Access Token）鉴权，提供保单查询、KPI 查看、SQL 直通等能力。

## Windows 用户（推荐）

**无需安装任何环境，直接下载使用：**

1. 前往 [GitHub Releases](../../releases/latest) 下载 `cx-windows.exe`
2. 将文件移动到任意目录（建议 `C:\tools\cx\`）
3. 将该目录添加到系统 PATH（按 `Win + S` 搜索"编辑系统环境变量" → 环境变量 → Path → 新建）
4. 打开新的命令提示符或 PowerShell，运行：

```cmd
cx login --token cx_pat_xxx.yyy
cx whoami
```

---

## 快速开始（开发者 / 有 Node.js）

### 安装

```bash
# 方式一：npm 全局安装（推荐）
npm i -g @chexian/cli

# 方式二：免安装直接用
npx @chexian/cli@latest --help
```

要求 Node.js >= 18。

### 登录

```bash
# 交互式输入 PAT（输入时隐藏）
cx login

# 或直接传 token
cx login --token cx_pat_xxx.yyy

# 自定义后端地址（内网/测试环境）
cx login --token cx_pat_xxx.yyy --base-url https://your-server.example.com
```

PAT 由管理员在 Web UI 生成，格式为 `cx_pat_xxx.yyy`。

### 基本使用

```bash
# 查看当前身份
cx whoami

# 列出所有可用查询路由
cx routes
cx routes --tag kpi

# 查询 KPI
cx query KPI --year=2026
cx query KPI --year=2026 --org_level_3=分公司A --format json

# 查看字段注册表
cx fields
cx fields --groupable          # 只列出可分组字段

# 查看指标注册表
cx metrics
cx metrics --category ratio    # 按分类过滤

# 查看筛选器预设
cx presets

# DuckDB SQL 直通（只读）
cx sql "SELECT 三级机构, SUM(保费) AS 总保费 FROM PolicyFact WHERE year=2026 GROUP BY 1"
cx sql "SELECT customer_category, COUNT(*) c FROM PolicyFact GROUP BY 1" -f csv

# 登出
cx logout
```

### 输出格式

所有查询命令支持 `-f` / `--format` 参数：

| 格式 | 说明 |
|------|------|
| `table` | 彩色表格（默认，TTY 时） |
| `json` | JSON 数组/对象 |
| `csv` | 逗号分隔值 |

### 环境变量

| 变量 | 说明 |
|------|------|
| `CX_PAT` | PAT token，优先于配置文件 |
| `CX_BASE_URL` | 后端地址，优先于配置文件 |

## 命令一览

| 命令 | 说明 |
|------|------|
| `cx login` | 保存 PAT 到 `~/.chexian/config.json` |
| `cx logout` | 清除本地 PAT |
| `cx whoami` | 显示当前用户与角色 |
| `cx routes` | 列出所有可用查询路由 |
| `cx query <key>` | 调用查询路由 |
| `cx fields` | 列出字段注册表（42 个字段） |
| `cx metrics` | 列出指标注册表（25 个指标） |
| `cx presets` | 列出筛选器 schema 与车型预设 |
| `cx sql "<query>"` | DuckDB SELECT 直通 |

## 安全说明

- PAT 保存在 `~/.chexian/config.json`，文件权限自动设为 600（仅当前用户可读）。
- CLI 强制只读：仅调用 GET 接口，不支持任何写入操作。
- 权限完全继承 PAT 关联用户（allowedRoutes / dataScope / organization），由服务端 RLS 控制。

## 从源码构建

```bash
git clone https://github.com/alongor666/cx-cli.git
cd cx-cli
npm install
npm run build          # 编译到 dist/
node dist/index.js --help
```

## License

MIT
