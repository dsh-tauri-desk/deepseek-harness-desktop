//! 桌面应用自更新模块。
//!
//! 与 `dsh` 内核更新（`download` 模块）不同，这里负责「DeepSeek Harness 桌面端」
//! 自身的更新：查询 GitHub Release 的最新版本、下载安装包、并交给系统打开安装器。
//!
//! 设计考量：
//! - 每次「检查更新」都实时向 GitHub 查询最新 Release（不做缓存），保证看到的
//!   永远是最新发布，不会因上传期间的旧结果而误判「已是最新」。
//! - 通过 GitHub 的 **HTML/atom 页面**（releases.atom、expanded_assets）而非
//!   api.github.com 查询，绕开未认证 API 60 次/小时/IP 的限流。
//! - 只对**正式版**（纯数字版本）提示更新：rc/beta/alpha 与手动测试 release
//!   （`test-*` tag）一律跳过（见 [`version`] 的 `is_stable`），不会把测试版
//!   推给用户；装了 rc 的用户仍会按 semver 收到之后的正式版通知。
//! - 安装包下载到 AppData/updates 目录；已存在则视为「已下载」，不再重复拉取。
//! - 打开安装器（exe/msi/dmg 等）交给系统默认处理器（ShellExecute/LaunchServices）。
//! - 下载完成的安装包登记为「待安装」（见 [`pending`]）：用户没立刻安装时，
//!   关闭应用的那一刻自动打开安装器，避免用户错过升级。
//!
//! 模块划分（参考 `service/cli/`、`service/download/`）：
//! - [`version`]：版本比较与当前平台安装包资产选择
//! - [`meta`]：GitHub Release 元数据拉取（最新 tag / 资产 / SHA-256 摘要）
//! - [`install`]：安装包下载、完整性校验与打开安装器
//! - [`pending`]：「待安装」标记与退出时自动打开安装器
//! - [`about`]：About 对话框信息

mod about;
mod install;
mod meta;
mod pending;
mod version;

pub use about::{about, DesktopAboutInfo};
// DesktopDownloadProgress 为对外公开的事件载荷类型（当前链路未直接引用，属有意保留）。
#[allow(unused_imports)]
pub use install::{check, download, open_installer, DesktopDownloadProgress, DesktopUpdateInfo};
pub use pending::launch_pending_installer;

/// 仓库主页（同时用于构造 atom / expanded_assets / 下载地址）
const REPO_URL: &str = "https://github.com/hairyf/deepseek-harness-desktop";
/// 版权信息（与 tauri.conf.json bundle.copyright 保持一致）
const COPYRIGHT: &str = "Copyright © 2026 Deepseek Harness Desktop contributors";
/// About 对话框的 "Powered by" 文案
const POWERED_BY: &str = "DeepSeek Harness";
/// AppData 下安装包存放目录名
const UPDATES_DIR: &str = "updates";
/// 安装包下载总时长上限（秒）。
///
/// `reqwest` 的 `.timeout()` 是含响应体读取在内的**总**时长。安装包常达数百 MB，
/// 慢镜像下 120s 会掐断合法下载，故放宽到 30 分钟；真正断死的连接会由流读取
/// 报错提前退出，不会真的等到超时。
const DOWNLOAD_TIMEOUT_SECS: u64 = 1800;
