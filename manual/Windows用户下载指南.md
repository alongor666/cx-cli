# Windows 用户下载指南

## 🚀 快速下载（推荐）

### 方式一：GitHub Latest Release（推荐）

**直接下载链接**：
```
https://github.com/alongor666/cx-cli/releases/latest/download/cx-windows-x64.exe
```

ARM64 Windows 请把文件名改为 `cx-windows-arm64.exe`。同一发布页还提供
`manifest.json` 与 `SHA256SUMS`，下载后应先核对 SHA-256。

**操作**：
1. 复制上面的链接到浏览器
2. 同时下载 `SHA256SUMS` 并校验文件哈希
3. 把二进制保存为 `C:\tools\cx\cx.exe`（必须重命名，才能直接运行 `cx`）

---

### 方式二：使用手册下载

**手册包含**：
- 8 页 HTML 使用指南（可直接浏览）
- 自动化截图脚本（Windows PowerShell）
- 详细操作文档

**下载链接**：
```
https://github.com/alongor666/cx-cli/tree/main/manual
```

**国内镜像**：
- GitHub 镜像：https://hub.fastgit.xyz/alongor666/cx-cli/tree/main/manual
- 或使用 Gitee（需手动导入仓库）

**使用方法**：
1. 下载整个 `manual` 文件夹
2. 打开 `manual/index.html` 查看使用指南
3. 运行 `开始截图.bat` 自动截图

---

### 方式三：GitHub Releases 发布页

**官方地址**：
```
https://github.com/alongor666/cx-cli/releases
```

**如果速度慢**，尝试以下镜像：

| 镜像站 | 地址 | 说明 |
|--------|------|------|
| FastGit | https://hub.fastgit.xyz/alongor666/cx-cli/releases | 加速访问 |
| GitHub Proxy | https://mirror.ghproxy.com/https://github.com/alongor666/cx-cli/releases | 代理加速 |

---

## 📦 完整下载清单

### 必需文件
```
cx.exe                     # 从 cx-windows-x64.exe 或 cx-windows-arm64.exe 重命名
SHA256SUMS                 # 发布资产哈希清单
manifest.json              # 版本、源码提交指纹和资产元数据
```

### 可选文件（使用手册）
```
manual/
├── index.html                      # 8 页使用指南 PPT
├── 开始截图.bat                    # 自动化截图启动器
├── capture-screenshots-v2.ps1      # 截图脚本
├── 截图指南.md                     # 详细操作指南
└── 脚本使用说明.md                 # 脚本使用文档
```

---

## 🔧 配置步骤

### 1. 下载并重命名 cx-windows-x64.exe

从上面的官方发布地址下载 `cx-windows-x64.exe`，校验哈希后重命名为 `cx.exe`。

### 2. 创建目录

在 Windows 中：
```
创建文件夹：C:\tools\cx\
```

### 3. 添加到 PATH

1. 按 `Win + S` 搜索"编辑系统环境变量"
2. 点击"环境变量"
3. 在"系统变量"中找到"Path"，点击"编辑"
4. 点击"新建"，输入 `C:\tools\cx`
5. 点击"确定"保存

### 4. 重启命令行

**关闭所有**命令提示符/PowerShell 窗口，重新打开

### 5. 验证安装

```cmd
cx --version
```

应该显示：`1.1.0` 或更高版本号

---

## 🇨🇳 国内镜像说明

### GitHub 加速原理

GitHub 在国内访问较慢，原因是：
- 域名解析慢
- 路由绕路
- 带宽限制

**解决方法**：
- 使用组织批准的 GitHub Release 代理
- 使用代理镜像（如 FastGit）
- 使用 Gitee 等国内平台

### Release 资产与仓库文件不同

`cx-windows-x64.exe` 是 GitHub Release 资产，不在镜像仓库源码目录中。不要把
`cdn.jsdelivr.net/gh/...` 仓库文件链接当作 Release 下载地址；应使用上面的
`releases/latest/download/...` 官方链接或经过组织批准的代理。

### FastGit 镜像

**特点**：
- GitHub 加速镜像
- 实时同步
- 无需注册

**使用方法**：
```
原链接：https://github.com/alongor666/cx-cli

镜像链接：https://hub.fastgit.xyz/alongor666/cx-cli
```

### Gitee 导入

**步骤**：
1. 注册 Gitee 账号：https://gitee.com
2. 点击"从 GitHub / GitLab 导入仓库"
3. 输入 GitHub 仓库地址：`https://github.com/alongor666/cx-cli`
4. 等待导入完成（可能需要几分钟）
5. 从 Gitee 下载文件

---

## ⚡ 下载速度对比

| 方式 | 预计速度 | 预计时间 |
|------|---------|---------|
| **FastGit 镜像** | 1-5 MB/s | 1-5 分钟 |
| **GitHub 直连** | 50-500 KB/s | 10-30 分钟 |
| **Gitee** | 2-10 MB/s | 10-30 秒 |

---

## 🆘 常见问题

### Q1: 下载失败

**问题**：浏览器提示下载失败

**解决**：
1. 尝试其他下载方式（CDN / 镜像）
2. 检查网络连接
3. 更换浏览器（Chrome / Edge）
4. 使用下载工具（IDM / FDM）

### Q2: 文件损坏

**问题**：运行 cx.exe 提示文件损坏

**解决**：
1. 重新下载文件
2. 检查文件大小（应该是 51 MB 左右）
3. 使用 MD5 校验（如果提供）

### Q3: 杀毒软件报警

**问题**：杀毒软件提示病毒

**解决**：
1. 这是误报，可以添加到白名单
2. 或从 GitHub 官方下载（更可信）
3. 查看源码：https://github.com/alongor666/cx-cli

### Q4: 下载速度还是很慢

**问题**：所有方式都慢

**解决**：
1. 更换网络环境（WiFi → 4G/5G）
2. 使用 VPN（如果有）
3. 找同事代下载，通过网盘传输
4. 联系车险数据团队获取离线安装包

---

## 📞 获取帮助

如果下载遇到问题：

1. 查看 [`manual/README.md`](../../tree/main/manual/README.md)
2. 联系车险数据团队
3. 在 GitHub 提 issue：https://github.com/alongor666/cx-cli/issues

---

**祝下载顺利！🎉**

_最后更新：2026-05-27_
