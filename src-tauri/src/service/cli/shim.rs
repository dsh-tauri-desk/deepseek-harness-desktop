//! shim 脚本内容生成：`dsh` / `pnpm` 的 cmd、ps1、sh 包装脚本与落盘。
//!
//! 各构建函数是纯函数（便于测试），`write_shims` 负责写入 bin 目录。
//! shim 文本必须全英文：cmd/ps1 按系统代码页解析，中文注释会乱码成命令执行。

use crate::config;
use std::fs;
use std::path::Path;
use tauri::AppHandle;

/// Windows 下 shim 文件名（cmd 为主入口，ps1 供 PowerShell 原生体验）
pub const SHIM_CMD_NAME: &str = "dsh.cmd";
pub const SHIM_PS1_NAME: &str = "dsh.ps1";
pub const PNPM_SHIM_CMD_NAME: &str = "pnpm.cmd";
pub const PNPM_SHIM_PS1_NAME: &str = "pnpm.ps1";

/// Unix 下 shim 文件名
#[cfg(unix)]
pub const SHIM_SH_NAME: &str = "dsh";
#[cfg(unix)]
pub const PNPM_SHIM_SH_NAME: &str = "pnpm";

// ---------------------------------------------------------------------------
// shim 共享片段：node 解析逻辑（dsh / pnpm shim 共用）
//
// 规则：优先 `DSH_NODE` 环境变量（桌面端注入其已解析并核验过的 node 路径，
// 保证 shim 与应用预检一致），其次 PATH 中版本兼容的本地 node（v22.15+ /
// v23.8+ / v24+，与 config::is_supported_node_version 一致），否则回退捆绑
// 运行时。`DSH_NODE` 只在桌面端自身派生的子进程里存在，终端用户环境不受影响。
// 变量约定：cmd 用 %APP_DIR%，ps1 用 $appDir，sh 用 $APP_DIR。
// 这些常量作为 format! 的参数传入，其中的 `{`/`}` 是字面量。
// ---------------------------------------------------------------------------

const CMD_NODE_RESOLVE: &str = r#"
rem Prefer the desktop-resolved node (DSH_NODE, injected by the app into its
rem own child processes), then a version-compatible local node, then the
rem bundled runtime. DSH_NODE makes the shim and the app's pre-check agree:
rem the app verified the node exists before spawning the child, and the shim
rem must not re-derive it from PATH (which can miss nodes the app found).
rem Pure batch version check (for /f tokens + numeric compare), no powershell
rem child: avoids console flashes when invoked without a console and skips the
rem per-call powershell startup cost.
if defined DSH_NODE (
  if exist "%DSH_NODE%" goto :node_dsh
)
where node >nul 2>nul
if errorlevel 1 goto :use_bundled
for /f "tokens=1,2 delims=v." %%a in ('node --version 2^>nul ^| findstr /b "v"') do set "NODE_MAJOR=%%a" & set "NODE_MINOR=%%b"
if not defined NODE_MAJOR goto :use_bundled
if %NODE_MAJOR% GEQ 24 goto :node_ok
if %NODE_MAJOR% EQU 22 if defined NODE_MINOR if %NODE_MINOR% GEQ 15 goto :node_ok
if %NODE_MAJOR% EQU 23 if defined NODE_MINOR if %NODE_MINOR% GEQ 8 goto :node_ok
goto :use_bundled

:node_ok
set "NODE=node"
goto :launch

:node_dsh
set "NODE=%DSH_NODE%"
goto :launch

:use_bundled
if not exist "%APP_DIR%\runtime\node.exe" goto :no_node
set "NODE=%APP_DIR%\runtime\node.exe"
set "PATH=%APP_DIR%\runtime;%PATH%"
"#;

const PS1_NODE_RESOLVE: &str = r#"
# Prefer the desktop-resolved node (DSH_NODE, injected by the app into its
# own child processes), then a version-compatible local node, then the
# bundled runtime — see the CMD shim for why DSH_NODE wins first.
$node = $null
if ($env:DSH_NODE -and (Test-Path -LiteralPath $env:DSH_NODE)) {
    $node = $env:DSH_NODE
}
if (-not $node) {
    $localNode = Get-Command node -ErrorAction SilentlyContinue
    if ($localNode) {
        try {
            $version = & node --version 2>$null
            if ($version -match '^v(\d+)\.(\d+)') {
                $major = [int]$matches[1]
                $minor = [int]$matches[2]
                if (($major -eq 22 -and $minor -ge 15) -or ($major -eq 23 -and $minor -ge 8) -or $major -ge 24) {
                    $node = 'node'
                }
            }
        } catch { }
    }
}
if (-not $node) {
    $bundled = Join-Path $appDir 'runtime\node.exe'
    if (Test-Path -LiteralPath $bundled) {
        $node = $bundled
        $env:PATH = (Split-Path -Parent $bundled) + ';' + $env:PATH
    }
}
if (-not $node) {
    Write-Error 'Node.js runtime not found. Please run DeepSeek Harness Desktop to install it first.'
    exit 1
}
"#;

const SH_NODE_RESOLVE: &str = r#"
NODE=""
# Prefer the desktop-resolved node (DSH_NODE, injected by the app into its
# own child processes), then a version-compatible local node, then the
# bundled runtime — see the CMD shim for why DSH_NODE wins first.
if [ -n "$DSH_NODE" ] && [ -x "$DSH_NODE" ]; then
  NODE="$DSH_NODE"
fi
if [ -z "$NODE" ] && command -v node >/dev/null 2>&1; then
  NODE_V=$(node --version 2>/dev/null)
  MAJOR=$(printf '%s' "$NODE_V" | awk -F. '{ gsub(/^v/, "", $1); print $1 }')
  MINOR=$(printf '%s' "$NODE_V" | awk -F. '{ print $2 }')
  if { [ -n "$MAJOR" ] && [ "$MAJOR" -ge 24 ]; } 2>/dev/null || \
     { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -ge 15 ]; } 2>/dev/null || \
     { [ "$MAJOR" -eq 23 ] && [ "$MINOR" -ge 8 ]; } 2>/dev/null; then
    NODE="node"
  fi
fi
if [ -z "$NODE" ]; then
  if [ -x "$APP_DIR/runtime/bin/node" ]; then
    NODE="$APP_DIR/runtime/bin/node"
    export PATH="$APP_DIR/runtime/bin:$PATH"
  fi
fi
if [ -z "$NODE" ]; then
  echo "Node.js runtime not found. Please run DeepSeek Harness Desktop to install it first." >&2
  exit 1
fi
"#;

// ---------------------------------------------------------------------------
// dsh shim 共享片段：用户已安装的 dsh 优先（避免覆盖/遮蔽用户自己的 dsh 与
// $DSH_HOME）。与 pnpm shim 的"用户优先"策略一致：先转发 PATH 中（排除本
// shim 目录）的用户 dsh，转发时不注入本应用的 DSH_HOME，保留用户环境；
// 仅找不到用户 dsh 时才回退到捆绑 dsh。
// 变量约定：cmd 用 %SELF_PREFIX%/%USER_DSH%，ps1 用 $selfDir/$userDsh，
// sh 用 $SELF_DIR。dsh shim 仅 release 构建写入（debug 构建不覆盖共享的
// dsh shim，见 write_shims），debug 下这些常量/函数未使用，允许 dead_code。
#[cfg_attr(debug_assertions, allow(dead_code))]
const CMD_USER_DSH_PRECEDENCE: &str = r#"
rem Prefer a user-installed dsh on PATH (skip our own shim dir), fall back to bundled.
rem This preserves your own dsh binary and its $DSH_HOME config; nothing is overwritten.
set "SELF_PREFIX=%~dp0"
set "SELF_PREFIX=%SELF_PREFIX:~0,-1%"
set "USER_DSH="
for /f "delims=" %%d in ('where dsh 2^>nul') do (
  if not defined USER_DSH (
    if /i not "%%d"=="%SELF_PREFIX%\dsh.cmd" (
      if /i not "%%d"=="%SELF_PREFIX%\dsh.ps1" (
        if /i not "%%d"=="%SELF_PREFIX%\dsh.exe" (
          if /i not "%%d"=="%SELF_PREFIX%\dsh.bat" (
            if /i "%%~xd"==".cmd" set "USER_DSH=%%d"
            if /i "%%~xd"==".exe" set "USER_DSH=%%d"
            if /i "%%~xd"==".bat" set "USER_DSH=%%d"
          )
        )
      )
    )
  )
)
if defined USER_DSH (
  call "%USER_DSH%" %*
  exit /b %ERRORLEVEL%
)
"#;

#[cfg_attr(debug_assertions, allow(dead_code))]
const PS1_USER_DSH_PRECEDENCE: &str = r#"
# Prefer a user-installed dsh on PATH (skip our own shim dir), fall back to bundled.
# This preserves your own dsh binary and its $env:DSH_HOME config; nothing is overwritten.
$selfDir = $PSScriptRoot.TrimEnd('\') + '\'
$userDsh = Get-Command dsh -All -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -and -not $_.Source.StartsWith($selfDir, [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
if ($userDsh) {
    & $userDsh.Source @args
    exit $LASTEXITCODE
}
"#;

#[cfg_attr(windows, allow(dead_code))] // 仅 Unix shim 使用
#[cfg_attr(debug_assertions, allow(dead_code))]
const SH_USER_DSH_PRECEDENCE: &str = r#"
# Prefer a user-installed dsh on PATH (skip our own shim dir), fall back to bundled.
# This preserves your own dsh binary and its $DSH_HOME config; nothing is overwritten.
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
IFS=:
for dir in $PATH; do
  if [ "$dir" = "$SELF_DIR" ]; then
    continue
  fi
  if [ -x "$dir/dsh" ]; then
    exec "$dir/dsh" "$@"
  fi
done
unset IFS
"#;

// ---------------------------------------------------------------------------
// 路径转义（按目标脚本语言的字符串规则）
// ---------------------------------------------------------------------------

/// 批处理中 `%` 会被展开，需写成 `%%`
#[inline]
pub fn escape_path_cmd(path: &Path) -> String {
    path.to_string_lossy().replace('%', "%%")
}

/// 单引号字符串中 `'` 需翻倍
#[inline]
pub fn escape_path_ps1(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

/// 单引号字符串中 `'` 需写成 `'\''`
#[inline]
pub fn escape_path_sh(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "'\\''")
}

// ---------------------------------------------------------------------------
// dsh shim
// ---------------------------------------------------------------------------

/// Windows `dsh.cmd` 内容。`app_dir` 为应用数据目录（绝对路径，生成时写死），
/// `dsh_home` 为官方 `$DSH_HOME`（release 为 `~/.dsh`，生成时写死，与桌面端/
/// 官方一致）。
#[cfg_attr(debug_assertions, allow(dead_code))] // 仅 release 构建写入 dsh shim
pub fn build_cmd_shim(app_dir: &Path, dsh_home: &Path) -> String {
    let dsh_bin = app_dir.join("dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");

    format!(
        r#"@echo off
rem DeepSeek Harness Desktop - dsh command shim (generated)
rem Do not edit: regenerated by the desktop app on install/startup.
setlocal
set "APP_DIR={app_dir}"
rem Use bundled MinGit only when system Git lacks its HTTPS transport helper.
set "SYSTEM_GIT_WORKS="
for /f "delims=" %%g in ('git --exec-path 2^>nul') do if exist "%%g\git-remote-https.exe" set "SYSTEM_GIT_WORKS=1"
if not defined SYSTEM_GIT_WORKS if exist "%APP_DIR%\dependencies\git\cmd\git.exe" set "PATH=%APP_DIR%\dependencies\git\cmd;%PATH%"
{user_dsh}
set "DSH_BIN={dsh_bin}"
set "DSH_HOME={dsh_home}"
set "DSH_TELEMETRY_DISABLED=1"
{node_resolve}
:launch
if not exist "%DSH_BIN%" goto :no_cli
"%NODE%" "%DSH_BIN%" %*
exit /b %ERRORLEVEL%

:no_cli
echo [dsh] Harness CLI not found. Please run DeepSeek Harness Desktop to install it first. 1>&2
exit /b 1

:no_node
echo [dsh] Node.js runtime not found. Please run DeepSeek Harness Desktop to install it first. 1>&2
exit /b 1
"#,
        app_dir = escape_path_cmd(app_dir),
        dsh_bin = escape_path_cmd(&dsh_bin),
        dsh_home = escape_path_cmd(dsh_home),
        user_dsh = CMD_USER_DSH_PRECEDENCE,
        node_resolve = CMD_NODE_RESOLVE,
    )
}

/// Windows `dsh.ps1` 内容
#[cfg_attr(debug_assertions, allow(dead_code))] // 仅 release 构建写入 dsh shim
pub fn build_ps1_shim(app_dir: &Path, dsh_home: &Path) -> String {
    let dsh_bin = app_dir.join("dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");

    format!(
        r#"# DeepSeek Harness Desktop - dsh command shim (generated)
# Do not edit: regenerated by the desktop app on install/startup.
$ErrorActionPreference = "Stop"
$appDir = '{app_dir}'
$dshBin = '{dsh_bin}'
# Use bundled MinGit only when system Git lacks its HTTPS transport helper.
$systemGitWorks = $false
try {{
    $gitExecPath = & git --exec-path 2> $null
    $systemGitWorks = ($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath (Join-Path $gitExecPath 'git-remote-https.exe'))
}} catch {{}}
if (-not $systemGitWorks) {{
    $gitDir = Join-Path $appDir 'dependencies\git\cmd'
    if (Test-Path -LiteralPath (Join-Path $gitDir 'git.exe')) {{
        $env:PATH = $gitDir + ';' + $env:PATH
    }}
}}
{user_dsh}
$dshHome = '{dsh_home}'
$env:DSH_TELEMETRY_DISABLED = '1'
{node_resolve}
if (-not (Test-Path -LiteralPath $dshBin)) {{
    Write-Error '[dsh] Harness CLI not found. Please run DeepSeek Harness Desktop to install it first.'
    exit 1
}}
$env:DSH_HOME = $dshHome
& $node $dshBin @args
exit $LASTEXITCODE
"#,
        app_dir = escape_path_ps1(app_dir),
        dsh_bin = escape_path_ps1(&dsh_bin),
        user_dsh = PS1_USER_DSH_PRECEDENCE,
        node_resolve = PS1_NODE_RESOLVE,
        dsh_home = escape_path_ps1(dsh_home),
    )
}

/// Unix `dsh` shell 脚本内容（POSIX sh）
#[cfg(not(windows))]
#[cfg_attr(debug_assertions, allow(dead_code))] // 仅 release 构建写入 dsh shim
pub fn build_sh_shim(app_dir: &Path, dsh_home: &Path) -> String {
    let dsh_bin = app_dir.join("dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");

    format!(
        r#"#!/bin/sh
# DeepSeek Harness Desktop - dsh command shim (generated)
# Do not edit: regenerated by the desktop app on install/startup.
APP_DIR='{app_dir}'
DSH_BIN='{dsh_bin}'
{user_dsh}
export DSH_HOME='{dsh_home}'
export DSH_TELEMETRY_DISABLED=1
{node_resolve}
if [ ! -f "$DSH_BIN" ]; then
  echo "[dsh] Harness CLI not found. Please run DeepSeek Harness Desktop to install it first." >&2
  exit 1
fi
exec "$NODE" "$DSH_BIN" "$@"
"#,
        app_dir = escape_path_sh(app_dir),
        dsh_bin = escape_path_sh(&dsh_bin),
        user_dsh = SH_USER_DSH_PRECEDENCE,
        dsh_home = escape_path_sh(dsh_home),
        node_resolve = SH_NODE_RESOLVE,
    )
}

// ---------------------------------------------------------------------------
// pnpm shim（额外带"用户 pnpm 优先"逻辑，见各函数注释）
//
// `DSH_PREFER_BUNDLED_PNPM=1`（应用内部插件安装注入，见 service/plugin/install.rs）
// 时改为捆绑版优先：跳过用户 pnpm 直接运行捆绑 pnpm.cjs，仅当捆绑缺失时回退
// 用户 pnpm。默认（未设置）行为不变：用户 pnpm 优先。
// ---------------------------------------------------------------------------

/// Windows `pnpm.cmd` 内容：优先转发用户自己安装的 pnpm（`where pnpm` 遍历、
/// 跳过本 shim 目录、只收 `.cmd/.exe/.bat`），否则用 node 运行捆绑 pnpm.cjs。
/// `DSH_PREFER_BUNDLED_PNPM=1` 时捆绑版优先（见模块头注）。
///
/// 实现要点：
/// - 不用 `findstr` 匹配路径（`\` 会被当正则转义导致过滤失效）；
/// - 块内变量判断用 for 变量（`%%~xp`）而非 `%VAR%`（块解析时机陷阱）。
pub fn build_pnpm_cmd_shim(app_dir: &Path) -> String {
    let pnpm_bin = app_dir.join("dependencies/pnpm/bin/pnpm.cjs");

    format!(
        r#"@echo off
rem DeepSeek Harness Desktop - pnpm command shim (generated)
rem Do not edit: regenerated by the desktop app on install/startup.
setlocal
set "APP_DIR={app_dir}"
set "PNPM_BIN={pnpm_bin}"
rem Use bundled MinGit only when system Git lacks its HTTPS transport helper.
set "SYSTEM_GIT_WORKS="
for /f "delims=" %%g in ('git --exec-path 2^>nul') do if exist "%%g\git-remote-https.exe" set "SYSTEM_GIT_WORKS=1"
if not defined SYSTEM_GIT_WORKS if exist "%APP_DIR%\dependencies\git\cmd\git.exe" set "PATH=%APP_DIR%\dependencies\git\cmd;%PATH%"

rem App-internal installs (DSH_PREFER_BUNDLED_PNPM=1) use the bundled pnpm,
rem falling back to the user's only when the bundled one is missing.
if "%DSH_PREFER_BUNDLED_PNPM%"=="1" (
  if exist "%PNPM_BIN%" goto :after_user
)

rem Use the exact user pnpm discovered by the desktop app.
if defined DSH_PNPM (
  if exist "%DSH_PNPM%" goto :use_selected
)

rem Prefer a user-installed pnpm (skip our own shim dir), fall back to bundled.
rem Accept only executable extensions (.cmd/.exe/.bat), ignore extensionless shell scripts.
set "SELF_PREFIX=%~dp0"
set "SELF_PREFIX=%SELF_PREFIX:~0,-1%"
set "USER_PNPM="
for /f "delims=" %%p in ('where pnpm 2^>nul') do (
  if not defined USER_PNPM (
    if /i not "%%p"=="%SELF_PREFIX%\pnpm.cmd" (
      if /i not "%%p"=="%SELF_PREFIX%\pnpm.exe" (
        if /i not "%%p"=="%SELF_PREFIX%\pnpm.bat" (
          if /i "%%~xp"==".cmd" set "USER_PNPM=%%p"
          if /i "%%~xp"==".exe" set "USER_PNPM=%%p"
          if /i "%%~xp"==".bat" set "USER_PNPM=%%p"
        )
      )
    )
  )
)
if defined USER_PNPM goto :use_user

goto :after_user

:use_selected
call "%DSH_PNPM%" %*
exit /b %ERRORLEVEL%

:use_user
call "%USER_PNPM%" %*
exit /b %ERRORLEVEL%

:after_user
{node_resolve}
:launch
if not exist "%PNPM_BIN%" goto :no_pnpm
"%NODE%" "%PNPM_BIN%" %*
exit /b %ERRORLEVEL%

:no_pnpm
echo [pnpm] pnpm not found. Please run DeepSeek Harness Desktop to install it first. 1>&2
exit /b 1

:no_node
echo [pnpm] Node.js runtime not found. Please run DeepSeek Harness Desktop to install it first. 1>&2
exit /b 1
"#,
        app_dir = escape_path_cmd(app_dir),
        pnpm_bin = escape_path_cmd(&pnpm_bin),
        node_resolve = CMD_NODE_RESOLVE,
    )
}

/// Windows `pnpm.ps1` 内容：优先转发用户 pnpm（`Get-Command pnpm -All`，
/// 排除本 shim 目录），否则用 node 运行捆绑 pnpm.cjs。
/// `DSH_PREFER_BUNDLED_PNPM=1` 时捆绑版优先（见模块头注）。
pub fn build_pnpm_ps1_shim(app_dir: &Path) -> String {
    let pnpm_bin = app_dir.join("dependencies/pnpm/bin/pnpm.cjs");

    format!(
        r#"# DeepSeek Harness Desktop - pnpm command shim (generated)
# Do not edit: regenerated by the desktop app on install/startup.
$ErrorActionPreference = "Stop"
$appDir = '{app_dir}'
$pnpmBin = '{pnpm_bin}'
# Use bundled MinGit only when system Git lacks its HTTPS transport helper.
$systemGitWorks = $false
try {{
    $gitExecPath = & git --exec-path 2> $null
    $systemGitWorks = ($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath (Join-Path $gitExecPath 'git-remote-https.exe'))
}} catch {{}}
if (-not $systemGitWorks) {{
    $gitDir = Join-Path $appDir 'dependencies\git\cmd'
    if (Test-Path -LiteralPath (Join-Path $gitDir 'git.exe')) {{
        $env:PATH = $gitDir + ';' + $env:PATH
    }}
}}

$useBundled = $env:DSH_PREFER_BUNDLED_PNPM -eq '1' -and (Test-Path -LiteralPath $pnpmBin -PathType Leaf)

# Use the exact user pnpm discovered by the desktop app unless bundled was requested.
if (-not $useBundled -and $env:DSH_PNPM -and (Test-Path -LiteralPath $env:DSH_PNPM -PathType Leaf)) {{
    & $env:DSH_PNPM @args
    exit $LASTEXITCODE
}}

# Prefer a user-installed pnpm (skip our own shim dir), fall back to bundled.
if (-not $useBundled) {{
    $selfDir = $PSScriptRoot.TrimEnd('\') + '\'
    $userPnpm = Get-Command pnpm -All -ErrorAction SilentlyContinue |
        Where-Object {{ $_.Source -and -not $_.Source.StartsWith($selfDir, [System.StringComparison]::OrdinalIgnoreCase) }} |
        Select-Object -First 1
    if ($userPnpm) {{
        & $userPnpm.Source @args
        exit $LASTEXITCODE
    }}
}}

{node_resolve}

if (-not (Test-Path -LiteralPath $pnpmBin)) {{
    Write-Error '[pnpm] pnpm not found. Please run DeepSeek Harness Desktop to install it first.'
    exit 1
}}
& $node $pnpmBin @args
exit $LASTEXITCODE
"#,
        app_dir = escape_path_ps1(app_dir),
        pnpm_bin = escape_path_ps1(&pnpm_bin),
        node_resolve = PS1_NODE_RESOLVE,
    )
}

/// Unix `pnpm` shell 脚本内容（POSIX sh）：按 PATH 顺序转发第一个非本目录
/// 的用户 pnpm，否则用 node 运行捆绑 pnpm.cjs。`DSH_PREFER_BUNDLED_PNPM=1`
/// 时捆绑版优先（见模块头注）。
#[cfg_attr(all(windows, not(test)), allow(dead_code))]
pub fn build_pnpm_sh_shim(app_dir: &Path) -> String {
    let pnpm_bin = app_dir.join("dependencies/pnpm/bin/pnpm.cjs");

    format!(
        r#"#!/bin/sh
# DeepSeek Harness Desktop - pnpm command shim (generated)
# Do not edit: regenerated by the desktop app on install/startup.
APP_DIR='{app_dir}'
PNPM_BIN='{pnpm_bin}'

USE_BUNDLED=
if [ "$DSH_PREFER_BUNDLED_PNPM" = "1" ] && [ -f "$PNPM_BIN" ]; then
  USE_BUNDLED=1
fi

# Use the exact user pnpm discovered by the desktop app unless bundled was requested.
if [ -z "$USE_BUNDLED" ] && [ -n "$DSH_PNPM" ] && [ -x "$DSH_PNPM" ]; then
  exec "$DSH_PNPM" "$@"
fi

# Prefer a user-installed pnpm (skip our own shim dir), fall back to bundled.
if [ -z "$USE_BUNDLED" ]; then
  SELF_DIR=$(cd "$(dirname "$0")" && pwd)
  IFS=:
  for dir in $PATH; do
    if [ "$dir" = "$SELF_DIR" ]; then
      continue
    fi
    if [ -x "$dir/pnpm" ]; then
      exec "$dir/pnpm" "$@"
    fi
  done
  unset IFS
fi

{node_resolve}

if [ ! -f "$PNPM_BIN" ]; then
  echo "[pnpm] pnpm not found. Please run DeepSeek Harness Desktop to install it first." >&2
  exit 1
fi
exec "$NODE" "$PNPM_BIN" "$@"
"#,
        app_dir = escape_path_sh(app_dir),
        pnpm_bin = escape_path_sh(&pnpm_bin),
        node_resolve = SH_NODE_RESOLVE,
    )
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/// 生成的 shim 自带的可识别标记（首行注释）。用于区分"本应用生成的 shim"
/// 与"用户自行放置的同名文件"。读文件只读该标记行，避免误删用户自有文件。
const GENERATED_MARKER: &str = "DeepSeek Harness Desktop - ";

/// 目标路径已存在且不是本应用生成的 shim（即用户手动放置的 `dsh`/`pnpm`）。
///
/// 此时绝不覆盖，保留用户文件，避免"安装后清空了之前手动安装的工具"。
fn is_foreign_file(path: &Path) -> bool {
    !is_generated_shim(path)
}

/// 路径是否为悬空符号链接（链接本身存在，但指向的目标不存在）。
///
/// 官方 dsh 安装器会在 `~/.local/bin/dsh -> ~/.dsh/source/current/bin/dsh` 留下
/// 符号链接；当 `current` 指向的目录被移动/删除后链接即悬空。此时
/// `Path::exists()` 跟随链接返回 `false`，但直接 `fs::write` 会沿链接打开目标
/// 并在其父目录缺失时报 `No such file or directory (os error 2)`——必须先把
/// 已失效的链接本身移除，才能按"文件不存在"正常写入。
fn is_dangling_symlink(path: &Path) -> bool {
    match path.symlink_metadata() {
        Ok(meta) => meta.file_type().is_symlink() && !path.exists(),
        Err(_) => false,
    }
}

/// 判断路径是否为本应用生成的 shim（内容含生成标记）。
///
/// 用于在本地 dsh 探测中区分"本应用 shim"与"用户自行放置的同名文件"：
/// 前者应被排除（它转发到捆绑 dsh，不构成用户本地核心），后者应被识别。
pub fn is_generated_shim(path: &Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(content) => content.contains(GENERATED_MARKER),
        Err(_) => false,
    }
}

/// 写入单个 shim 文件，处理目标已存在时的三种情形：
///
/// 1. 悬空符号链接（用户/官方安装器残留、目标已失效）→ 移除链接后正常写入；
/// 2. 已存在且非本应用生成（用户手动放置的 `dsh`/`pnpm`）→ 跳过，保留用户文件；
/// 3. 其余（不存在，或本应用生成的 shim）→ 直接写入/覆盖。
fn write_shim_file(target: &Path, content: &str) -> Result<(), String> {
    if is_dangling_symlink(target) {
        log::warn!(
            "Removing dangling symlink {:?} before writing shim (its target is gone)",
            target
        );
        fs::remove_file(target).map_err(|e| {
            format!(
                "SHIM_REMOVE_DANGLING_SYMLINK: remove dangling symlink {} failed: {e}",
                target.display()
            )
        })?;
    }
    if target.exists() && is_foreign_file(target) {
        log::warn!(
            "Skipping shim write to {:?}: an existing user file is preserved",
            target
        );
        return Ok(());
    }
    fs::write(target, content).map_err(|e| format!("write {} failed: {e}", target.display()))
}

/// 主 `dsh` shim 路径下是否保留了用户自行安装的同名文件（用于状态展示）。
pub fn user_dsh_preserved(bin_dir: &Path) -> bool {
    let path = {
        #[cfg(windows)]
        {
            bin_dir.join(SHIM_CMD_NAME)
        }
        #[cfg(not(windows))]
        {
            bin_dir.join(SHIM_SH_NAME)
        }
    };
    path.is_file() && is_foreign_file(&path)
}

/// 将 shim 文件写入 bin 目录；目标已存在但非本应用生成的同名文件时跳过（保留）。
/// 目标为悬空符号链接时先移除链接再写入（链接目标已失效，保留只会让写入
/// 报 ENOENT）。
///
/// 覆盖式仅针对本应用生成的 shim（自愈时内容与当前安装一致）；用户手动放置的
/// 同名 `dsh`/`pnpm` 一律保留不动，避免覆盖用户自己的安装与配置。
pub fn write_shims(app_handle: &AppHandle, bin_dir: &Path) -> Result<(), String> {
    let app_dir = config::get_base_dir(app_handle);
    fs::create_dir_all(bin_dir).map_err(|e| format!("create bin dir failed: {e}"))?;

    // 写入单个 shim：若目标已存在且非本应用生成，则跳过不覆盖（保留用户文件）。
    macro_rules! write_if_ours {
        ($path:expr, $content:expr) => {{
            let target = bin_dir.join($path);
            write_shim_file(&target, &$content)?;
            target
        }};
    }

    // dsh shim 会在内容里烘焙 $DSH_HOME（生产为 ~/.dsh、开发为 ~/.dsh.dev）。
    // 开发构建禁止改写用户共享的 dsh shim——改写会让终端 `dsh` 指向开发数据
    // 目录，并覆盖生产的命令行集成；生产版生成的 dsh shim 原样保留。
    #[cfg(not(debug_assertions))]
    {
        let dsh_home = config::get_dsh_data_path(app_handle);
        #[cfg(windows)]
        {
            write_if_ours!(SHIM_CMD_NAME, build_cmd_shim(&app_dir, &dsh_home));
            write_if_ours!(SHIM_PS1_NAME, build_ps1_shim(&app_dir, &dsh_home));
        }
        #[cfg(not(windows))]
        {
            write_if_ours!(SHIM_SH_NAME, build_sh_shim(&app_dir, &dsh_home));
        }
    }
    #[cfg(debug_assertions)]
    log::debug!("debug build: skip dsh shim write (shared user state kept for release)");

    // pnpm shim 不烘焙 $DSH_HOME（仅绑定 bundle 目录与“用户 pnpm 优先”逻辑），
    // 内容与生产完全一致，开发构建也可写入——dsh plugin 子进程经 PATH 解析
    // pnpm 依赖它，写它不污染任何共享数据。
    #[cfg(windows)]
    {
        write_if_ours!(PNPM_SHIM_CMD_NAME, build_pnpm_cmd_shim(&app_dir));
        write_if_ours!(PNPM_SHIM_PS1_NAME, build_pnpm_ps1_shim(&app_dir));
    }
    #[cfg(not(windows))]
    {
        write_if_ours!(PNPM_SHIM_SH_NAME, build_pnpm_sh_shim(&app_dir));
        // 仅对本应用生成/覆盖过的 shim 设置可执行位；保留的用户文件不动
        let chmod_names: &[&str] = if cfg!(debug_assertions) {
            &[PNPM_SHIM_SH_NAME]
        } else {
            &[SHIM_SH_NAME, PNPM_SHIM_SH_NAME]
        };
        for name in chmod_names {
            let path = bin_dir.join(name);
            if path.is_file() && !is_foreign_file(&path) {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("chmod shim failed: {e}"))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ------------------------------------------------------------------
    // escape_path_* 纯函数基线（与 shim 内嵌路径的场景一致）
    // ------------------------------------------------------------------

    #[test]
    fn escape_path_cmd_doubles_percent() {
        assert_eq!(
            escape_path_cmd(Path::new(r"C:\Users\%test%\x")),
            r"C:\Users\%%test%%\x"
        );
        assert_eq!(escape_path_cmd(Path::new("/tmp/a b")), "/tmp/a b");
    }

    #[test]
    fn escape_path_ps1_doubles_single_quotes() {
        assert_eq!(
            escape_path_ps1(Path::new(r"C:\Users\o'brien")),
            r"C:\Users\o''brien"
        );
        assert_eq!(escape_path_ps1(Path::new("/plain/path")), "/plain/path");
    }

    #[test]
    fn escape_path_sh_escapes_single_quotes() {
        assert_eq!(
            escape_path_sh(Path::new("/home/o'brien/.dsh")),
            r"/home/o'\''brien/.dsh"
        );
        assert_eq!(escape_path_sh(Path::new("/plain/.dsh")), "/plain/.dsh");
    }

    fn sample_app_dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(
                r"C:\Users\test\AppData\Roaming\io.github.hairyf.deepseek-harness-desktop",
            )
        } else {
            PathBuf::from("/home/test/.local/share/io.github.hairyf.deepseek-harness-desktop")
        }
    }

    /// 官方 $DSH_HOME（~/.dsh）
    fn sample_dsh_home() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\test\.dsh")
        } else {
            PathBuf::from("/home/test/.dsh")
        }
    }

    #[cfg(windows)]
    #[test]
    #[cfg(windows)]
    fn cmd_shim_contains_baked_paths() {
        let content = build_cmd_shim(&sample_app_dir(), &sample_dsh_home());
        assert!(content.contains(r"C:\Users\test\AppData\Roaming"));
        assert!(content.contains("dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"));
        assert!(content.contains(r"C:\Users\test\.dsh"));
        assert!(!content.contains("data/dsh"));
        assert!(content.contains("%*"));
    }

    #[test]
    fn cmd_shim_escapes_percent() {
        let dir = PathBuf::from(
            r"C:\Users\100%test\AppData\Roaming\io.github.hairyf.deepseek-harness-desktop",
        );
        let content = build_cmd_shim(&dir, &sample_dsh_home());
        assert!(content.contains("100%%test"));
        assert!(!content.contains(r#"set "APP_DIR=C:\Users\100%test""#));
    }

    #[cfg(windows)]
    #[test]
    fn windows_shims_configure_bundled_git_without_shadowing_system_git() {
        let dsh_cmd = build_cmd_shim(&sample_app_dir(), &sample_dsh_home());
        let dsh_ps1 = build_ps1_shim(&sample_app_dir(), &sample_dsh_home());
        let pnpm_cmd = build_pnpm_cmd_shim(&sample_app_dir());
        let pnpm_ps1 = build_pnpm_ps1_shim(&sample_app_dir());

        for content in [&dsh_cmd, &pnpm_cmd] {
            assert!(content.contains("git --exec-path 2^>nul"));
            assert!(content.contains("git-remote-https.exe"));
            assert!(content.contains(r"dependencies\git\cmd\git.exe"));
            assert!(content.contains(r"dependencies\git\cmd;%PATH%"));
            let system_probe = content.find("git --exec-path").expect("system Git probe");
            let bundled_git = content
                .find(r"dependencies\git\cmd")
                .expect("bundled Git path");
            assert!(system_probe < bundled_git);
        }
        for content in [&dsh_ps1, &pnpm_ps1] {
            assert!(content.contains("& git --exec-path 2> $null"));
            assert!(content.contains("git-remote-https.exe"));
            assert!(content.contains(r"dependencies\git\cmd"));
            assert!(content.contains("$env:PATH = $gitDir + ';' + $env:PATH"));
        }
    }

    #[test]
    fn pnpm_cmd_shim_contains_user_precedence() {
        let content = build_pnpm_cmd_shim(&sample_app_dir());
        assert!(content.contains("pnpm command shim"));
        assert!(content.contains(r#"dependencies/pnpm/bin/pnpm.cjs"#));
        assert!(content.contains("where pnpm"));
        assert!(content.contains("SELF_PREFIX"));
        assert!(content.contains(r#"call "%USER_PNPM%" %*"#));
        assert!(content.contains(":use_bundled"));
        assert!(content.contains("%APP_DIR%\\runtime\\node.exe"));
        // 应用内部安装可经 DSH_PREFER_BUNDLED_PNPM=1 强制捆绑版（须在用户搜索前生效）
        assert!(content.contains("DSH_PREFER_BUNDLED_PNPM"));
        let env_at = content.find("DSH_PREFER_BUNDLED_PNPM").unwrap();
        let exact_at = content.find("if defined DSH_PNPM").unwrap();
        let user_at = content.find("where pnpm").unwrap();
        assert!(env_at < exact_at && exact_at < user_at);
        assert_eq!(content.matches("if defined DSH_PNPM").count(), 1);
    }

    /// issue #130：真实执行生成的 cmd shim，确保用户 pnpm 的失败码不会因 cmd
    /// 括号块预展开 `%ERRORLEVEL%` 而被吞成 0。
    #[cfg(windows)]
    #[test]
    fn pnpm_cmd_shim_propagates_user_exit_code_in_real_cmd() {
        let dir = temp_dir("pnpm-exit-code");
        let shim_dir = dir.join("desktop-bin");
        let user_dir = dir.join("user-bin");
        std::fs::create_dir_all(&shim_dir).unwrap();
        std::fs::create_dir_all(&user_dir).unwrap();
        let shim = shim_dir.join("pnpm.cmd");
        std::fs::write(&shim, build_pnpm_cmd_shim(&dir.join("app"))).unwrap();
        std::fs::write(
            user_dir.join("pnpm.cmd"),
            "@echo off\r\necho REAL_USER_PNPM\r\nexit /b 37\r\n",
        )
        .unwrap();
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let system32 = PathBuf::from(&system_root).join("System32");
        let path = std::env::join_paths([&shim_dir, &user_dir, &system32]).unwrap();
        let output = std::process::Command::new(system32.join("cmd.exe"))
            .args(["/d", "/c"])
            .arg(&shim)
            .arg("--version")
            .env("PATH", path)
            .env("SystemRoot", system_root)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(37));
        assert!(String::from_utf8_lossy(&output.stdout).contains("REAL_USER_PNPM"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// issue #121：选定 pnpm 即使不在子进程 PATH 中，也必须由 shim 执行。
    #[cfg(windows)]
    #[test]
    fn pnpm_cmd_shim_uses_selected_pnpm_with_restricted_path() {
        let dir = temp_dir("pnpm-selected");
        let selected = dir.join("selected pnpm.cmd");
        std::fs::write(
            &selected,
            "@echo off\r\necho SELECTED_PNPM %*\r\nexit /b 37\r\n",
        )
        .unwrap();
        let selected = dunce::canonicalize(&selected).unwrap();
        assert!(!selected.to_string_lossy().starts_with(r"\\?\"));
        let shim = dir.join("pnpm.cmd");
        std::fs::write(&shim, build_pnpm_cmd_shim(&dir.join("app"))).unwrap();
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let system32 = PathBuf::from(&system_root).join("System32");
        let output = std::process::Command::new(system32.join("cmd.exe"))
            .args(["/d", "/c"])
            .arg(&shim)
            .arg("probe-121")
            .env("PATH", &system32)
            .env("SystemRoot", system_root)
            .env("DSH_PNPM", &selected)
            .env("DSH_PREFER_BUNDLED_PNPM", "1")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(37));
        assert!(String::from_utf8_lossy(&output.stdout).contains("SELECTED_PNPM probe-121"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 两个变量同时存在且捆绑文件可用时，显式的捆绑策略必须优先。
    #[cfg(windows)]
    #[test]
    fn pnpm_cmd_shim_prefers_existing_bundle_over_selected_path() {
        let dir = temp_dir("pnpm-both-vars");
        let app_dir = dir.join("app");
        let pnpm_bin = app_dir.join("dependencies/pnpm/bin/pnpm.cjs");
        std::fs::create_dir_all(pnpm_bin.parent().unwrap()).unwrap();
        std::fs::write(&pnpm_bin, "fixture").unwrap();
        let selected = dir.join("selected.cmd");
        let node = dir.join("node.cmd");
        std::fs::write(&selected, "@echo off\r\necho SELECTED\r\n").unwrap();
        std::fs::write(&node, "@echo off\r\necho BUNDLED %*\r\nexit /b 0\r\n").unwrap();
        let shim = dir.join("pnpm.cmd");
        std::fs::write(&shim, build_pnpm_cmd_shim(&app_dir)).unwrap();
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let system32 = PathBuf::from(&system_root).join("System32");
        let output = std::process::Command::new(system32.join("cmd.exe"))
            .args(["/d", "/c"])
            .arg(&shim)
            .arg("both-vars")
            .env("PATH", &system32)
            .env("SystemRoot", system_root)
            .env("DSH_NODE", &node)
            .env("DSH_PNPM", &selected)
            .env("DSH_PREFER_BUNDLED_PNPM", "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success());
        assert!(stdout.contains("BUNDLED"));
        assert!(!stdout.contains("SELECTED"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pnpm_ps1_shim_contains_user_precedence() {
        let content = build_pnpm_ps1_shim(&sample_app_dir());
        assert!(content.contains("Get-Command pnpm -All"));
        assert!(content.contains("$PSScriptRoot"));
        assert!(content.contains("$userPnpm.Source"));
        assert!(content.contains("@args"));
        assert!(content.contains("Join-Path $appDir 'runtime\\node.exe'"));
        assert!(content.contains("$env:DSH_PREFER_BUNDLED_PNPM"));
        assert!(content.contains("$env:DSH_PNPM"));
        let bundled_at = content.find("$useBundled =").unwrap();
        let exact_at = content.find("& $env:DSH_PNPM @args").unwrap();
        let path_at = content.find("Get-Command pnpm -All").unwrap();
        assert!(bundled_at < exact_at && exact_at < path_at);
    }

    #[cfg(windows)]
    #[test]
    fn pnpm_ps1_shim_dispatches_exact_path_with_spaces_args_and_exit_code() {
        let dir = temp_dir("pnpm-ps1-selected");
        let selected = dir.join("selected pnpm.cmd");
        std::fs::write(&selected, "@echo off\r\necho SELECTED:%*\r\nexit /b 37\r\n").unwrap();
        let shim = dir.join("pnpm.ps1");
        std::fs::write(&shim, build_pnpm_ps1_shim(&dir.join("app"))).unwrap();
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let powershell =
            PathBuf::from(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let output = std::process::Command::new(powershell)
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&shim)
            .args(["alpha beta", "gamma"])
            .env("DSH_PNPM", &selected)
            .env("DSH_PREFER_BUNDLED_PNPM", "1")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(37));
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("SELECTED:\"alpha beta\" gamma"),
            "unexpected stdout: {stdout:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn pnpm_ps1_shim_prefers_existing_bundle_over_selected_path() {
        let dir = temp_dir("pnpm-ps1-both-vars");
        let app_dir = dir.join("app");
        let pnpm_bin = app_dir.join("dependencies/pnpm/bin/pnpm.cjs");
        std::fs::create_dir_all(pnpm_bin.parent().unwrap()).unwrap();
        std::fs::write(&pnpm_bin, "fixture").unwrap();
        let selected = dir.join("selected.cmd");
        let node = dir.join("node.cmd");
        std::fs::write(&selected, "@echo off\r\necho SELECTED\r\n").unwrap();
        std::fs::write(&node, "@echo off\r\necho BUNDLED %*\r\nexit /b 0\r\n").unwrap();
        let shim = dir.join("pnpm.ps1");
        std::fs::write(&shim, build_pnpm_ps1_shim(&app_dir)).unwrap();
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let powershell =
            PathBuf::from(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let output = std::process::Command::new(powershell)
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&shim)
            .arg("both-vars")
            .env("DSH_NODE", &node)
            .env("DSH_PNPM", &selected)
            .env("DSH_PREFER_BUNDLED_PNPM", "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(stdout.contains("BUNDLED"), "unexpected stdout: {stdout:?}");
        assert!(!stdout.contains("SELECTED"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pnpm_sh_shim_contains_user_precedence() {
        let content = build_pnpm_sh_shim(&sample_app_dir());
        assert!(content.starts_with("#!/bin/sh"));
        assert!(content.contains(r#"exec "$dir/pnpm" "$@""#));
        assert!(content.contains("SELF_DIR"));
        assert!(content.contains(r#"exec "$NODE" "$PNPM_BIN" "$@""#));
        assert!(content.contains(r#"$APP_DIR/runtime/bin/node"#));
        assert!(content.contains("DSH_PREFER_BUNDLED_PNPM"));
        assert!(content.contains(r#"exec "$DSH_PNPM" "$@""#));
        let bundled_at = content.find("USE_BUNDLED=").unwrap();
        let exact_at = content.find(r#"exec "$DSH_PNPM" "$@""#).unwrap();
        let path_at = content.find("for dir in $PATH").unwrap();
        assert!(bundled_at < exact_at && exact_at < path_at);
    }

    #[cfg(unix)]
    #[test]
    fn pnpm_sh_shim_dispatches_exact_path_with_spaces_args_and_exit_code() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("pnpm-sh-selected");
        let selected = dir.join("selected pnpm");
        std::fs::write(
            &selected,
            "#!/bin/sh\nprintf 'SELECTED:%s\\n' \"$*\"\nexit 37\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&selected).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&selected, permissions).unwrap();
        let shim = dir.join("pnpm");
        std::fs::write(&shim, build_pnpm_sh_shim(&dir.join("app"))).unwrap();
        let mut permissions = std::fs::metadata(&shim).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&shim, permissions).unwrap();

        let output = std::process::Command::new(&shim)
            .args(["alpha beta", "gamma"])
            .env("PATH", "/usr/bin:/bin")
            .env("DSH_PNPM", &selected)
            .env("DSH_PREFER_BUNDLED_PNPM", "1")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(37));
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "SELECTED:alpha beta gamma\n"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn pnpm_sh_shim_prefers_existing_bundle_over_selected_path() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("pnpm-sh-both-vars");
        let app_dir = dir.join("app");
        let pnpm_bin = app_dir.join("dependencies/pnpm/bin/pnpm.cjs");
        std::fs::create_dir_all(pnpm_bin.parent().unwrap()).unwrap();
        std::fs::write(&pnpm_bin, "fixture").unwrap();
        let selected = dir.join("selected");
        let node = dir.join("node");
        std::fs::write(&selected, "#!/bin/sh\necho SELECTED\n").unwrap();
        std::fs::write(&node, "#!/bin/sh\necho BUNDLED \"$@\"\n").unwrap();
        for path in [&selected, &node] {
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(path, permissions).unwrap();
        }
        let shim = dir.join("pnpm");
        std::fs::write(&shim, build_pnpm_sh_shim(&app_dir)).unwrap();
        let mut permissions = std::fs::metadata(&shim).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&shim, permissions).unwrap();

        let output = std::process::Command::new(&shim)
            .arg("both-vars")
            .env("PATH", "/usr/bin:/bin")
            .env("DSH_NODE", &node)
            .env("DSH_PNPM", &selected)
            .env("DSH_PREFER_BUNDLED_PNPM", "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success());
        assert!(stdout.contains("BUNDLED"));
        assert!(!stdout.contains("SELECTED"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// issue #121：桌面端注入的 DSH_NODE（预检解析出的 node 路径）必须在
    /// 本地 node / 捆绑运行时解析之前被采用——shim 与应用预检保持一致。
    #[test]
    fn cmd_shim_prefers_dsh_node_before_local_node() {
        let content = build_cmd_shim(&sample_app_dir(), &sample_dsh_home());
        let dsh_node_at = content.find("DSH_NODE").unwrap();
        let where_node_at = content.find("where node").unwrap();
        // `:node_dsh` 标签行（独占一行）位于 `:node_ok` 之后、`:use_bundled`
        // 之前；`goto :node_dsh` 引用出现在 `where node` 之前，不能作为定位点。
        let node_dsh_label_at = content.find("\n:node_dsh").unwrap();
        let node_ok_at = content.find("\n:node_ok").unwrap();
        assert!(
            dsh_node_at < where_node_at,
            "DSH_NODE must be checked before the local node search"
        );
        assert!(content.contains(r#"set "NODE=%DSH_NODE%""#));
        assert!(
            node_ok_at < node_dsh_label_at,
            "the :node_dsh label must come after :node_ok"
        );
    }

    #[test]
    fn ps1_shim_prefers_dsh_node_before_local_node() {
        let content = build_ps1_shim(&sample_app_dir(), &sample_dsh_home());
        let dsh_node_at = content.find("$env:DSH_NODE").unwrap();
        let local_at = content.find("Get-Command node").unwrap();
        assert!(
            dsh_node_at < local_at,
            "DSH_NODE must be checked before the local node search"
        );
    }

    #[test]
    fn sh_shim_prefers_dsh_node_before_local_node() {
        #[cfg(not(windows))]
        {
            let content = build_sh_shim(&sample_app_dir(), &sample_dsh_home());
            let dsh_node_at = content.find("$DSH_NODE").unwrap();
            let local_at = content.find("command -v node").unwrap();
            assert!(
                dsh_node_at < local_at,
                "DSH_NODE must be checked before the local node search"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    #[cfg(windows)]
    fn ps1_shim_escapes_quotes() {
        let dir = PathBuf::from(
            r"C:\Users\o'brien\AppData\Roaming\io.github.hairyf.deepseek-harness-desktop",
        );
        let content = build_ps1_shim(&dir, &sample_dsh_home());
        assert!(content.contains(r"o''brien"));
        // dsh_home 同样走 ps1 转义
        assert!(content.contains(r"C:\Users\test\.dsh"));
    }

    #[test]
    fn cmd_shim_prefers_user_dsh() {
        let content = build_cmd_shim(&sample_app_dir(), &sample_dsh_home());
        assert!(content.contains("USER_DSH"));
        assert!(content.contains(r#"call "%USER_DSH%" %*"#));
        assert!(content.contains("SELF_PREFIX"));
        // 用户 dsh 优先转发应出现在捆绑启动之前
        let user_at = content.find("USER_DSH").unwrap();
        let bundled_at = content.find(":use_bundled").unwrap();
        assert!(user_at < bundled_at);
    }

    #[test]
    fn ps1_shim_prefers_user_dsh() {
        let content = build_ps1_shim(&sample_app_dir(), &sample_dsh_home());
        assert!(content.contains("Get-Command dsh -All"));
        assert!(content.contains("$userDsh.Source"));
        assert!(content.contains("$PSScriptRoot"));
        // DSH_HOME 绑定只在捆绑启动分支注入（转发用户 dsh 时保留用户环境）
        let user_at = content.find("$userDsh").unwrap();
        let home_at = content.find("$env:DSH_HOME = $dshHome").unwrap();
        assert!(user_at < home_at);
    }

    #[test]
    fn sh_shim_prefers_user_dsh() {
        #[cfg(not(windows))]
        {
            let content = build_sh_shim(&sample_app_dir(), &sample_dsh_home());
            assert!(content.contains(r#"exec "$dir/dsh" "$@""#));
            assert!(content.contains("SELF_DIR"));
            // 用户 dsh 优先 > 注入 DSH_HOME
            let user_at = content.find(r#""$dir/dsh""#).unwrap();
            let home_at = content.find("export DSH_HOME").unwrap();
            assert!(user_at < home_at);
        }
    }

    #[test]
    fn foreign_file_detection() {
        let dir = std::env::temp_dir().join(format!("dsh-shim-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 用户手动放置的 dsh 脚本 -> 视为 foreign，不应被覆盖
        let user_dsh = dir.join(if cfg!(windows) { "dsh.cmd" } else { "dsh" });
        std::fs::write(&user_dsh, "#!/bin/sh\necho my real dsh\n").unwrap();
        assert!(
            is_foreign_file(&user_dsh),
            "user file must be treated as foreign"
        );

        // 本应用生成的 shim -> 不是 foreign，可覆盖
        #[cfg(not(windows))]
        let generated = build_sh_shim(&sample_app_dir(), &sample_dsh_home());
        #[cfg(windows)]
        let generated = build_cmd_shim(&sample_app_dir(), &sample_dsh_home());
        std::fs::write(&user_dsh, generated).unwrap();
        assert!(
            !is_foreign_file(&user_dsh),
            "generated shim must not be foreign"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------------
    // write_shim_file 目标文件处理（悬空符号链接 / 用户文件保留 / 生成文件覆盖）
    // ------------------------------------------------------------------

    /// 独立的临时目录，避免测试间互相干扰
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-shim-write-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 悬空符号链接（官方 dsh 安装器残留 `~/.local/bin/dsh -> ~/.dsh/source/current/bin/dsh`
    /// 且目标已消失）时：先移除失效链接，再正常写入生成 shim——修复原报错
    /// `write ... failed: No such file or directory (os error 2)`
    #[test]
    #[cfg(unix)]
    fn write_shim_file_removes_dangling_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("dangling");
        let target = dir.join("dsh");
        symlink(dir.join("missing/source/current/bin/dsh"), &target).unwrap();
        assert!(is_dangling_symlink(&target));

        write_shim_file(&target, "#!/bin/sh\ngenerated shim\n").unwrap();

        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "#!/bin/sh\ngenerated shim\n"
        );
        assert!(
            !std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink(),
            "dangling symlink must be replaced by a regular file"
        );
        assert!(!is_dangling_symlink(&target));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 指向真实用户 dsh 的符号链接（目标仍存在）→ 视为用户文件，保留不动
    #[test]
    #[cfg(unix)]
    fn write_shim_file_preserves_valid_user_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("userlink");
        let real = dir.join("real-dsh");
        std::fs::write(&real, "#!/bin/sh\necho my real dsh\n").unwrap();
        let target = dir.join("dsh");
        symlink(&real, &target).unwrap();

        write_shim_file(&target, "#!/bin/sh\ngenerated shim\n").unwrap();

        assert!(
            std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink(),
            "valid user symlink must be preserved"
        );
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            "#!/bin/sh\necho my real dsh\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本应用生成的 shim → 覆盖自愈内容
    #[test]
    fn write_shim_file_overwrites_generated_shim() {
        let dir = temp_dir("overwrite");
        let target = dir.join("dsh");
        std::fs::write(
            &target,
            "#!/bin/sh\n# DeepSeek Harness Desktop - old shim\n",
        )
        .unwrap();

        write_shim_file(
            &target,
            "#!/bin/sh\n# DeepSeek Harness Desktop - new shim\n",
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "#!/bin/sh\n# DeepSeek Harness Desktop - new shim\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
