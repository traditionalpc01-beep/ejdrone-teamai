#Requires -Version 5
<#
=====================================================================
 ejdrone-teamai 一键安装脚本（Windows / 非开发角色）
=====================================================================
【用途】
  在没有 Node.js、没有 git 的 Windows 机器上装好 ejdrone-teamai：
  - 便携 Node 解压到 %USERPROFILE%\.ejdrone\runtime\node-v<版本>\（不动系统）
  - CLI 装进 %USERPROFILE%\.ejdrone\npm-global\（独立 npmrc，不碰系统 Node 与 ~/.npmrc）
  - 提供了 -CodeupToken 时写入用户级环境变量 EJDRONE_CODEUP_TOKEN
  - 执行 ejdrone init 完成首次同步，并在桌面创建「ejdrone 同步.cmd」
  幂等可重跑：已装且 ≥ 20 的 Node 直接复用、已下载的便携 Node 跳过下载、
  PATH 追加前查重。

【管理员发布前要烤的默认值】（直接改下面 param() 里的默认值）
  - $RepoUrl      团队资产仓地址（必改）
  - $Role         角色 id；建议烤进（成员少答一题），留空则 init 交互问一次
  - $Agents       工具 id 列表（如 'qoder-cn,claude'）；留空则 init 自动探测已装工具
  - $NpmToken     云效制品库只读 npm 凭据；留空要求 registry 允许匿名拉取
  - $CodeupToken  只读代码权限的云效个人访问令牌；Codeup 仓「企业内成员可读」时留空
  - $NodeVersion  便携 Node 版本，随 LTS 轮换；不同版本落不同目录，互不干扰
  - $Proxy        下载 Node 用的代理（如 http://127.0.0.1:7897），一般留空

【成员用法】
  管理员已托管脚本时，打开「开始菜单 → Windows PowerShell」执行一行：
    powershell -c "irm <托管地址>/ejdrone-setup.ps1 | iex"
  或把 ejdrone-setup.ps1 与 ejdrone-setup.cmd 下载到同一目录后：
  双击 ejdrone-setup.cmd，或右键 ejdrone-setup.ps1 选「使用 PowerShell 运行」。

【卸载 / 回滚（三步，只删本安装器建的四处内容）】
  1) npm 卸载（如需同时撤掉已投递到各 AI 工具目录的内容，先执行 ejdrone uninstall）：
       npm uninstall -g ejdrone-teamai --userconfig %USERPROFILE%\.ejdrone\npmrc
  2) 逐个删除下面四个位置（%USERPROFILE%\.ejdrone 下的 config.yaml、repo、knowledge
     等是业务数据，不要一起删）：
       %USERPROFILE%\.ejdrone\runtime
       %USERPROFILE%\.ejdrone\npm-global
       %USERPROFILE%\.ejdrone\npmrc
       桌面 \ ejdrone 同步.cmd
  3) 用户环境清理：从用户 PATH 移除 .ejdrone\runtime\node-v<版本> 与 .ejdrone\npm-global
     两个目录；删除用户环境变量 EJDRONE_CODEUP_TOKEN（如设置过）。

【安全】令牌只写入 npmrc 与用户环境变量两处，本脚本不回显令牌值。
=====================================================================
#>
param(
    [string]$RepoUrl = 'https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git',
    [string]$Role = '',
    [string]$Agents = '',
    [string]$Registry = 'https://packages.aliyun.com/64084f5656067d3aad3e0d11/npm/npm-registry/',
    [string]$NpmToken = '',
    [string]$CodeupToken = '',
    [string]$NodeVersion = '20.18.1',
    [string]$Proxy = ''
)

# PS5.1 下 Invoke-WebRequest 的进度条会把大文件下载拖慢一个数量级，关掉
$ProgressPreference = 'SilentlyContinue'

$EjHome     = Join-Path $env:USERPROFILE '.ejdrone'
$RuntimeDir = Join-Path $EjHome 'runtime'
$NodeDir    = Join-Path $RuntimeDir "node-v$NodeVersion"
$NpmGlobal  = Join-Path $EjHome 'npm-global'
$NpmrcPath  = Join-Path $EjHome 'npmrc'
$EjdroneCmd = Join-Path $NpmGlobal 'ejdrone.cmd'

function Fail([int]$StepNo, [string]$Message, [string]$Hint) {
    Write-Host ''
    Write-Host "[X] 第 $StepNo 步失败：$Message" -ForegroundColor Red
    if ($Hint) { Write-Host "    下一步：$Hint" -ForegroundColor Yellow }
    Write-Host '    请把本窗口内容截图发给管理员。'
    exit $StepNo
}

function Normalize-Dir([string]$DirPath) {
    return $DirPath.Trim().TrimEnd('\').Replace('/', '\').ToLower()
}

Write-Host 'ejdrone-teamai 一键安装（可重复运行，已装好的部分会直接复用）' -ForegroundColor Cyan

# ---------- [1/6] TLS / Node ----------
Write-Host ''
Write-Host '[1/6] 检查网络与 Node.js 环境'
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    Fail 1 '设置 TLS 1.2 失败（系统过旧）' '确认系统为 Windows 10 / Windows Server 2016 及以上。'
}

# WindowsApps 里可能有微软商店的 node 占位 stub（执行会弹商店或卡死），排除
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -and ($_.Source -notmatch 'WindowsApps') } |
    Select-Object -First 1

$reuseNode = $false
if ($nodeCmd) {
    $raw = ''
    try {
        $lines = & $nodeCmd.Source -v 2>$null
        $raw = [string]($lines | Select-Object -First 1)
    } catch { $raw = '' }
    $raw = $raw.Trim()
    if ($raw -match '^v?(\d+)') {
        $major = [int]$Matches[1]
        if ($major -ge 20) {
            $reuseNode = $true
            Write-Host "      已检测到 Node $raw（不低于 20），直接复用，不改动现有环境"
        } else {
            Write-Host "      检测到 Node $raw（低于 20）：不动它，另装一份便携版到 ~/.ejdrone"
            Write-Host '      建议之后把旧 Node 从 PATH 移除或升级（不影响本次安装）'
        }
    }
}

if (-not $reuseNode) {
    if (Test-Path (Join-Path $NodeDir 'node.exe')) {
        Write-Host "      复用已下载的便携 Node：$NodeDir"
    } else {
        Write-Host "      没有可用的 Node.js（需 20 以上），下载便携版 v$NodeVersion（约 30 MB，只放进 ~/.ejdrone，不动系统）"
        New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
        $zipPath = Join-Path $RuntimeDir "node-v$NodeVersion-win-x64.zip"
        $dlUrl   = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
        try {
            $iwrArgs = @{ Uri = $dlUrl; OutFile = $zipPath; UseBasicParsing = $true; ErrorAction = 'Stop' }
            if ($Proxy) { $iwrArgs['Proxy'] = $Proxy }
            Invoke-WebRequest @iwrArgs
        } catch {
            Fail 1 "Node.js 下载失败：$($_.Exception.Message)" '检查网络能否访问 nodejs.org；内网成员让管理员在脚本里配好 -Proxy 后重新分发。'
        }
        if (-not (Test-Path $zipPath)) {
            Fail 1 'Node.js 下载失败：目标文件不存在' '检查网络或代理设置后重跑本脚本。'
        }
        $inner = Join-Path $RuntimeDir "node-v$NodeVersion-win-x64"
        if (Test-Path $inner)   { Remove-Item $inner   -Recurse -Force }
        if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
        try {
            Expand-Archive -Path $zipPath -DestinationPath $RuntimeDir -Force -ErrorAction Stop
        } catch {
            Fail 1 "Node.js 解压失败：$($_.Exception.Message)" '直接重跑一次本脚本；仍失败把报错截图发给管理员。'
        }
        if (-not (Test-Path $inner)) {
            Fail 1 '解压产物与预期不符' '把本窗口截图发给管理员。'
        }
        Move-Item -Path $inner -Destination $NodeDir -Force
        Remove-Item $zipPath -Force
        Write-Host "      便携 Node 已就位：$NodeDir"
    }
}

# 后续统一用确定路径调用 npm / ejdrone，不依赖 PATH 顺序
$NpmCmd = $null
$portableNpm = Join-Path $NodeDir 'npm.cmd'
if (Test-Path $portableNpm) {
    $NpmCmd = $portableNpm
} else {
    $npmFound = Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npmFound) { $NpmCmd = $npmFound.Source }
}
if (-not $NpmCmd) {
    Fail 1 '找不到 npm' '本机 Node 安装不完整，把本窗口截图发给管理员。'
}

# ---------- [2/6] npm 布局 ----------
Write-Host ''
Write-Host '[2/6] 配置 npm（独立配置文件与全局目录，不碰 ~/.npmrc）'
New-Item -ItemType Directory -Force -Path $NpmGlobal | Out-Null

$regTrim = $Registry.Trim().TrimEnd('/')
$npmrcLines = @(
    ('prefix=' + ($NpmGlobal -replace '\\', '/')),
    ('registry=' + $regTrim)
)
if ($NpmToken) {
    # npm 的 auth 行形如 //packages.aliyun.com/<org>/npm/npm-registry/:_authToken=…（双斜杠开头）
    $authKey = '//' + ($regTrim -replace '^https?://', '') + '/'
    $npmrcLines += "${authKey}:_authToken=$NpmToken"
}
try {
    Set-Content -Path $NpmrcPath -Value $npmrcLines -Encoding ASCII -ErrorAction Stop
} catch {
    Fail 2 "npmrc 写入失败：$($_.Exception.Message)" "确认目录 $EjHome 可写后重跑。"
}
Write-Host "      npmrc → $NpmrcPath"

# 用户 PATH 幂等追加（npm-global；有便携 Node 时再加运行时目录），追加前查重
$pathTargets = @($NpmGlobal)
if (Test-Path (Join-Path $NodeDir 'node.exe')) { $pathTargets += $NodeDir }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$existingNorm = @($userPath.Split(';') | Where-Object { $_ -and $_.Trim() } | ForEach-Object { Normalize-Dir $_ })
$missing = @()
foreach ($t in ($pathTargets | Select-Object -Unique)) {
    if ($existingNorm -notcontains (Normalize-Dir $t)) { $missing += $t }
}
if ($missing.Count -gt 0) {
    $base = $userPath.Trim().TrimEnd(';')
    if ($base) { $newUserPath = $base + ';' + ($missing -join ';') } else { $newUserPath = $missing -join ';' }
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    # 当前会话放到最前：机器上若有旧版 node，保证本脚本后续调用的 ejdrone 用上便携版
    $env:Path = ($missing -join ';') + ';' + $env:Path
    Write-Host ('      用户 PATH 已追加：' + ($missing -join ' ; '))
    Write-Host '      新开的终端才会用到新 PATH；本脚本内部不依赖它。'
} else {
    Write-Host '      用户 PATH 已包含所需目录，无需改动'
}

# ---------- [3/6] 安装 CLI ----------
Write-Host ''
Write-Host '[3/6] 安装 ejdrone-teamai（最新版）'
Write-Host "      npm 源：$regTrim"
& $NpmCmd install -g ejdrone-teamai@latest "--userconfig=$NpmrcPath"
if ($LASTEXITCODE -ne 0) {
    Fail 3 "npm install 失败（退出码 $LASTEXITCODE）" '常见原因：制品库凭据缺失或过期（401 / E403）、网络不通。把上方输出发给管理员。'
}
if (-not (Test-Path $EjdroneCmd)) {
    Fail 3 "安装命令成功但找不到 $EjdroneCmd" '把本窗口截图发给管理员。'
}
$verLine = ''
try {
    $vOut = & $EjdroneCmd --version 2>$null
    $verLine = [string]($vOut | Select-Object -First 1)
} catch { $verLine = '' }
Write-Host "      安装成功：ejdrone $($verLine.Trim())"

# ---------- [4/6] Codeup 令牌 ----------
Write-Host ''
Write-Host '[4/6] 配置 Codeup 访问令牌（EJDRONE_CODEUP_TOKEN）'
if ($CodeupToken) {
    [Environment]::SetEnvironmentVariable('EJDRONE_CODEUP_TOKEN', $CodeupToken, 'User')
    $env:EJDRONE_CODEUP_TOKEN = $CodeupToken   # 当前会话立即生效，供下一步 init 使用
    # 读回校验：HKCU\Environment 注册表键可能被企业精简镜像删除，此时 Set 写成的是
    # 进程临时值、退出即蒸发，而脚本却打印「已写入」——必须当场戳穿这个假成功
    $verify = [Environment]::GetEnvironmentVariable('EJDRONE_CODEUP_TOKEN', 'User')
    if ($verify -ne $CodeupToken) {
        Fail 4 '用户环境变量写入后读回不一致（HKCU\Environment 注册表键可能被组策略删除）' '请管理员手动为本机设置用户级环境变量 EJDRONE_CODEUP_TOKEN 后重跑本脚本（可先省略 -CodeupToken）。'
    }
    Write-Host '      已写入用户环境变量 EJDRONE_CODEUP_TOKEN（写入后读回校验通过，令牌值不回显）'
    Write-Host '      其他已打开的终端要新开窗口才能读到；本安装窗口内已生效。'
} else {
    Write-Host '      未提供 -CodeupToken，跳过（Codeup 仓库「企业内成员可读」时不需要）'
}

# ---------- [5/6] init ----------
Write-Host ''
$configYaml = Join-Path $EjHome 'config.yaml'
if (Test-Path $configYaml) {
    # 已初始化过（典型：升级重跑）——跳过 init，成员装完后自己改的工具/角色/标签订阅
    # 不被清洗。要重选就明确跑：ejdrone init <repo> --force
    Write-Host '[5/6] 已初始化过（config.yaml 存在），跳过 init 以保留本机的工具/角色选择'
    Write-Host '      如需重选：ejdrone init <仓库地址> --force（会覆盖现有选择）'
} else {
    Write-Host '[5/6] 初始化：选定工具与角色，完成首次同步'
    $initArgs = @('init', $RepoUrl)
    if ($Role)   { $initArgs += @('--role', $Role) }
    if ($Agents) { $initArgs += @('--agent', $Agents) }
    # 角色与工具都烤好了才加 --force（零问答首跑）；只烤一半时让 init 交互补齐另一半
    if ($Role -and $Agents) { $initArgs += '--force' }
    if (-not $Role -or -not $Agents) {
        Write-Host '      过程中若出现选择提示（在用的 AI 工具、角色），按提示选择即可；'
        Write-Host '      角色选项带中文说明，不确定就选「先跳过」，之后随时能改。'
    }
    Write-Host '      若提示没有探测到 AI 工具：先安装并打开一次你在用的 AI 工具，再重跑本脚本。'
    & $EjdroneCmd @initArgs
    $initCode = $LASTEXITCODE
    if ($initCode -ne 0) {
        Fail 5 "ejdrone init 失败（退出码 $initCode）" '常见原因：仓库地址不对、令牌缺失或过期、网络不通、或本机还没装任何 AI 工具（先装好再重跑）。把上方输出发给管理员。'
    }
}
Write-Host ''
Write-Host '      体检结果（ejdrone doctor）：'
& $EjdroneCmd doctor
Write-Host ''
Write-Host '      日常无需再操作：AI 会话启动时会自动同步（自动同步需 Git for Windows，'
Write-Host '      未安装时 doctor 会点名，改用桌面「ejdrone 同步」手动同步即可）。'

# ---------- [6/6] 桌面同步入口 ----------
Write-Host ''
Write-Host '[6/6] 创建桌面手动同步入口（ejdrone 同步.cmd）'
try {
    $desktop  = [Environment]::GetFolderPath('Desktop')
    $syncPath = Join-Path $desktop 'ejdrone 同步.cmd'
    # 内容只用 ASCII 与 %USERPROFILE%（cmd 变量，不转义），换行交给 Set-Content 写成 CRLF
    $syncLines = @(
        '@echo off',
        '"%USERPROFILE%\.ejdrone\npm-global\ejdrone.cmd" pull',
        'echo.',
        'pause'
    )
    Set-Content -Path $syncPath -Value $syncLines -Encoding ASCII -ErrorAction Stop
    Write-Host "      已创建：$syncPath"
} catch {
    Write-Host "      桌面入口创建失败（不影响安装本身）：$($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host '  - 新开一个终端（或重启 AI 工具）后 PATH 与令牌对它们可见；本窗口内 ejdrone 已可用。'
exit 0
