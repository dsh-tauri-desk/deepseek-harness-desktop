//! 信任模式（Trust Mode）：切换 Harness 的权限预设，免除逐次执行审批。
//!
//! ## 背景
//! Harness 的 shell 工具默认运行在 `workspace-write` 沙箱下；命令需要更高权限时，
//! `@deepseek-ai/dsh-user-approval`（`ctx.approval`）会弹出**一次性**审批
//! （「允许一次」/「拒绝」，fail-closed）。高频开发场景下每次执行都要点一次确认，
//! 体验割裂。
//!
//! ## 机制
//! Harness 官方的 `@deepseek-ai/dsh-permission-presets` 把「沙箱模式 + 审批策略」
//! 打包为具名预设，表内两项为：
//! - `workspace-write` → sandbox `workspace-write` + approval `ask`（默认，逐次询问）
//! - `danger-full-access` → sandbox `danger-full-access` + approval `never`（不再询问）
//!
//! 该选择持久化在 `$DSH_HOME/settings.yaml` 的 `permissionPresets.defaultPreset`，
//! 由 harness 在**新建会话时**读取并固定到该会话（既有会话不受影响，也不会因为
//! 运行中改文件而被追溯改写）。
//!
//! 本模块即通过幂等地改写这一项来开关信任模式：**不改动任何 agent preset 组成、
//! 不依赖 harness 内部 RPC**——只用其声明式的配置契约，因此跨平台一致、可随时
//! 关回 `workspace-write`，且不损失当前 preset 的任何能力。
//!
//! ## 落盘策略
//! `settings.yaml` 同时由 harness 进程读写，故采用**文本级最小编辑**：只定位或追加
//! `permissionPresets` 分节下的 `defaultPreset` 一行，其余内容（注释、缩进、其它
//! 分节）原样保留，避免 YAML 往返序列化丢注释、也缩小与 harness 写入的竞态窗口。

use std::fs;
use std::path::PathBuf;

/// settings 文件中承载权限预设的分节名。
const SECTION: &str = "permissionPresets";
/// 分节内表示「未来会话使用的预设」的键。
const KEY: &str = "defaultPreset";
/// 信任模式取值：非受限沙箱 + 不再询问。
const TRUST_PRESET: &str = "danger-full-access";
/// 默认取值：工作区可写沙箱 + 逐次询问。
const ASK_PRESET: &str = "workspace-write";

/// `$DSH_HOME/settings.yaml`：harness 的用户级设置（debug 构建自动指向 `~/.dsh.dev`）。
fn settings_path(app_handle: &tauri::AppHandle) -> PathBuf {
    crate::config::get_dsh_data_path(app_handle).join("settings.yaml")
}

/// 读取 settings 文本中当前的权限预设名；未配置该分节/键时返回 `None`。
///
/// 只认识「顶格分节 + 两空格缩进的直接子键」这一种规整形态：遇到下一个顶格
/// 键即认为分节结束，更深层嵌套不会误判成本分节的键。
fn read_preset(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let header = format!("{SECTION}:");
    let sec = lines.iter().position(|l| l.trim_end() == header)?;
    let key_prefix = format!("  {KEY}:");

    for line in lines.iter().skip(sec + 1) {
        let trimmed = line.trim_end();
        // 顶格且非空、非注释 → 已离开本分节
        if !trimmed.is_empty() && !trimmed.starts_with('#') && !starts_indented(line) {
            break;
        }
        if let Some(rest) = line.strip_prefix(key_prefix.as_str()) {
            let value = rest.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// 在 YAML 文本里把顶层 `section` 分节下的 `key` 设为 `value`（幂等，保持规整缩进）。
///
/// 分节已存在时：命中同名键则替换其值，否则插到该分节的**末尾**（即下一个顶格
/// 键之前，或文件末尾）。分节不存在时：追加到文件末尾。始终以单个换行结尾。
fn upsert_scalar(text: &str, section: &str, key: &str, value: &str) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let header = format!("{section}:");
    let key_prefix = format!("  {key}:");
    let rendered = format!("  {key}: {value}");

    if let Some(sec) = lines.iter().position(|l| l.trim_end() == header) {
        let mut replace_at = None;
        let mut insert_at = lines.len();

        for i in (sec + 1)..lines.len() {
            let line = &lines[i];
            let trimmed = line.trim_end();
            if !trimmed.is_empty() && !trimmed.starts_with('#') && !starts_indented(line) {
                insert_at = i; // 下一个顶格键：分节到此结束，插在它前面
                break;
            }
            if line.starts_with(&key_prefix) {
                replace_at = Some(i);
                break;
            }
        }

        match replace_at {
            Some(i) => lines[i] = rendered,
            None => lines.insert(insert_at, rendered),
        }
        return join_lines(lines);
    }

    // 分节不存在：去掉尾部空行后追加，避免与前文之间夹一段空行。
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    lines.push(header);
    lines.push(rendered);
    join_lines(lines)
}

/// 该行是否以空白开头（即属于某个分节的缩进内容）。
fn starts_indented(line: &str) -> bool {
    line.starts_with(char::is_whitespace)
}

/// 把行序列拼回文本，并保证以换行结尾。
fn join_lines(lines: Vec<String>) -> String {
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// 信任模式是否已开启（即默认预设为 `danger-full-access`）。
///
/// 文件缺失或键未配置时按 harness 的默认行为（逐次询问）返回 `false`；读取失败
/// 同样返回 `false`——这是只读查询，不宜让设置面板因之报错。
pub fn trust_mode_enabled(app_handle: &tauri::AppHandle) -> bool {
    let Ok(text) = fs::read_to_string(settings_path(app_handle)) else {
        return false;
    };
    read_preset(&text).as_deref() == Some(TRUST_PRESET)
}

/// 开启/关闭信任模式：把默认权限预设在 `danger-full-access` 与
/// `workspace-write` 之间切换。
///
/// 幂等；内容无变化时**不写盘**（避免无谓地改动 mtime 触发 harness 重载）。
/// 变更对**之后新建的会话**生效，既有会话保持创建时固定的权限，不受影响。
pub fn set_trust_mode(app_handle: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let path = settings_path(app_handle);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        // 新用户尚未产生 settings.yaml：从空文本开始，写入时创建该文件。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("TRUST_MODE_READ: {e}")),
    };

    let target = if enabled { TRUST_PRESET } else { ASK_PRESET };
    let next = upsert_scalar(&text, SECTION, KEY, target);
    if next == text {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("TRUST_MODE_MKDIR: {e}"))?;
    }
    fs::write(&path, next).map_err(|e| format!("TRUST_MODE_WRITE: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = concat!(
        "ui-theme:\n",
        "  preference: light\n",
        "agent-presets:\n",
        "  default: cordis\n",
        "llm-pi-ai:\n",
        "  providers:\n",
        "    zai-coding-cn:\n",
        "      apiKeyEnv: ZAI_CODING_CN_API_KEY\n",
    );

    #[test]
    fn reads_preset_from_section() {
        assert_eq!(
            read_preset("permissionPresets:\n  defaultPreset: danger-full-access\n").as_deref(),
            Some("danger-full-access")
        );
    }

    #[test]
    fn read_returns_none_when_section_absent() {
        assert_eq!(read_preset(SAMPLE), None);
    }

    /// 更深层嵌套里恰好有同名键时不应被误读（分节在下一个顶格键处结束）。
    #[test]
    fn read_ignores_deeper_nesting() {
        let text = "permissionPresets:\n  other: 1\nouter:\n    defaultPreset: danger-full-access\n";
        assert_eq!(read_preset(text), None);
    }

    #[test]
    fn appends_section_when_missing_and_preserves_content() {
        let out = upsert_scalar(SAMPLE, SECTION, KEY, TRUST_PRESET);
        assert!(out.starts_with(SAMPLE), "前文应原样保留:\n{out}");
        assert!(out.contains("permissionPresets:\n  defaultPreset: danger-full-access\n"));
    }

    #[test]
    fn replaces_existing_key_in_place() {
        let text = "ui-theme:\n  preference: light\npermissionPresets:\n  defaultPreset: workspace-write\n";
        let out = upsert_scalar(text, SECTION, KEY, TRUST_PRESET);
        assert!(out.contains("  defaultPreset: danger-full-access"));
        assert!(!out.contains("workspace-write"));
        // 键的位置保持在原分节内，未被挪动
        assert!(out.starts_with("ui-theme:\n  preference: light\npermissionPresets:\n"));
    }

    /// 分节存在但缺该键：应插到分节末尾，而不是文件末尾（否则会被并进下一个分节）。
    #[test]
    fn inserts_into_existing_section_end() {
        let text = "permissionPresets:\n  other: 1\nui-theme:\n  preference: light\n";
        let out = upsert_scalar(text, SECTION, KEY, TRUST_PRESET);
        assert_eq!(
            out,
            "permissionPresets:\n  other: 1\n  defaultPreset: danger-full-access\nui-theme:\n  preference: light\n"
        );
    }

    #[test]
    fn upsert_is_idempotent() {
        let once = upsert_scalar(SAMPLE, SECTION, KEY, TRUST_PRESET);
        let twice = upsert_scalar(&once, SECTION, KEY, TRUST_PRESET);
        assert_eq!(once, twice);
    }
}
