//! 插件更新可用性检测（参考 dsh-market 的 `updates.ts`，但去掉「桌面端」耦合）。
//!
//! 每个已安装插件按其在 profile `package.json` 中的依赖 spec 判断：
//! - `link:` / `file:` 本地依赖 → 永不视为有更新；
//! - git 类型（`github:` / `git+https://github.com/…` / `https://codeload.github.com/…`）
//!   → 用 pnpm-lock.yaml 里记录的 codeload 提交 SHA 对比 GitHub 仓库 HEAD SHA，
//!     不相同即视为有更新（与 market 的「按提交比较」一致）；
//! - 其余（registry）→ 用 npm registry 的 `latest` dist-tag 与已装版本做语义化比较，
//!   `latest > installed` 才视为有更新（避免把 `latest` 指向更旧版本误判为可升级）。
//!
//! 与 market 相同的兜底：任何一次判定失败都报告「无更新」，绝不因一次网络抖动或
//! 404 让整个插件管理器不可用；结果按 (id, spec, 版本) 缓存 30 分钟（TTL），期间
//! 重复调用直接命中缓存、不重复打网络。缓存缺失/未判定时 `update_available=false`，
//! 前端由 `refresh_plugin_updates` 在挂载后补齐，因此首次展示短暂无按钮、随后自动
//! 出现——这正好保证「不是常驻按钮」，只有确有更新（或异常修复）时才展示升级入口。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use semver::Version as Semver;
use serde_json::Value;
use tauri::AppHandle;

use super::installed::profile_dir;
use super::watch::DshPlugin;

/// 更新判定结果的缓存 TTL（与 dsh-market 一致：30 分钟）
const UPDATES_TTL: Duration = Duration::from_secs(30 * 60);

/// 单条更新判定结果
#[derive(Debug, Clone)]
pub struct UpdateInfo {
    /// 是否确有更新（`true` = 有可升级的新版本/新提交）
    pub update_available: bool,
    /// 语义化判定得到的「最新版本」（npm 分支为 registry latest，git 分支为 HEAD SHA）
    pub latest: Option<String>,
}

struct CacheEntry {
    info: UpdateInfo,
    at: Instant,
}

static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 缓存键：同一插件换了 spec 或升级了版本后，旧的判定结果自动失效（key 变化即 miss）。
fn cache_key(id: &str, spec: &str, version: &str) -> String {
    format!("{id}\u{0}{spec}\u{0}{version}")
}

// ---------------------------------------------------------------------------
// 读取安装态（spec / 版本 / 锁定提交）
// ---------------------------------------------------------------------------

/// 当前档案的直接依赖（id → spec）。读取失败返回空表（不阻断整体判定）。
fn read_specs(app_handle: &AppHandle) -> HashMap<String, String> {
    let dir = profile_dir(app_handle);
    let Ok(content) = std::fs::read_to_string(dir.join("package.json")) else {
        return HashMap::new();
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&content) else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    if let Some(deps) = manifest.get("dependencies").and_then(Value::as_object) {
        for (name, spec) in deps {
            if let Some(s) = spec.as_str() {
                out.insert(name.clone(), s.to_string());
            }
        }
    }
    out
}

/// 从 pnpm-lock.yaml 的 codeload tarball URL 中提取「owner/repo → 提交 SHA」映射
/// （与 dsh-market `readLockCommits` 的取法一致：pnpm 把 git 依赖的锁采用
/// `https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>` 形式记录）。
fn read_locked_commits(profile: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = std::fs::read_to_string(profile.join("pnpm-lock.yaml")) else {
        return out;
    };
    let re =
        regex::Regex::new(r"codeload\.github\.com/([^/\s]+)/([^/\s]+)/tar\.gz/([0-9a-fA-F]{7,40})")
            .expect("static codeload regex");
    for cap in re.captures_iter(&text) {
        let repo = format!("{}/{}", &cap[1], &cap[2]).to_lowercase();
        out.insert(repo, cap[3].to_string());
    }
    out
}

// ---------------------------------------------------------------------------
// spec 解析
// ---------------------------------------------------------------------------

/// 从依赖 spec 中提取 GitHub `owner/repo`（用于 git 类依赖的 HEAD 对比）。
/// 支持 `github:owner/repo`、`git+https://github.com/owner/repo.git`、
/// `git+ssh://git@github.com/owner/repo.git`、`https://codeload.github.com/owner/repo/…`。
/// 非 git 形态返回 None。
fn extract_github_repo(spec: &str) -> Option<String> {
    if let Some(rest) = spec.strip_prefix("github:") {
        let path = rest.split('#').next().unwrap_or(rest).trim_end_matches('/');
        let path = path
            .strip_suffix(".git")
            .unwrap_or(path)
            .trim_end_matches('/');
        return (is_owner_repo(path)).then(|| path.to_string());
    }
    let after = spec.split_once("github.com/").map(|(_, r)| r)?;
    let path = after
        .split(['#', '?'])
        .next()
        .unwrap_or(after)
        .trim_end_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    (is_owner_repo(&format!("{owner}/{repo}"))).then(|| format!("{owner}/{repo}"))
}

/// `owner/repo` 形态校验（owner/repo 各仅允许字母数字 `._-`，避免误吞 URL 首位）。
fn is_owner_repo(value: &str) -> bool {
    let Some((owner, repo)) = value.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && !repo.is_empty()
        && !value.contains('@')
        && owner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 语义化「latest 确实高于 installed」才判定为升级（避免把 dist-tag 指向旧版误判）。
fn is_upgrade(installed: &str, latest: &str) -> bool {
    match (Semver::parse(installed), Semver::parse(latest)) {
        (Ok(i), Ok(l)) => l > i,
        _ => false,
    }
}

/// 把 npm 包名编码为 registry 路径（`@scope/name` → `@scope%2Fname`）。
fn encode_registry_name(name: &str) -> String {
    name.replace('@', "%40").replace('/', "%2F")
}

// ---------------------------------------------------------------------------
// 网络判定
// ---------------------------------------------------------------------------

async fn fetch_json(client: &reqwest::Client, url: &str) -> Option<Value> {
    let res = client
        .get(url)
        .header("accept", "application/json")
        .header("user-agent", "deepseek-harness-desktop")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json::<Value>().await.ok()
}

/// GitHub 仓库 HEAD 提交 SHA（API 限流/429/网络错误均返回 None，视为无法判定）。
async fn fetch_head_sha(client: &reqwest::Client, repo: &str) -> Option<String> {
    let url = format!("https://api.github.com/repos/{repo}/commits/HEAD");
    let v = fetch_json(client, &url).await?;
    v.get("sha")?.as_str().map(String::from)
}

/// npm registry `latest` dist-tag 版本（404/网络错误返回 None）。
async fn fetch_npm_latest(client: &reqwest::Client, name: &str) -> Option<String> {
    let url = format!(
        "https://registry.npmjs.org/{}/latest",
        encode_registry_name(name)
    );
    let v = fetch_json(client, &url).await?;
    v.get("version")?.as_str().map(String::from)
}

/// 计算单个插件的更新判定。任何不确定性都返回「无更新」，绝不因失败报升级。
async fn compute_update(
    client: &reqwest::Client,
    id: &str,
    spec: &str,
    installed_version: Option<&str>,
    locked: &HashMap<String, String>,
) -> UpdateInfo {
    if spec.starts_with("link:") || spec.starts_with("file:") {
        return UpdateInfo {
            update_available: false,
            latest: None,
        };
    }

    if let Some(repo) = extract_github_repo(spec) {
        let current = locked.get(&repo.to_lowercase()).cloned();
        let latest = fetch_head_sha(client, &repo).await;
        return UpdateInfo {
            update_available: current.is_some() && latest.is_some() && current != latest,
            latest,
        };
    }

    let latest = fetch_npm_latest(client, id).await;
    let update_available = match (installed_version, latest.as_deref()) {
        (Some(i), Some(l)) => is_upgrade(i, l),
        _ => false,
    };
    UpdateInfo {
        update_available,
        latest,
    }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/// 把缓存里的已知判定合并进插件列表（`get_dsh_plugins` 用）。缓存缺失时保持
/// `update_available=false`（未判定，由前端随后 `refresh_plugin_updates` 补齐）。
pub fn apply_cache(app_handle: &AppHandle, plugins: &mut [DshPlugin]) {
    let specs = read_specs(app_handle);
    let cache = cache().lock().unwrap();
    let now = Instant::now();
    for p in plugins.iter_mut() {
        let spec = specs.get(&p.id).cloned().unwrap_or_default();
        let key = cache_key(&p.id, &spec, &p.version);
        if let Some(entry) = cache.get(&key) {
            if now.duration_since(entry.at) < UPDATES_TTL {
                p.update_available = entry.info.update_available;
                p.latest_version = entry.info.latest.clone();
            }
        }
    }
}

/// 重新探测所有已安装插件的更新可用性（网络 + 缓存），返回带最新判定结果的完整列表。
///
/// 对已缓存且未过期的条目复用缓存；其余条目并行发请求；判定失败统一按「无更新」
/// 处理，因此即使 registry/GitHub 不可达，插件管理流程也照常可用。
pub async fn refresh(app_handle: &AppHandle) -> Result<Vec<DshPlugin>, String> {
    let mut plugins = super::watch::list(app_handle);
    let specs = read_specs(app_handle);
    let locked = read_locked_commits(&profile_dir(app_handle));
    let client = reqwest::Client::builder()
        .user_agent("deepseek-harness-desktop")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("UPDATES_CLIENT: {e}"))?;

    struct Task {
        idx: usize,
        key: String,
        id: String,
        spec: String,
        version: Option<String>,
    }

    let now = Instant::now();
    let mut tasks: Vec<Task> = Vec::new();
    {
        let cache = cache().lock().unwrap();
        for (idx, p) in plugins.iter_mut().enumerate() {
            let spec = specs.get(&p.id).cloned().unwrap_or_default();
            let key = cache_key(&p.id, &spec, &p.version);
            if let Some(entry) = cache.get(&key) {
                if now.duration_since(entry.at) < UPDATES_TTL {
                    p.update_available = entry.info.update_available;
                    p.latest_version = entry.info.latest.clone();
                    continue;
                }
            }
            tasks.push(Task {
                idx,
                key,
                id: p.id.clone(),
                spec,
                version: (!p.version.is_empty()).then(|| p.version.clone()),
            });
        }
    }

    // 并行发起更新判定。`client`/`locked` 只在 `join_all` 期间存活，用引用而非 move
    // 捕获（否则 FnMut 的 map 无法多次消费非 Copy 的它们）；`t` 是闭包参数、按 move
    // 进每个异步块（每个任务独立持有自己的键/下标）。
    let results = futures_util::future::join_all(tasks.into_iter().map(|t| {
        let c = &client;
        let lock = &locked;
        async move {
            let info = compute_update(c, &t.id, &t.spec, t.version.as_deref(), lock).await;
            (t.idx, t.key, info)
        }
    }))
    .await;

    let mut cache = cache().lock().unwrap();
    for (idx, key, info) in results {
        if let Some(p) = plugins.get_mut(idx) {
            p.update_available = info.update_available;
            p.latest_version = info.latest.clone();
        }
        cache.insert(
            key,
            CacheEntry {
                info,
                at: Instant::now(),
            },
        );
    }

    Ok(plugins)
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_requires_strictly_newer() {
        assert!(is_upgrade("1.0.0", "1.0.1"));
        assert!(is_upgrade("1.0.0", "2.0.0"));
        // latest 不是更高（回退/降级/相同）→ 不算升级
        assert!(!is_upgrade("1.0.1", "1.0.0"));
        assert!(!is_upgrade("1.0.0", "1.0.0"));
        // 非语义化版本不可判 → 不算升级
        assert!(!is_upgrade("1.0.0", "canary"));
        assert!(!is_upgrade("0.0.0", "0.0.0"));
    }

    #[test]
    fn upgrade_handles_prerelease() {
        assert!(is_upgrade("1.0.0", "1.0.1-rc.1"));
        // 同 base，release 高于 prerelease
        assert!(is_upgrade("1.0.0-rc.1", "1.0.0"));
        assert!(!is_upgrade("1.0.0", "1.0.0-rc.1"));
    }

    #[test]
    fn extract_repo_from_github_shorthand() {
        assert_eq!(
            extract_github_repo("github:omdsh-dev/DSH-better-sidebar"),
            Some("omdsh-dev/DSH-better-sidebar".into())
        );
        assert_eq!(
            extract_github_repo("github:baihejiangnan/dsh-session-context-menu#next"),
            Some("baihejiangnan/dsh-session-context-menu".into())
        );
    }

    #[test]
    fn extract_repo_from_git_https_and_codeload() {
        assert_eq!(
            extract_github_repo("git+https://github.com/omdsh-dev/DSH-better-sidebar.git"),
            Some("omdsh-dev/DSH-better-sidebar".into())
        );
        assert_eq!(
            extract_github_repo("git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git"),
            Some("omdsh-dev/DSH-better-sidebar".into())
        );
        assert_eq!(
            extract_github_repo("https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/7dbd9b75e2fd65758d4e55f750319399b91255a2"),
            Some("omdsh-dev/DSH-better-sidebar".into())
        );
    }

    #[test]
    fn extract_repo_for_plain_npm_is_none() {
        assert_eq!(extract_github_repo("dshmarket"), None);
        assert_eq!(extract_github_repo("link:../plugin"), None);
        assert_eq!(extract_github_repo("file:./local"), None);
        assert_eq!(extract_github_repo("npm:dshmarket@^1.0"), None);
    }

    #[test]
    fn lock_commits_parsed_from_codeload_urls() {
        let lock = "\
importers:\n  .:\n    dependencies:\n      dsh-better-sidebar:\n        specifier: https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/7dbd9b75e2fd65758d4e55f750319399b91255a2\n";
        let dir = std::env::temp_dir().join(format!("dsh-updates-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), lock).unwrap();
        let commits = read_locked_commits(&dir);
        assert_eq!(
            commits.get("omdsh-dev/dsh-better-sidebar"),
            Some(&"7dbd9b75e2fd65758d4e55f750319399b91255a2".to_string())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cache_key_changes_with_version() {
        let a = cache_key("p", "spec", "1.0.0");
        let b = cache_key("p", "spec", "1.0.1");
        assert_ne!(a, b);
        let c = cache_key("p", "spec2", "1.0.0");
        assert_ne!(a, c);
    }

    #[test]
    fn registry_name_encoded() {
        assert_eq!(encode_registry_name("@scope/name"), "%40scope%2Fname");
        assert_eq!(encode_registry_name("dshmarket"), "dshmarket");
    }
}
