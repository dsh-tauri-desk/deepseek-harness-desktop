//! dsh 包文件补丁集。
//!
//! 集中存放对活动核心安装目录下 `node_modules/<包>/...` 里的 JS 文件做的一次性
//! 幂等补丁。每个补丁是一个子模块，只提供「纯函数式补丁判定 + apply 触发」；
//! 「定位文件 → 读取 → 打补丁 → 写回」与对应日志由 [`crate::utils::patch_dsh`]
//! 统一处理，避免每个补丁重复这份样板。
//!
//! 命名约定：子模块名不带 `_patch` 后缀（`renderer` / `session` / `workspace` /
//! `client_hmr`），挂点统一为 `service::workflow::launch`，均为最佳努力、失败仅告警。

pub(crate) mod alpha_auth;
pub(crate) mod client_hmr;
pub(crate) mod renderer;
pub(crate) mod session;
pub(crate) mod workspace;
