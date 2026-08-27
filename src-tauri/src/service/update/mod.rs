//! 桌面应用自更新模块。
//!
//! 与 `dsh` 内核更新（`download` 模块）不同，这里负责「DeepSeek Harness 桌面端」
//! 自身的更新。应用内自动更新（检查 / 下载 / 安装 / 重启）已迁移到官方
//! `tauri-plugin-updater`：前端通过 `@tauri-apps/plugin-updater` 的 JS API 直接
//! 调用（capabilities 已授予 `updater:default`），不再经自定义命令下载安装包。
//! 本模块只保留：
//! - [`about`]：About 对话框信息（版本 / 发布时间 / 版权 / 仓库）
//!
//! 模块划分：
//! - [`meta`]：GitHub Release 元数据拉取（供 About 展示发布时间）
//! - [`version`]：版本工具（供 meta / about 使用）
//! - [`about`]：About 对话框信息

mod about;
mod meta;
mod version;

pub use about::{about, DesktopAboutInfo};

/// 仓库主页（同时用于 About 跳转与发布页链接）
const REPO_URL: &str = "https://github.com/hairyf/deepseek-harness-desktop";
/// 版权信息（与 tauri.conf.json bundle.copyright 保持一致）
const COPYRIGHT: &str = "Copyright © 2026 Deepseek Harness Desktop contributors";
/// About 对话框的 "Powered by" 文案
const POWERED_BY: &str = "DeepSeek Harness";
