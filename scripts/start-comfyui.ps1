#requires -Version 5.1
<#
.SYNOPSIS
    直接启动本地 ComfyUI（不经过绘世启动器）。

.DESCRIPTION
    用 ComfyUI 安装目录（-ComfyDir / $env:COMFYUI_HOME，默认 ~/ComfyUI）下 .ext 里的
    python 直接跑 main.py；日志落到 -LogDir（默认 $env:COMFYUI_LOG_DIR，没设就用
    系统临时目录下的 dsh-drawing-logs）下，PID 记在 comfyui.pid 里。

    可用环境变量指定路径，避免脚本里写死：
      COMFYUI_HOME    ComfyUI 安装目录
      COMFYUI_PYTHON  解释器（默认 <COMFYUI_HOME>\.ext\python.exe）
      COMFYUI_MAIN    ComfyUI 入口脚本（默认 <COMFYUI_HOME>\main.py）
      COMFYUI_LOG_DIR 日志目录（也可用 -LogDir）

    注意：不要把绘世的 `--cpu` 带过来。在 ComfyUI 0.44 里 `--cpu` 的含义是
    "全部用 CPU（很慢）"，绘世只是拿它当绕过 A 卡 DirectML 检测的标签；
    我们不走绘世，直接用 ROCm 的 GPU。

.EXAMPLE
    .\start-comfyui.ps1 -Wait
    启动并等到 8188 能响应（最多 180 秒）。

.EXAMPLE
    .\start-comfyui.ps1 -Stop
    停掉上次由本脚本启动的进程。
#>
[CmdletBinding()]
param(
    [string]$ComfyDir = $env:COMFYUI_HOME,
    [string]$Python = $env:COMFYUI_PYTHON,
    [string]$Main = $env:COMFYUI_MAIN,
    [string]$LogDir = $(if ($env:COMFYUI_LOG_DIR) { $env:COMFYUI_LOG_DIR } else { Join-Path $env:TEMP 'dsh-drawing-logs' }),
    [string]$Origin = 'http://127.0.0.1:8188',
    [string[]]$ExtraArgs = @(),
    [int]$TimeoutSeconds = 180,
    [switch]$Wait,
    [switch]$Stop,
    # 按显卡自动选启动参数；显式传 -ExtraArgs 仍会追加在后面。
    [switch]$Cpu,
    [switch]$ForceFp32
)

if (-not $Python) { $Python = Join-Path $ComfyDir '.ext\python.exe' }
if (-not $Main) { $Main = Join-Path $ComfyDir 'main.py' }

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ComfyDir)) {
  throw '请用 -ComfyDir 或环境变量 COMFYUI_HOME 指定 ComfyUI 安装目录（脚本不预设默认位置）。'
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$pidFile = Join-Path $LogDir 'comfyui.pid'

function Test-ComfyOnline {
    try {
        $stats = Invoke-RestMethod "$Origin/system_stats" -TimeoutSec 2
        return [pscustomobject]@{ Online = $true; Version = $stats.system.comfyui_version; Device = $stats.devices[0].name }
    } catch {
        return [pscustomobject]@{ Online = $false; Version = $null; Device = $null }
    }
}

if ($Stop) {
    if (-not (Test-Path $pidFile)) { Write-Host "没有找到 $pidFile，可能不是本脚本启动的。" ; exit 1 }
    $oldPid = [int](Get-Content $pidFile -Raw).Trim()
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) { Remove-Item $pidFile -Force; Write-Host "进程 $oldPid 已经不在了，已清理 pid 文件。"; exit 0 }
    Stop-Process -Id $oldPid -Force
    Remove-Item $pidFile -Force
    Write-Host "已停止 ComfyUI (pid $oldPid)。"
    exit 0
}

$python = $Python
$main = $Main
foreach ($path in @($python, $main)) {
    if (-not (Test-Path $path)) { throw "找不到需要的文件：$path" }
}

$state = Test-ComfyOnline
if ($state.Online) {
    Write-Host "ComfyUI 已经在运行（v$($state.Version) / $($state.Device)），不重复启动。"
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $LogDir "comfyui-$stamp.log"
$errLog = Join-Path $LogDir "comfyui-$stamp.err.log"

# 不要 --cpu：见文件头注释。
# 按显卡决定启动参数：A 卡不需要 CUDA 的 attention 参数，N 卡也不需要 AMD 的。
$gpuName = $null
try {
    $gpuName = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'NVIDIA|Radeon|Arc|Intel' } |
        Select-Object -First 1).Name
} catch { }

$vendor = 'unknown'
if ($gpuName -match 'NVIDIA') { $vendor = 'nvidia' }
elseif ($gpuName -match 'Radeon|AMD') { $vendor = 'amd' }
elseif ($gpuName -match 'Arc|Intel') { $vendor = 'intel' }

$arguments = @($main, '--preview-method', 'auto')
switch ($vendor) {
    'nvidia' { $arguments += '--use-pytorch-cross-attention' }
    'amd' {
        $arguments += '--use-quad-cross-attention'
        if ($ForceFp32) { $arguments += '--force-fp32' }
    }
    'intel' { $arguments += '--use-ipex' }
    default { Write-Host "未识别显卡厂商，使用 ComfyUI 默认参数；必要时用 -ExtraArgs 覆盖。" }
}
if ($Cpu) { $arguments += '--cpu' }
$arguments += $ExtraArgs
Write-Host "GPU: $vendor$([string]::IsNullOrWhiteSpace($gpuName) ? '' : " ($gpuName)") | args: $($arguments -join ' ')"

$process = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $ComfyDir `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
    -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $process.Id -Encoding ascii
Write-Host "已启动 ComfyUI (pid $($process.Id))"
Write-Host "  日志: $outLog"
Write-Host "  错误: $errLog"

if (-not $Wait) { exit 0 }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 1500
    if ($process.HasExited) {
        Write-Host "启动失败：python 已经退出（exit code $($process.ExitCode)）。最后几行日志：" -ForegroundColor Red
        if (Test-Path $outLog) { Get-Content $outLog -Tail 15 }
        if (Test-Path $errLog) { Get-Content $errLog -Tail 15 }
        exit 1
    }
    $state = Test-ComfyOnline
    if ($state.Online) {
        Write-Host "ComfyUI 就绪：$Origin（v$($state.Version) / $($state.Device)）" -ForegroundColor Green
        exit 0
    }
}

Write-Host "等待超时（$TimeoutSeconds 秒），进程仍在但 8188 还没响应。看日志：$outLog" -ForegroundColor Yellow
exit 1
