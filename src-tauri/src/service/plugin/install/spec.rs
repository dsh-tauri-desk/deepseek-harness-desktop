//! 安装 spec 准备：内置插件捆绑目录解析（`link:` 本地依赖——pnpm 对 `file:` 的
//! 盘符绝对路径会按相对解析）、GitHub 简写规范化（绕开 pnpm 的 HTTPS→SSH 回退
//! 缺陷）与 Windows 下含空格 spec 的引号化（dsh CLI 只在 win32 用 shell 拼接参数）。

use std::path::PathBuf;
use tauri::AppHandle;

use super::bundled_dep_spec;
use super::bundled_plugin_dir;
use super::PreinstallPluginInfo;

/// 内置插件才需要解析捆绑目录（普通插件无此概念），避免无谓的资源探测
pub(super) fn bundled_dir_of(
    app_handle: &AppHandle,
    preset: &PreinstallPluginInfo,
) -> Option<PathBuf> {
    if !preset.internal {
        return None;
    }
    bundled_plugin_dir(app_handle, &preset.id)
}

/// 解析某预设的安装 spec（纯函数，便于单测）：内置插件固定为随包捆绑目录的
/// `link:` 本地依赖（pnpm 对 `file:` 的盘符绝对路径会按相对解析，故用 `link:`；
/// 路径正确性由 [`crate::service::plugin::internal::ensure`] 启动自愈核对）；
/// 普通插件沿用清单声明。
///
/// 捆绑目录缺失时返回错误：内置插件缺失意味着构建期 prebuild 未执行或产物被
/// 删，属发布缺陷而非用户侧的普通安装失败，错误前缀便于区分。
pub(super) fn preset_spec_for_install(
    preset: &PreinstallPluginInfo,
    bundled_dir: Option<PathBuf>,
) -> Result<String, String> {
    if !preset.internal {
        return Ok(preset.spec.clone());
    }
    let dir = bundled_dir.ok_or_else(|| {
        format!(
            "BUNDLED_PLUGIN_MISSING: no bundled dir for internal plugin {} (run scripts/prebuild.ts at build time)",
            preset.id
        )
    })?;
    Ok(bundled_dep_spec(&dir))
}

/// 把 `github:owner/repo[#ref]` 一类的 GitHub 简写规范为显式 HTTPS 依赖形式
/// （`git+https://github.com/owner/repo.git[#ref]`）。
///
/// 动机：pnpm 解析 GitHub 简写时，「HTTPS 可达性探测一旦失败就回退 git+ssh」
/// 是已知缺陷（issue #3948 / #7243 / #13276，官方已 accepted 仍未修）。公开仓库
/// 一旦落进 git+ssh，在无 SSH 配置的桌面机上（非交互子进程无法应答 known_hosts
/// 询问）必然硬失败。规范为显式 `git+https:` 后 pnpm 直接走 HTTPS 克隆，绕开该
/// 回退；非 `github:` 形式（如纯 npm 包名）原样返回。
pub(super) fn normalize_git_spec(spec: &str) -> String {
    let Some(rest) = spec.strip_prefix("github:") else {
        return spec.to_string();
    };
    let (path, fragment) = match rest.split_once('#') {
        Some((p, f)) => (p.trim_end_matches('/'), Some(f)),
        None => (rest.trim_end_matches('/'), None),
    };
    let mut repo = path.to_string();
    if !repo.ends_with(".git") {
        repo.push_str(".git");
    }
    let mut url = format!("git+https://github.com/{repo}");
    if let Some(fragment) = fragment {
        url.push('#');
        url.push_str(fragment);
    }
    url
}

/// 给含空白字符的依赖 spec 加内嵌双引号，使其在 shell 拼接后仍保持单一 token。
///
/// **仅 Windows 需要引号。** `dsh plugin add` 在 JS 里用
/// `spawnSync("pnpm", args, { shell: process.platform === "win32" })` 启动 pnpm：
/// - Windows：`shell:true` 时 Node 只把参数按空格拼接、不做引号转义（官方文档
///   DEP0190：arguments are not escaped, only concatenated）。内置插件的依赖是
///   `link:<应用安装目录>`，而 Windows 安装目录常含空格（如
///   `G:\Deepseek Harness Desktop\resources\internal-plugins\dsh-tauri`），拼进
///   shell 后会被切碎成多个 spec，pnpm 报 `ERR_PNPM_SPEC_NOT_SUPPORTED` / 装成
///   错误依赖，导致启动自愈每轮都重装（死循环）。包一层双引号让 cmd 把整条
///   spec 视为一个参数；pnpm 解析后自行剥离引号，落盘 `package.json` 的值仍是
///   不带引号的规范 `link:<路径>`（与 [`bundled_dep_spec`] 的内核对账一致）。
/// - macOS / Linux：`shell:false`，pnpm 以 argv 数组直接启动、空格天然保留，
///   **加引号反而把字面 `"` 当成包名的一部分传给 pnpm → 非法 spec → exit 1**。
///   这是 issue #104 的根因：内置插件指向 `/Applications/Deepseek Harness
///   Desktop.app/...`（含空格），每次启动自愈重装都失败、服务永远缺该插件。
///
/// 因此只在 `cfg!(windows)` 且 spec 含空白时才包引号——普通 npm 包名 /
/// `git+https://...` 无空格，原样透传，避免无谓改动。
pub(super) fn shell_quote_spec(spec: &str) -> String {
    #[cfg(windows)]
    {
        if spec.chars().any(|c| c == ' ' || c == '\t') {
            return format!("\"{spec}\"");
        }
    }
    spec.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 构造预设条目的测试助手（internal 由各用例显式指定）
    fn preset(id: &str, spec: &str, internal: bool) -> PreinstallPluginInfo {
        PreinstallPluginInfo {
            id: id.into(),
            spec: spec.into(),
            package: None,
            name: String::new(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: false,
            win_only: false,
            internal,
        }
    }

    #[test]
    fn install_spec_passthrough_for_regular_preset() {
        // 普通插件：spec 原样返回，与捆绑目录无关
        let p = preset("dshmarket", "dshmarket", false);
        assert_eq!(preset_spec_for_install(&p, None).unwrap(), "dshmarket");
        assert_eq!(
            preset_spec_for_install(&p, Some(PathBuf::from("/ignored"))).unwrap(),
            "dshmarket"
        );
    }

    #[test]
    fn install_spec_uses_bundled_dir_for_internal_preset() {
        // 内置插件：安装依赖为 link:<捆绑目录>（正斜杠规范形；pnpm 对
        // `file:D:/...` 的盘符绝对路径会按相对解析，必须用 `link:`）
        let p = preset("dsh-tauri", "dsh-tauri@0.2.0", true);
        let dir = PathBuf::from("C:\\Apps\\dsh\\resources\\internal-plugins\\dsh-tauri");
        assert_eq!(
            preset_spec_for_install(&p, Some(dir)).unwrap(),
            "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"
        );
    }

    #[test]
    fn install_spec_errors_when_internal_bundle_missing() {
        // 内置插件捆绑目录缺失：发布缺陷，显式报错而非静默走 npm/git spec
        let p = preset("dsh-tauri", "dsh-tauri@0.2.0", true);
        let err = preset_spec_for_install(&p, None).unwrap_err();
        assert!(err.starts_with("BUNDLED_PLUGIN_MISSING"));
        assert!(err.contains("dsh-tauri"));
    }

    // ---- git GitHub 简写规范化（issue #51 根因绕行）----

    #[test]
    fn normalize_github_shorthand_to_git_https() {
        assert_eq!(
            normalize_git_spec("github:baihejiangnan/dsh-session-context-menu"),
            "git+https://github.com/baihejiangnan/dsh-session-context-menu.git"
        );
    }

    #[test]
    fn normalize_github_shorthand_preserves_ref_and_dedup_git_suffix() {
        assert_eq!(
            normalize_git_spec("github:omdsh-dev/DSH-better-sidebar#next"),
            "git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"
        );
        // 已带 .git 不重复追加
        assert_eq!(
            normalize_git_spec("github:user/repo.git"),
            "git+https://github.com/user/repo.git"
        );
        // 尾部多余斜杠剥掉
        assert_eq!(
            normalize_git_spec("github:user/repo/"),
            "git+https://github.com/user/repo.git"
        );
    }

    #[test]
    fn normalize_non_github_spec_passes_through() {
        assert_eq!(normalize_git_spec("dshmarket"), "dshmarket");
        assert_eq!(
            normalize_git_spec("git+https://github.com/foo/bar.git"),
            "git+https://github.com/foo/bar.git"
        );
    }

    // ---- spec 引号化（仅 Windows：dsh CLI 只在 win32 用 shell 拼接参数）----

    #[cfg(windows)]
    #[test]
    fn shell_quote_quotes_spec_containing_spaces() {
        // 安装目录含空格（如 G:\Deepseek Harness Desktop）：整条 spec 加双引号，
        // 使 dsh CLI 的 shell:true 拼接后仍被 shell 视为单一 token（DEP0190：
        // Node 对 shell:true 只拼接不转义）
        assert_eq!(
            shell_quote_spec(
                "link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri"
            ),
            "\"link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri\""
        );
        // 制表符同样触发
        assert_eq!(shell_quote_spec("link:C:/x\ty"), "\"link:C:/x\ty\"");
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_quote_leaves_space_path_untouched_on_non_windows() {
        // 回归（issue #104）：macOS/Linux 上 dsh CLI 直接 spawnSync（shell:false），
        // spec 作为一个 argv 传递、空格天然保留，绝不能加引号——字面 `"` 会成为
        // 包名的一部分，pnpm 报非法 spec → exit 1 → 内置插件每次启动重装都失败。
        assert_eq!(
            shell_quote_spec("link:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/internal-plugins/dsh-tauri-ui"),
            "link:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/internal-plugins/dsh-tauri-ui"
        );
        assert_eq!(
            shell_quote_spec("link:/Users/me/my plugins/dsh-tauri"),
            "link:/Users/me/my plugins/dsh-tauri"
        );
    }

    #[test]
    fn shell_quote_leaves_space_free_spec_untouched() {
        // 普通 npm 包名 / git HTTPS spec 无空格：原样透传，不引入多余引号
        assert_eq!(shell_quote_spec("dshmarket"), "dshmarket");
        assert_eq!(
            shell_quote_spec("git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"),
            "git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"
        );
        // 无空格的内置插件路径同样不被改动（保持与 internal.rs expected 一致）
        assert_eq!(
            shell_quote_spec("link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"),
            "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"
        );
    }

    #[cfg(windows)]
    #[test]
    fn shell_quote_preserves_link_prefix_semantics() {
        // 引号只包 path 部分也不影响 pnpm 解析（落盘值仍为不带引号的 link: 规范形）
        let quoted = shell_quote_spec(
            "link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri",
        );
        assert!(quoted.starts_with('"'));
        assert!(quoted.ends_with('"'));
        assert!(quoted.contains("Deepseek Harness Desktop"));
    }
}
