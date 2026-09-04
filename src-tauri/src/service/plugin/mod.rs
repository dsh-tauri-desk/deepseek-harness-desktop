//! 预装插件：首次启动引导安装官方推荐插件（当前为 DSH Market）。
//!
//! 安装通过 `dsh plugin --profile <当前档案> add <pkg>` 完成：该子命令是 pnpm
//! 转发器，会在 `$DSH_HOME/profiles/<当前档案>` 初始化 profile 并执行 `pnpm add`，
//! 随后把声明了 `dsh.bundle` 的依赖写入 profile 的 bundles 层，使插件在下次
//! 启动时加载。进程输出逐行通过 `preinstall-log` 事件实时推送给前端日志面板。
//! 调用 dsh 前会先按需补齐捆绑 pnpm（老版本升级后可能缺失，安装流程内自愈）。
//!
//! 社区预设与内部插件分别存放在随安装包分发的 `resources/preset-plugins.json`
//! 和 `resources/internal-plugins.json`；新增条目无需改动 Rust 代码。
//!
//! **重新进入引导的判定**：该 JSON 随安装包发布、每次安装都被强制覆盖，旧文件不可比对，
//! 因此引导结束（确认/跳过）时把文件内容指纹（FNV-1a）写入 app-data 的 `.store.dat`；
//! 每次启动重新计算当前指纹，不一致（清单有变更）即重新进入预设引导；老用户无基线时
//! 弹一次建立基线（见 [`preset::preinstall_pending`]）。
//!
//! 模块划分（参考 `service/cli/`、`service/download/`）：
//! - [`preset`]：预设与内部插件清单读取、合并及资源目录定位
//! - [`installed`]：profile 内已安装插件检测（解析 package.json 的依赖与 bundles）
//! - [`internal`]：内置插件启动自愈（随包分发产物缺失/路径变更时强制重装）
//! - [`verify`]：预装插件完整性自检（清单引用但 node_modules 产物缺失时 `pnpm install` 修复）
//! - [`install`]：对外安装/升级/卸载编排（目录模块 `install/`：编排入口、spec 准备、
//!   子进程环境、pnpm 选版、allowBuilds 白名单、错误诊断与产物核验），
//!   以及启动时对 `resources/deprecated-plugins.json` 登记的社区插件自动卸载
//! - [`errors`]：插件错误记录（安装/升级/卸载失败 + 页面运行期上报，持久化）
//! - [`process`]：dsh 子进程启动与输出流逐行转发
//! - [`cancel`]：Windows 下取消正在进行的安装
//! - [`watch`]：已安装插件文件监控（轮询指纹比对 + `dsh-plugins-updated` 事件推送）

mod cancel;
pub mod disable;
pub mod errors;
mod install;
mod installed;
mod internal;
mod preset;
mod process;
pub mod recovery;
pub mod snapshot;
pub mod update;
pub mod verify;
pub mod watch;

pub(crate) use crate::service::profile::ensure_profile_pnpm_policy;
pub use cancel::cancel;
pub(crate) use install::harness_prefer_bundled_pnpm;
pub(crate) use install::uninstall_deprecated_plugins;
pub use install::{install, remove, update};
pub(crate) use installed::ensure_profile_npmrc;
pub use installed::{list, PreinstallPlugin};
pub(crate) use internal::cancel as cancel_internal_plugins;
pub(crate) use internal::ensure as ensure_internal_plugins;
pub use preset::repo_url_of;
pub(crate) use preset::{
    bundled_plugin_dir, current_preset_hash, preinstall_pending, remove_legacy_bundled_plugins,
};
pub use disable::{disable, enable};
pub use recovery::{
    detect as detect_recovery, uninstall as uninstall_recovery, PluginRecoveryInfo,
};
pub(crate) use verify::ensure_preset_plugins;
pub use watch::DshPlugin;
