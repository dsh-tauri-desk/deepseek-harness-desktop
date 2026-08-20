//! 预装插件：首次启动引导安装官方推荐插件（当前为 DSH Market）。
//!
//! 安装通过 `dsh plugin --profile web add <pkg>` 完成：该子命令是 pnpm 转发器，
//! 会在 `$DSH_HOME/profiles/web` 初始化 profile 并执行 `pnpm add`，随后把声明了
//! `dsh.bundle` 的依赖写入 profile 的 bundles 层，使插件在下次启动时加载。
//! 进程输出逐行通过 `dsh-plugin-command-log` 事件实时推送给前端日志面板。
//! 调用 dsh 前会先按需补齐捆绑 pnpm（老版本升级后可能缺失，安装流程内自愈）。
//!
//! 预设清单存放在随安装包分发的 `resources/preset-plugins.json`：社区新增推荐插件
//! 只需在该 JSON 中追加一项并提交 PR，无需改动 Rust 代码；界面与安装逻辑自动生效。
//!
//! **重新进入引导的判定**：该 JSON 随安装包发布、每次安装都被强制覆盖，旧文件不可比对，
//! 因此引导结束（确认/跳过）时把文件内容指纹（FNV-1a）写入 app-data 的 `.store.dat`；
//! 每次启动重新计算当前指纹，不一致（清单有变更）即重新进入预设引导；老用户无基线时
//! 弹一次建立基线（见 [`preset::preinstall_pending`]）。
//!
//! 模块划分（参考 `service/cli/`、`service/download/`）：
//! - [`preset`]：预设清单读取与解析（`resources/preset-plugins.json`）
//! - [`installed`]：profile 内已安装插件检测（解析 package.json 的依赖与 bundles）
//! - [`install`]：安装/移除编排（校验输入、准备环境、调用 dsh 子进程）
//! - [`process`]：dsh 子进程启动与输出流逐行转发
//! - [`cancel`]：Windows 下取消正在进行的安装
//! - [`watch`]：已安装插件文件监控（轮询指纹比对 + `dsh-plugins-updated` 事件推送）

mod cancel;
mod install;
mod installed;
mod preset;
mod process;
pub mod watch;

pub use cancel::cancel;
pub use install::install;
pub use install::remove;
pub use installed::{list, PreinstallPlugin};
pub use preset::repo_url_of;
pub(crate) use preset::{current_preset_hash, preinstall_pending};
pub use watch::DshPlugin;