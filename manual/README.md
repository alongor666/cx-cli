# cx-cli 内部使用手册

## 文件说明

- `index.html` — 主 PPT 文件（单文件 HTML，横向翻页）
- `images/` — 截图目录（当前为占位符，需替换）
- `截图指南.md` — Windows 10 张截图的详细操作指南（与实际 CLI 完全匹配）
- `README.md` — 本文件

## 快速开始

### 🚀 方式一：自动化截图（推荐）⭐

**适合人群**：Windows 用户，希望快速完成截图

**操作步骤**：
1. 终端先运行 `cx login`（交互式 masked PAT 输入；脚本不要求改 `$PAT_TOKEN` — 安全约定 PR #669）
2. 双击 `开始截图.bat`（或右键 `capture-screenshots-v2.ps1` → 使用 PowerShell 运行）
3. 按脚本提示按回车键；登录页用占位 PAT 演示（不会清你的真登录态），其余命令真跑并截图
4. 完成后在浏览器打开 `index.html` 验证效果

**预计时间**：5-10 分钟

**详细说明**：查看 `脚本使用说明.md`

---

### 📷 方式二：手动截图

**适合人群**：希望完全控制截图过程

**操作步骤**：
1. 按照 `截图指南.md` 的 21 章节详细说明
2. 在 Windows 上手动执行 10 个命令
3. 使用截图工具（Win+Shift+S）截取命令行窗口
4. 将截图保存到 `images/` 目录，替换占位符

**预计时间**：15-20 分钟

---

### 🖥️ 方式三：浏览器预览（无需截图）

直接在浏览器中打开 `index.html` 查看效果（占位符图片）

```bash
open index.html        # macOS
start index.html       # Windows
xdg-open index.html    # Linux
```

**操作方式**：
- **翻页**：左右方向键、滚轮、触屏滑动、底部圆点
- **全屏**：`F11`（Windows）/ `Cmd+Ctrl+F`（Mac）
- **退出**：`ESC` 键

---

### 📄 导出 PDF

在浏览器中按 `Cmd+P`（Mac）或 `Ctrl+P`（Windows），选择"保存为 PDF"。

## 设计说明

- **主题**：🌊 靛蓝瓷（科技/数据风格）
- **底色**：全 dark 模式（截图页为 light，确保清晰）
- **字体**：衬线标题（Noto Serif SC）+ 非衬线正文（Noto Sans SC）+ 等宽元数据（IBM Plex Mono）
- **风格**：电子杂志 × 电子墨水，横向翻页，WebGL 背景

## 页面结构

| 页码 | 标题 | 内容 | 占位符 |
|------|------|------|--------|
| 01 | 封面 | cx 命令行工具 | 无 |
| 02 | 产品定位 | 系统介绍 | 架构图 |
| 03 | 下载安装 | Windows 三步走 | PATH 设置、版本验证 |
| 04 | 首次登录 | PAT 鉴权流程 | 登录命令、whoami 输出 |
| 05 | 常用命令 | routes/query/fields/metrics | 4 个命令截图 |
| 06 | SQL 直通 | DuckDB 引擎 | SQL 查询截图 |
| 07 | 常见问题 | 故障排除 | 无 |
| 08 | 附录 | 完整命令列表 | 无 |

## 技术细节

- **单文件**：所有 CSS、JS、字体引用都内嵌在 HTML 中
- **离线可用**：字体走 Google Fonts CDN，断网时 fallback 到系统字体
- **响应式**：适配 16:9 屏幕（1920x1080 及以上）
- **动画**：Motion One 驱动，翻页时淡入效果

## 生成工具

本手册由 [`magazine-web-ppt`](https://github.com/yourusername/magazine-web-ppt) skill 生成。

---

**车险数据团队 · 内部使用 · v1.0**
