# cx 一键安装（Windows）：下载已发布二进制 → SHA-256 校验 → 原子安装 → cx login → cx mcp install
#
#   irm https://raw.githubusercontent.com/alongor666/cx-cli/main/scripts/install.ps1 | iex
#
# 可选环境变量：CX_VERSION（默认 latest）、CX_BIN_DIR（默认 %LOCALAPPDATA%\Chexian\bin）、
#   CX_MCP_CLIENTS（逗号分隔，默认自动检测）、CX_SKIP_MCP=1（只装 cx）、CX_RELEASE_BASE（下载根地址）
# PAT 只在 `cx login` 的隐藏输入里出现，不经过本脚本、不写进任何 Agent 配置。
# 信任边界：SHA256SUMS 与二进制同源，挡传输损坏，挡不住 release 本身被篡改。
# 升级：重跑本命令。卸载：cx mcp uninstall; cx logout; 删除安装目录下 cx.exe
# 整段包在 & { } 子作用域里：irm | iex 在调用者作用域执行，脚本内改的 $ErrorActionPreference 等
# 变量若写在顶层会永久留在用户会话；子作用域让任何退出路径（正常 / return / throw）都不外溢
& {
  $ErrorActionPreference = 'Stop'

  $repo = 'alongor666/cx-cli'
  $version = if ($env:CX_VERSION) { $env:CX_VERSION } else { 'latest' }
  $binDir = if ($env:CX_BIN_DIR) { $env:CX_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Chexian\bin' }
  # 归一成绝对路径（按 PS 当前位置解析、不做通配）：相对路径下 `& $cx` 会退回带通配的命令搜索
  $binDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($binDir)

  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'ARM64' { 'arm64' }
    'AMD64' { 'x64' }
    default { throw "不支持的 CPU 架构: $($env:PROCESSOR_ARCHITECTURE)" }
  }
  $asset = "cx-windows-$arch.exe"
  $base = if ($env:CX_RELEASE_BASE) { $env:CX_RELEASE_BASE } elseif ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/$version" }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("cx-install-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "下载 $asset（$version）…"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile "$tmp\$asset"

    $line = Get-Content "$tmp\SHA256SUMS" | Where-Object { ($_ -split '\s+')[1] -eq $asset } | Select-Object -First 1
    if (-not $line) { throw "SHA256SUMS 中没有 $asset" }
    $expected = ($line -split '\s+')[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 "$tmp\$asset").Hash.ToLower()
    if ($expected -ne $actual) { throw "SHA-256 不匹配（期望 $expected，实际 $actual），已中止" }
    Write-Host '✔ SHA-256 校验通过'

    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $cx = Join-Path $binDir 'cx.exe'
    # 路径一律按字面处理：CX_BIN_DIR 可能含 [ ] 等通配字符。Cmdlet 用 -LiteralPath；移动文件用
    # [IO.File]::Move——Move-Item 的 -Destination 没有字面版本，仍会先做通配解析
    Remove-Item -Force -LiteralPath "$cx.tmp" -ErrorAction SilentlyContinue
    [IO.File]::Move("$tmp\$asset", "$cx.tmp")
    # Agent 拉起的 cx mcp 常驻时 cx.exe 被占用：Windows 允许重命名运行中的 exe、不允许覆盖，
    # 所以先把旧文件挪成 .old 再放新文件；.old 删不掉（仍在运行）就留到下次安装再清
    if (Test-Path -LiteralPath $cx) {
      # 清掉历次残留的 cx.exe.old / cx.exe.old.<pid>（仍在运行的删不掉，静默跳过、下次再清）
      Get-ChildItem -LiteralPath $binDir -Filter 'cx.exe.old*' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^cx\.exe\.old(\.\d+)?$' } |
        ForEach-Object { Remove-Item -Force -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
      $old = if (Test-Path -LiteralPath "$cx.old") { "$cx.old.$PID" } else { "$cx.old" }  # 上轮 .old 仍被占用时换名
      [IO.File]::Move($cx, $old)
      try { [IO.File]::Move("$cx.tmp", $cx) } catch { [IO.File]::Move($old, $cx); throw }  # 落位失败则还原旧版
      Remove-Item -Force -LiteralPath $old -ErrorAction SilentlyContinue
    } else {
      [IO.File]::Move("$cx.tmp", $cx)
    }
    Write-Host "✔ 已安装 $cx（$(& $cx --version)）"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  if (($env:Path -split ';') -notcontains $binDir) {
    Write-Host "提示：$binDir 不在 PATH（Agent 配置用绝对路径，不受影响）"
  }
  if ($env:CX_SKIP_MCP -eq '1') { return }

  # 以下调用原生命令：Windows PowerShell 5.1 在 Stop 下会把原生命令的 stderr 升级为终止错误，
  # 统一改看 $LASTEXITCODE
  $ErrorActionPreference = 'Continue'

  # 「已登录」只认 ~/.chexian/config.json 里的令牌：Agent 进程不继承当前会话的 CX_PAT
  # 环境变量是进程级（子作用域管不住）：用 finally 恢复，Ctrl+C 中断 whoami 也不会把调用者的 CX_PAT 清掉
  $envPat = $env:CX_PAT; $envBase = $env:CX_BASE_URL
  try {
    Remove-Item Env:CX_PAT, Env:CX_BASE_URL -ErrorAction SilentlyContinue
    & $cx whoami *> $null
    $loggedIn = ($LASTEXITCODE -eq 0)
  } finally {
    if ($null -ne $envPat) { $env:CX_PAT = $envPat }
    if ($null -ne $envBase) { $env:CX_BASE_URL = $envBase }
  }
  if ($loggedIn) {
    Write-Host '✔ 已登录（沿用 ~/.chexian/config.json 中的 PAT）'
  } else {
    Write-Host '请粘贴个人 PAT（网页登录后侧栏「API 令牌」签发；输入不回显）'
    & $cx login
    if ($LASTEXITCODE -ne 0) { throw '登录失败' }
  }

  if ($env:CX_MCP_CLIENTS) { & $cx mcp install --client $env:CX_MCP_CLIENTS } else { & $cx mcp install }
  if ($LASTEXITCODE -ne 0) { throw 'cx mcp install 失败' }
}
