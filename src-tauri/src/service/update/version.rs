//! 版本比较与当前平台安装包资产选择。
//!
//! 纯函数：不触网、不依赖运行时状态（仅 `linux_package_family` 探测包管理家族），
//! 均为 `更新` 模块内其它部分的判定基础。

use semver::Version;

/// 当前桌面端版本号（来自 Cargo.toml / tauri.conf.json）
pub(super) fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 解析版本号为 semver（容忍 `v` 前缀）；非合法 semver 返回 `None`。
///
/// 用标准 semver 语义而非手写数字段比较：`0.7.14-rc.1` / `0.7.14-beta` 这样的
/// pre-release 与 `test-main-123` 这类手动测试 release tag 都能被正确识别。
pub(super) fn parse_version(v: &str) -> Option<Version> {
    Version::parse(v.trim().trim_start_matches('v')).ok()
}

/// 是否「正式版」：纯数字版本，无 pre-release 与 build metadata（如 `0.7.14`）。
///
/// 更新通知只发给正式版：`0.7.14-rc.1` / `0.7.14-beta` 等 pre-release 一律跳过，
/// 用户不会收到非正式版的更新提示（见 [`super::meta`]）。
pub(super) fn is_stable(version: &Version) -> bool {
    version.pre.is_empty() && version.build.is_empty()
}

/// 判断 `latest` 是否严格高于 `current`（semver 语义）。
///
/// 注意 `0.7.14 > 0.7.14-rc.1`：装了 rc 的用户也能收到同号正式版的通知，
/// 而 rc 自身（`0.7.14-rc.2`）永远不会高于同号后的正式版。
pub(super) fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// 根据资产文件名判断其架构匹配度，用于同扩展名下挑选正确架构的安装包：
/// - `2`：与当前运行架构完全匹配（如 `_x64.dmg` / `_aarch64.dmg` / `_amd64.deb`）
/// - `1`：通用包（`universal`），任何架构都可用
/// - `0`：不匹配或文件名未携带架构信息（作为兜底仍可尝试）
fn arch_rank(name: &str) -> i8 {
    let lower = name.to_lowercase();
    if lower.contains("universal") {
        return 1;
    }
    #[cfg(target_arch = "aarch64")]
    let markers = ["aarch64", "arm64", "apple-silicon", "-arm", "_arm"];
    #[cfg(target_arch = "x86_64")]
    let markers = ["x86_64", "amd64", "x64", "intel", "-x86", "_x86"];
    if markers.iter().any(|k| lower.contains(k)) {
        2
    } else {
        0
    }
}

/// 判断当前 Linux 发行版的包管理家族，用于选择原生安装包格式。
///
/// - `"deb"`：Debian/Ubuntu 系（存在 `/etc/debian_version` 或 `dpkg`）
/// - `"rpm"`：Fedora/RHEL/openSUSE 系（存在 `/etc/redhat-release`、`/etc/fedora-release`
///   或 `rpm`）
/// - `"unknown"`：都无法判定（如 Arch/pacman）
///
/// 通过文件存在性判断，不拉起子进程。本地包管理家族一旦判定（绝大多数发行版为
/// deb 系），`linux_prefs` 就据此优先 `.deb`（Ubuntu 22.04+ 构建基准，.deb 使用宿主
/// WebKitGTK，在 Wayland 下更稳，见 README）。
#[cfg(target_os = "linux")]
fn linux_package_family() -> &'static str {
    let debianish = std::path::Path::new("/etc/debian_version").exists()
        || std::path::Path::new("/usr/bin/dpkg").exists();
    let rpmish = std::path::Path::new("/etc/redhat-release").exists()
        || std::path::Path::new("/etc/fedora-release").exists()
        || std::path::Path::new("/usr/bin/rpm").exists();
    if debianish {
        "deb"
    } else if rpmish {
        "rpm"
    } else {
        "unknown"
    }
}

/// 按包管理家族返回 Linux 资产扩展名优先级列表（纯函数，便于测试）。
///
/// 已知家族优先其原生包（deb→`.deb`、rpm→`.rpm`），AppImage 作为便携兜底；
/// 未知家族（如 pacman）无对应原生包，AppImage 是最通用选择。
#[cfg(target_os = "linux")]
fn linux_prefs(family: &str) -> &'static [&'static str] {
    match family {
        "rpm" => &[".rpm", ".AppImage", ".deb"],
        "deb" => &[".deb", ".AppImage", ".rpm"],
        _ => &[".AppImage", ".deb", ".rpm"],
    }
}

/// 选择当前平台对应的安装包资产文件名。
///
/// 选择规则分两层：先按平台偏好扩展名排序，同扩展名下再按架构匹配度挑选。
/// - Windows 优先 NSIS setup.exe（其次 msi）：NSIS 不会像 MSI 那样由
///   RestartManager 强杀旧进程并在安装完成后自动重开应用，避免应用在旧进程
///   被强杀、运行文件瞬时缺失的窗口被自动拉起，从而误触发核心重下载。
/// - macOS 选 dmg，并按架构区分，避免 Intel 芯片 Mac 下载到 M 芯片
///   （aarch64）的安装包（issue #33）。
/// - Linux 优先与发行版包管理一致的原生安装包（**deb 系优先 `.deb`、rpm 系优先
///   `.rpm`**，issue #79），AppImage 作为便携兜底，同样按架构匹配。优先原生包
///   而非 AppImage：.deb/.rpm 使用宿主 WebKitGTK，在 Wayland 下更稳定，且无需
///   可执行位/缺 libfuse2 的额外问题。
pub(super) fn pick_asset(assets: &[String]) -> Option<String> {
    #[cfg(target_os = "windows")]
    let prefs: &[&str] = &[".exe", ".msi"];
    #[cfg(target_os = "macos")]
    let prefs: &[&str] = &[".dmg"];
    #[cfg(target_os = "linux")]
    let prefs: &[&str] = linux_prefs(linux_package_family());

    let mut best: Option<(usize, i8, String)> = None;
    for name in assets {
        let Some(idx) = prefs.iter().position(|p| name.ends_with(p)) else {
            continue;
        };
        let rank = prefs.len() - idx; // 扩展名优先级：越靠前越高
        let ar = arch_rank(name); // 架构匹配度：同扩展名下优先选匹配架构
        if best
            .as_ref()
            .is_none_or(|(r, a, _)| rank > *r || (rank == *r && ar > *a))
        {
            best = Some((rank, ar, name.clone()));
        }
    }
    best.map(|(_, _, name)| name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_strips_v_prefix() {
        assert_eq!(parse_version("v0.5.2").unwrap().to_string(), "0.5.2");
        assert_eq!(parse_version("0.5.2").unwrap().to_string(), "0.5.2");
        // pre-release 也是合法 semver
        assert_eq!(
            parse_version("0.5.2-rc.1").unwrap().to_string(),
            "0.5.2-rc.1"
        );
        // 非法 semver（如手动测试 release 的 tag / 只有两段）返回 None
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("test-main-123"), None);
        assert_eq!(parse_version("0.5"), None);
    }

    #[test]
    fn is_newer_compares_semver() {
        assert!(is_newer("0.5.2", "0.5.1"));
        assert!(is_newer("1.0.0", "0.9.0"));
        // rc 数值段更高 → 比旧正式版新
        assert!(is_newer("0.7.14-rc.1", "0.7.13"));
        // 正式版高于同号 rc（装了 rc 的用户能收到正式版通知）
        assert!(is_newer("0.7.14", "0.7.14-rc.1"));
        assert!(is_newer("0.7.14-rc.2", "0.7.14-rc.1"));
        assert!(!is_newer("0.5.1", "0.5.2"));
        assert!(!is_newer("0.5.1", "0.5.1"));
        // rc 不会高于同号正式版
        assert!(!is_newer("0.7.14-rc.1", "0.7.14"));
    }

    #[test]
    fn is_newer_ignores_unparseable() {
        assert!(!is_newer("abc", "0.5.1"));
        assert!(!is_newer("0.5.1", "abc"));
        assert!(!is_newer("test-main-123", "0.5.1"));
    }

    #[test]
    fn is_stable_only_pure_numeric() {
        assert!(is_stable(&parse_version("0.7.14").unwrap()));
        assert!(is_stable(&parse_version("0.7.0").unwrap()));
        assert!(!is_stable(&parse_version("0.7.14-rc.1").unwrap()));
        assert!(!is_stable(&parse_version("0.7.14-beta.2").unwrap()));
        assert!(!is_stable(&parse_version("0.7.14-alpha").unwrap()));
        assert!(!is_stable(&parse_version("0.7.14+build.5").unwrap()));
    }

    #[test]
    fn pick_asset_prefers_matching_suffix() {
        let mk = |name: &str| name.to_string();
        #[cfg(target_os = "windows")]
        {
            // NSIS setup.exe 优先于 msi（避免 MSI 的 RestartManager 强杀+自动重开）
            let assets: Vec<String> = vec![mk("app-x86_64-setup.exe"), mk("app-x64_en-US.msi")];
            assert_eq!(pick_asset(&assets).as_deref(), Some("app-x86_64-setup.exe"));
        }
        #[cfg(target_os = "macos")]
        {
            let assets: Vec<String> = vec![mk("app.dmg"), mk("app-x86_64.tar.gz")];
            assert_eq!(pick_asset(&assets).as_deref(), Some("app.dmg"));
        }
        let no_match: Vec<String> = vec![mk("README.md")];
        assert!(pick_asset(&no_match).is_none());
        assert!(pick_asset(&[]).is_none());
    }

    #[test]
    fn arch_rank_matches_host_and_universal() {
        // 通用包任何架构都可用
        assert_eq!(arch_rank("Deepseek.Harness.Desktop-universal.dmg"), 1);
        // 按编译目标分支断言，保证 CI 在任意架构上都能通过
        #[cfg(target_arch = "aarch64")]
        {
            assert_eq!(arch_rank("Deepseek.Harness.Desktop_0.6.6_aarch64.dmg"), 2);
            assert_eq!(arch_rank("Deepseek.Harness.Desktop_0.6.6_x64.dmg"), 0);
        }
        #[cfg(target_arch = "x86_64")]
        {
            assert_eq!(arch_rank("Deepseek.Harness.Desktop_0.6.6_x64.dmg"), 2);
            assert_eq!(
                arch_rank("Deepseek.Harness.Desktop_0.6.6_amd64.AppImage"),
                2
            );
            assert_eq!(arch_rank("Deepseek.Harness.Desktop-0.6.6-1.x86_64.rpm"), 2);
            assert_eq!(arch_rank("Deepseek.Harness.Desktop_0.6.6_aarch64.dmg"), 0);
        }
        // 未携带架构信息的文件名作为兜底（0）
        assert_eq!(arch_rank("app.dmg"), 0);
    }

    /// Linux 资产优先级：包管理家族决定原生格式最优先（issue #79），未知家族落回 deb。
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_prefs_prefers_native_format_per_family() {
        let deb = linux_prefs("deb");
        let deb_rank = deb.iter().position(|p| *p == ".deb").unwrap();
        let appimage_rank = deb.iter().position(|p| *p == ".AppImage").unwrap();
        let rpm_rank = deb.iter().position(|p| *p == ".rpm").unwrap();
        assert!(
            deb_rank < appimage_rank && deb_rank < rpm_rank,
            "deb 系应优先 .deb，实际 {deb:?}"
        );

        let rpm = linux_prefs("rpm");
        let rpm_rank = rpm.iter().position(|p| *p == ".rpm").unwrap();
        let deb_rank = rpm.iter().position(|p| *p == ".deb").unwrap();
        let appimage_rank = rpm.iter().position(|p| *p == ".AppImage").unwrap();
        assert!(
            rpm_rank < appimage_rank && rpm_rank < deb_rank,
            "rpm 系应优先 .rpm，实际 {rpm:?}"
        );

        // 未知家族（如 pacman）：无对应原生包，AppImage 最通用
        let unknown = linux_prefs("unknown");
        let appimage_rank = unknown.iter().position(|p| *p == ".AppImage").unwrap();
        let deb_rank = unknown.iter().position(|p| *p == ".deb").unwrap();
        let rpm_rank = unknown.iter().position(|p| *p == ".rpm").unwrap();
        assert!(
            appimage_rank < deb_rank && appimage_rank < rpm_rank,
            "未知家族应优先 AppImage，实际 {unknown:?}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pick_asset_prefers_host_arch_dmg() {
        let mk = |name: &str| name.to_string();
        // aarch64 与 x64 并存（与真实发布资产命名一致）：选当前架构匹配的包
        let assets: Vec<String> = vec![
            mk("Deepseek.Harness.Desktop_0.6.6_aarch64.dmg"),
            mk("Deepseek.Harness.Desktop_0.6.6_x64.dmg"),
        ];
        let picked = pick_asset(&assets).unwrap();
        #[cfg(target_arch = "aarch64")]
        assert_eq!(picked, "Deepseek.Harness.Desktop_0.6.6_aarch64.dmg");
        #[cfg(target_arch = "x86_64")]
        assert_eq!(picked, "Deepseek.Harness.Desktop_0.6.6_x64.dmg");
        // 通用包优于与本机架构不匹配的包（用「非本机架构」的名字构造，任意架构成立）
        #[cfg(target_arch = "aarch64")]
        let wrong = "Deepseek.Harness.Desktop_0.6.6_x64.dmg";
        #[cfg(target_arch = "x86_64")]
        let wrong = "Deepseek.Harness.Desktop_0.6.6_aarch64.dmg";
        let assets: Vec<String> = vec![
            wrong.to_string(),
            "Deepseek.Harness.Desktop_0.6.6-universal.dmg".to_string(),
        ];
        let picked = pick_asset(&assets).unwrap();
        assert_eq!(picked, "Deepseek.Harness.Desktop_0.6.6-universal.dmg");
    }
}
