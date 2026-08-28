//! renderer 一行导出补丁：给活动核心的 dsh-client-ui-renderer 补上 SlotOutlet 导出。
//!
//! dsh-tauri-ui 插件的设置侧边栏依赖 `<SlotOutlet>`（任意槽渲染入口）。官方
//! renderer 的 `lib/client.js` 只导出 `{apply, inject}`——SlotOutlet 实现完整
//! 却未公开，上游也没提供跨键渲染 API（插件只能 shadow 官方条目再自己渲染他人
//! 声明的槽，而这必须经过 SlotOutlet）。补丁在文件末尾的 `return module.exports;`
//! 前插入一行 `exports.SlotOutlet = SlotOutlet;`，与开发期手工补丁逐字节一致。
//!
//! 目标选择：**活动核心**，而不是永远指向预打包核心。桌面端支持「本地核心」
//! （用户在 PATH / 全局安装的 dsh，`CoreSource::Local`）与「预打包核心」
//! （`CoreSource::App`）两种来源，运行时 web 应用通过 `$DSH_HOME/profiles/<档案>/
//! node_modules/@deepseek-ai/dsh-client-ui-renderer`（对活动核心 renderer 的链接）
//! 解析该模块。旧实现恒用 [`config::get_dsh_install_path`]（预打包目录），本地核心
//! 激活时会补到一个**永远不会被加载**的文件上——日志显示已注入，web 应用却仍拿到
//! 未打补丁的 renderer，dsh-tauri-ui 于是降级为官方设置 dialog。因此这里按
//! [`crate::service::core::active_source`] 选目录：本地核心用其包目录，预打包用
//! 桌面端目录；两者回退逻辑与 [`crate::service::core::active_dsh_binary`] 一致。
//!
//! 幂等与容错：
//! - 目标已含 `exports.SlotOutlet` 即跳过——上游将来自己导出（或已提的一行 PR
//!   合入）后本模块自动退休，零维护；
//! - 文件缺失或锚点（`return module.exports;`）因上游布局变更而找不到 → 跳过
//!   并告警，不阻断启动——插件侧另有降级（SlotOutlet 不可用时保留官方设置 dialog，
//!   绝不白屏）。
//!
//! 挂点：`service::workflow::launch` 启动 dsh 进程前，与 win_inspector / ensure_*
//! 自愈链同一位置（最佳努力，失败只告警）。

use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::service::core::{active_source, local_core_package_dir, CoreSource};

/// 导出锚点的关键字（所在行的前导缩进随版本变化，不做硬编码）。
const ANCHOR_KEYWORD: &str = "return module.exports;";

/// 单条 renderer client.js 内容的补丁结果。
#[derive(Debug, PartialEq, Eq)]
enum PatchOutcome {
    /// 已含 `exports.SlotOutlet`，无需补丁（本补丁已生效或上游官方导出）。
    AlreadyPatched,
    /// 锚点缺失（上游布局变更），跳过；插件降级兜底，不阻断。
    AnchorMissing,
    /// 已插入导出行，携带补丁后的完整内容。
    Patched(String),
}

/// 幂等补丁逻辑的纯函数部分（便于单测，不触碰文件系统）。
///
/// 定位 `return module.exports;` 所在行，按其**实际前导缩进**（tab/空格数随上游
/// 打包产物变化）插入同缩进的导出行——旧实现硬编码单 tab 锚点，upstream 产物
/// 用双 tab 时会在字符串内部命中、插出缩进错乱的坏行。
fn patch_source(source: &str) -> PatchOutcome {
    if source.contains("exports.SlotOutlet") {
        return PatchOutcome::AlreadyPatched;
    }
    let Some((line_start, indent)) = locate_return_module_exports(source) else {
        return PatchOutcome::AnchorMissing;
    };
    let mut patched = source.to_string();
    patched.insert_str(
        line_start,
        &format!("{indent}exports.SlotOutlet = SlotOutlet;\n"),
    );
    PatchOutcome::Patched(patched)
}

/// 定位 `return module.exports;` 所在行的行首字节偏移与其前导缩进。
///
/// 返回 `(行首偏移, 前导空白)`；行首到关键字之间必须是纯空白，否则不是锚行
/// （防御上游后续把 `return module.exports;` 挪进表达式里）。
fn locate_return_module_exports(source: &str) -> Option<(usize, &str)> {
    let match_start = source.find(ANCHOR_KEYWORD)?;
    let line_start = source[..match_start]
        .rfind('\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let indent = &source[line_start..match_start];
    if !indent.chars().all(|c| c == '\t' || c == ' ') {
        return None;
    }
    Some((line_start, indent))
}

/// 对活动核心的 dsh-client-ui-renderer `lib/client.js` 应用补丁（幂等）。
/// 返回 Err 表示读/写失败；文件缺失、已打过、锚点变更均静默跳过（Ok）。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let client_js: PathBuf = active_core_renderer_client_js(app_handle);
    if !client_js.exists() {
        log::info!(
            "renderer client.js not found, skip SlotOutlet patch: {}",
            client_js.display()
        );
        return Ok(());
    }
    let source = fs::read_to_string(&client_js)
        .map_err(|e| format!("RENDERER_PATCH_READ: {} failed: {e}", client_js.display()))?;
    match patch_source(&source) {
        PatchOutcome::AlreadyPatched => {
            log::info!("renderer already exports SlotOutlet, skip patch");
        }
        PatchOutcome::AnchorMissing => {
            log::warn!(
                "renderer client.js anchor missing, skip SlotOutlet patch — plugin degrades to official settings dialog: {}",
                client_js.display()
            );
        }
        PatchOutcome::Patched(patched) => {
            fs::write(&client_js, patched).map_err(|e| {
                format!("RENDERER_PATCH_WRITE: {} failed: {e}", client_js.display())
            })?;
            log::info!(
                "renderer SlotOutlet export patched: {}",
                client_js.display()
            );
        }
    }
    Ok(())
}

/// 活动核心安装目录：本地核心用其包目录（全局安装路径），预打包用桌面端目录。
///
/// 与 [`crate::service::core::active_dsh_binary`] 的取舍一致——本地核心解析在
/// 调用瞬间失效时回退预打包目录，绝不让旧实现那样恒打在一个不加载的文件上。
fn active_core_install_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    match active_source(app_handle) {
        CoreSource::Local => local_core_package_dir(app_handle)
            .unwrap_or_else(|| config::get_dsh_install_path(app_handle)),
        CoreSource::App => config::get_dsh_install_path(app_handle),
    }
}

/// 活动核心 renderer 的 `lib/client.js` 路径。
fn active_core_renderer_client_js(app_handle: &tauri::AppHandle) -> PathBuf {
    active_core_install_dir(app_handle)
        .join("node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实打包产物末尾的五行（单 tab 缩进；与旧实现测试锚点一致）。
    const TAIL: &str = "\t\t//#endregion\n\t\texports.apply = apply;\n\t\texports.inject = inject;\n\treturn module.exports;\n\t}\n});\n";

    /// 上游产物双 tab 缩进（回归：旧硬编码单 tab 锚点在此处命中坏位置）。
    const TAIL_DOUBLE_TAB: &str = "\t\t//#endregion\n\t\texports.apply = apply;\n\t\texports.inject = inject;\n\t\treturn module.exports;\n\t}\n});\n";

    #[test]
    fn patch_inserts_export_before_return() {
        match patch_source(TAIL) {
            PatchOutcome::Patched(patched) => {
                assert!(patched.contains("exports.SlotOutlet = SlotOutlet;"));
                assert!(patched.contains(
                    "\t\texports.inject = inject;\n\texports.SlotOutlet = SlotOutlet;\n\treturn module.exports;\n"
                ));
            }
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    #[test]
    fn patch_matches_double_tab_indentation() {
        // 回归：upstream 产物用双 tab 缩进，旧实现会命中 `\treturn` 子串、插出
        // 缩进错乱的坏行。新实现按行首缩进插入，导出行与 `return` 对齐（双 tab）。
        match patch_source(TAIL_DOUBLE_TAB) {
            PatchOutcome::Patched(patched) => {
                assert!(patched.contains(
                    "\t\texports.inject = inject;\n\t\texports.SlotOutlet = SlotOutlet;\n\t\treturn module.exports;\n"
                ));
                // 不产生把 return 缩进削掉一格的坏行
                assert!(!patched.contains("\n\texports.SlotOutlet = SlotOutlet;\n\treturn"));
            }
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(TAIL) else {
            panic!("expected Patched");
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn patch_skips_when_anchor_missing() {
        let altered = "\t\texports.apply = apply;\n\t\texports.inject = inject;\n";
        assert_eq!(patch_source(altered), PatchOutcome::AnchorMissing);
    }
}
