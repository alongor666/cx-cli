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

**如果速度慢**：只使用组织批准的代理，**不要使用来路不明的第三方镜像站**。无论从哪里下载二进制，
`SHA256SUMS` 都必须从上面的 github.com 官方地址获取并核对——若二进制与哈希清单来自同一个第三方站点，
校验就失去了意义。

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

> **推荐**：直接用一键安装脚本（自动下载、校验 SHA-256、安装到 `%LOCALAPPDATA%\Chexian\bin`，无需管理员权限）：
> `irm https://raw.githubusercontent.com/alongor666/cx-cli/main/scripts/install.ps1 | iex`
> 以下为手动安装步骤；两种方式选其一，避免机器上出现两份 cx.exe。

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
3. 在"用户变量"中找到"Path"，点击"编辑"（改用户变量无需管理员权限）
4. 点击"新建"，输入 `C:\tools\cx`
5. 点击"确定"保存

### 4. 重启命令行

**关闭所有**命令提示符/PowerShell 窗口，重新打开

### 5. 验证安装

```cmd
cx --version
```

应该显示：与 [Releases](https://github.com/alongor666/cx-cli/releases) 最新版本一致的版本号

---

## 🇨🇳 国内镜像说明

### GitHub 加速原理

GitHub 在国内访问较慢，原因是：
- 域名解析慢
- 路由绕路
- 带宽限制

**解决方法**：
- 使用组织批准的 GitHub Release 代理（下载后务必用官方 `SHA256SUMS` 校验）
- 找同事代下载后通过内部网盘传输（同样校验 SHA-256）

### Release 资产与仓库文件不同

`cx-windows-x64.exe` 是 GitHub Release 资产，不在镜像仓库源码目录中。不要把
`cdn.jsdelivr.net/gh/...` 仓库文件链接当作 Release 下载地址；应使用上面的
`releases/latest/download/...` 官方链接或经过组织批准的代理。

> 注意：Gitee 等平台"导入仓库"只会复制源码，**不包含 Release 里的 exe**；第三方镜像站（如已停止服务的
> FastGit）无法保证内容未被篡改，不要使用。

---

## 🆘 常见问题

### Q1: 下载失败

**问题**：浏览器提示下载失败

**解决**：
1. 使用组织批准的代理，或找同事代下载
2. 检查网络连接
3. 更换浏览器（Chrome / Edge）
4. 使用下载工具（IDM / FDM）

### Q2: 文件损坏

**问题**：运行 cx.exe 提示文件损坏

**解决**：
1. 重新下载文件（x64 版约 95–100 MB，大小明显偏小说明没下完）
2. 用官方 `SHA256SUMS` 核对哈希：
   ```powershell
   Get-FileHash .\cx-windows-x64.exe -Algorithm SHA256
   ```
   输出的 Hash 须与 `SHA256SUMS` 中 `cx-windows-x64.exe` 那一行完全一致（发布不提供 MD5）

### Q3: 杀毒软件报警

**问题**：杀毒软件提示病毒

**解决**：
1. **不要直接加白名单**。先确认文件来自 github.com 官方 Release，且 SHA-256 与官方 `SHA256SUMS` 一致
2. 哈希一致时，未签名的单文件程序被启发式引擎误报较常见，可联系车险数据团队确认后再放行
3. 哈希不一致：立即删除该文件，不要运行

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
