//! 会话文件管理
//!
//! - 扫描 `$DSH_HOME/sessions` 下全部会话（文件系统为真源），
//! - 用 `storages/session_projcache.json` 富化标题/turns/steps/创建时间等，
//! - 用 `storages/workspace.json` 推导归档状态（active/archived/orphan），
//! - 支持彻底删除（文件系统 + 两 JSON 索引原子一致）。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 前端展示的会话行
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileInfo {
    /// 文件夹名即会话 id（如 `session-xxx` 或 `03166b31-...`）
    pub id: String,
    /// 标题（可能为空，前端展示为 `(untitled)`）
    pub title: Option<String>,
    /// 文件夹总大小（字节，含 session.jsonl.zstd）
    pub size: u64,
    /// turns（来自 sessionStats）
    pub turns: u32,
    /// steps（来自 sessionStats）
    pub steps: u32,
    /// 创建时间戳（毫秒，来自 identity.createdAt 或文件 mtime 兜底）
    pub created_at: i64,
    /// 所属工作区路径（来自 identity.cwd）
    pub cwd: String,
    /// 归档状态：`active` | `archived` | `orphan`
    pub archived_status: String,
    /// 是否空会话
    pub is_empty: bool,
    /// 绝对路径
    pub path: String,
    /// workspace.json 是否解析失败（降级为可删孤儿）
    pub is_parse_failed: bool,
}

/// `storages/workspace.json` 的最小子集
#[derive(Debug, Deserialize)]
struct WorkspaceFile {
    global: WorkspaceGlobal,
    tables: WorkspaceTables,
}

#[derive(Debug, Deserialize)]
struct WorkspaceGlobal {
    #[serde(default)]
    #[serde(rename = "archivedSessionIds")]
    archived_session_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceTables {
    workspaces: HashMap<String, WorkspaceEntry>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceEntry {
    #[serde(default)]
    #[serde(rename = "sessionIds")]
    session_ids: Vec<String>,
}

/// `storages/session_projcache.json` 的最小子集
#[derive(Debug, Deserialize)]
struct ProjCacheFile {
    tables: ProjCacheTables,
}

#[derive(Debug, Deserialize)]
struct ProjCacheTables {
    sessions: HashMap<String, ProjCacheSession>,
}

#[derive(Debug, Deserialize)]
struct ProjCacheSession {
    identity: ProjCacheIdentity,
    rows: HashMap<String, ProjCacheRow>,
}

#[derive(Debug, Deserialize)]
struct ProjCacheIdentity {
    #[serde(default)]
    #[serde(rename = "createdAt")]
    created_at: Option<i64>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProjCacheRow {
    val: serde_json::Value,
}

/// 获取会话根目录 `$DSH_HOME/sessions`
fn sessions_root<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    crate::config::get_dsh_data_path(app_handle).join("sessions")
}

/// 获取 storages 目录
fn storages_dir<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    crate::config::get_dsh_data_path(app_handle).join("storages")
}

/// 计算文件夹总大小（递归累加）
fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let entries = match fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(md) = entry.metadata() {
            if md.is_file() {
                total = total.saturating_add(md.len());
            } else if md.is_dir() {
                total = total.saturating_add(dir_size(&p));
            }
        }
    }
    total
}

/// 解析 workspace.json 得到两集合及解析失败标记
fn load_workspace_sets<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
) -> (HashSet<String>, HashSet<String>, bool) {
    let path = storages_dir(app_handle).join("workspace.json");
    let data = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            // 文件缺失视为非失败（全新环境），仅读取错误视为失败需警告
            if e.kind() == std::io::ErrorKind::NotFound {
                return (HashSet::new(), HashSet::new(), false);
            }
            return (HashSet::new(), HashSet::new(), true);
        }
    };
    let file: WorkspaceFile = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return (HashSet::new(), HashSet::new(), true),
    };
    let archived: HashSet<String> = file.global.archived_session_ids.into_iter().collect();
    let mut active = HashSet::new();
    for ws in file.tables.workspaces.values() {
        for sid in &ws.session_ids {
            active.insert(sid.clone());
        }
    }
    (archived, active, false)
}

/// 从 projcache 取会话元数据
fn load_projcache_map<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
) -> HashMap<String, ProjCacheSession> {
    let path = storages_dir(app_handle).join("session_projcache.json");
    let data = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };
    let file: ProjCacheFile = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    file.tables.sessions
}

/// 尝试从 projcache 按 id 查找（兼容有无 `session-` 前缀）
fn find_proj_entry<'a>(
    map: &'a HashMap<String, ProjCacheSession>,
    id: &str,
) -> Option<&'a ProjCacheSession> {
    if let Some(v) = map.get(id) {
        return Some(v);
    }
    if id.starts_with("session-") {
        let short = &id["session-".len()..];
        if let Some(v) = map.get(short) {
            return Some(v);
        }
    } else {
        let with = format!("session-{}", id);
        if let Some(v) = map.get(&with) {
            return Some(v);
        }
    }
    None
}

/// 从 projcache row 中提取 title
fn extract_title(entry: &ProjCacheSession) -> Option<String> {
    let row = entry.rows.get("title")?;
    let val = &row.val;
    if val.is_null() {
        return None;
    }
    if let Some(s) = val.as_str() {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        return Some(t.to_string());
    }
    None
}

/// 提取 turns/steps
fn extract_stats(entry: &ProjCacheSession) -> (u32, u32) {
    if let Some(row) = entry.rows.get("sessionStats") {
        let v = &row.val;
        let turns = v.get("turns").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let steps = v.get("steps").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        return (turns, steps);
    }
    (0, 0)
}

/// 推导归档状态
fn derive_archived_status(
    id: &str,
    archived: &HashSet<String>,
    active: &HashSet<String>,
) -> String {
    let check = |set: &HashSet<String>, target: &str| -> bool {
        if set.contains(target) {
            return true;
        }
        if target.starts_with("session-") {
            let short = &target["session-".len()..];
            if set.contains(short) {
                return true;
            }
            if set.contains(&format!("session-{}", short)) {
                return true;
            }
        } else if set.contains(&format!("session-{}", target)) {
            return true;
        }
        false
    };
    if check(archived, id) {
        return "archived".to_string();
    }
    if check(active, id) {
        return "active".to_string();
    }
    "orphan".to_string()
}

/// 扫描全部会话（同步，调用方应在 spawn_blocking 中执行）
pub fn list<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> Result<Vec<SessionFileInfo>, String> {
    let root = sessions_root(app_handle);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let (archived_set, active_set, is_parse_failed) = load_workspace_sets(app_handle);
    let proj_map = load_projcache_map(app_handle);
    let mut out = Vec::new();
    let workspaces = fs::read_dir(&root).map_err(|e| format!("SESSION_SCAN_FAILED: read sessions root failed: {e}"))?;
    for ws_entry in workspaces.flatten() {
        let ws_path = ws_entry.path();
        if !ws_path.is_dir() {
            continue;
        }
        let sessions = match fs::read_dir(&ws_path) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for sess_entry in sessions.flatten() {
            let sess_path = sess_entry.path();
            if !sess_path.is_dir() {
                continue;
            }
            let id = match sess_path.file_name().and_then(|n| n.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            // 严格：仅 session.jsonl.zstd 存在才算有效会话
            let has_data = sess_path.join("session.jsonl.zstd").exists();
            if !has_data {
                continue;
            }
            let size = dir_size(&sess_path);
            let proj = find_proj_entry(&proj_map, &id);
            let (title, turns, steps, created_at, cwd) = if let Some(entry) = proj {
                let t = extract_title(entry);
                let (turns, steps) = extract_stats(entry);
                let created_at = entry.identity.created_at.unwrap_or(0);
                let cwd = entry.identity.cwd.clone().unwrap_or_default();
                (t, turns, steps, created_at, cwd)
            } else {
                let created_at = fs::metadata(&sess_path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                (None, 0, 0, created_at, String::new())
            };
            let archived_status = derive_archived_status(&id, &archived_set, &active_set);
            let is_empty = turns == 0 && steps == 0;
            out.push(SessionFileInfo {
                id: id.clone(),
                title,
                size,
                turns,
                steps,
                created_at,
                cwd,
                archived_status,
                is_empty,
                path: sess_path.to_string_lossy().to_string(),
                is_parse_failed,
            });
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

/// 分页结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCounts {
    pub all: usize,
    pub active: usize,
    pub archived: usize,
    pub orphan: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedSessionResult {
    pub total: usize,
    pub counts: SessionCounts,
    pub items: Vec<SessionFileInfo>,
    pub is_parse_failed: bool,
}

/// 分页+过滤+排序扫描（同步，调用方应在 spawn_blocking 中执行）
/// - filter: all/active/archived/orphan
/// - search: 标题/id/cwd 子串（大小写不敏感）
/// - sort_key: createdAt/size/turns
pub fn list_paged<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    filter: Option<String>,
    search: Option<String>,
    sort_key: Option<String>,
    sort_asc: bool,
    offset: usize,
    limit: usize,
) -> Result<PagedSessionResult, String> {
    let all = list(app_handle)?;
    let is_parse_failed = all.iter().any(|s| s.is_parse_failed);
    let counts = SessionCounts {
        all: all.len(),
        active: all.iter().filter(|s| s.archived_status == "active").count(),
        archived: all.iter().filter(|s| s.archived_status == "archived").count(),
        orphan: all.iter().filter(|s| s.archived_status == "orphan").count(),
    };
    let filter_val = filter.unwrap_or_else(|| "all".to_string());
    let search_lower = search.map(|s| s.to_lowercase()).unwrap_or_default();
    let has_search = !search_lower.is_empty();
    let mut filtered: Vec<SessionFileInfo> = all
        .into_iter()
        .filter(|s| {
            if filter_val != "all" && s.archived_status != filter_val {
                return false;
            }
            if has_search {
                let title = s.title.as_deref().unwrap_or("").to_lowercase();
                if !title.contains(&search_lower) && !s.id.to_lowercase().contains(&search_lower) && !s.cwd.to_lowercase().contains(&search_lower) {
                    return false;
                }
            }
            true
        })
        .collect();
    let total = filtered.len();
    let sort_k = sort_key.unwrap_or_else(|| "createdAt".to_string());
    filtered.sort_by(|a, b| {
        let primary = if sort_k == "size" {
            a.size.cmp(&b.size)
        } else if sort_k == "turns" {
            a.turns.cmp(&b.turns)
        } else {
            a.created_at.cmp(&b.created_at)
        };
        let ord = if sort_asc { primary } else { primary.reverse() };
        if ord == std::cmp::Ordering::Equal {
            a.id.cmp(&b.id)
        } else {
            ord
        }
    });
    let items = if offset >= filtered.len() {
        Vec::new()
    } else {
        let end = (offset + limit).min(filtered.len());
        filtered[offset..end].to_vec()
    };
    Ok(PagedSessionResult { total, counts, items, is_parse_failed })
}

fn atomic_write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    // 避免 workspace.json -> workspace.tmp 歧义，改为 workspace.json.tmp
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("tmp");
    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    let data = serde_json::to_string_pretty(value)
        .map_err(|e| format!("SESSION_WRITE_FAILED: serialize failed: {e}"))?;
    fs::write(&tmp, data).map_err(|e| format!("SESSION_WRITE_FAILED: write tmp failed: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("SESSION_WRITE_FAILED: rename failed: {e}"))?;
    Ok(())
}

/// 彻底删除会话（文件系统 + 两索引）
pub fn delete<R: tauri::Runtime>(app_handle: &AppHandle<R>, ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Err("INVALID_ID: ids is empty".to_string());
    }
    if ids.len() > 100 {
        return Err("INVALID_ID: too many ids (max 100)".to_string());
    }
    for id in &ids {
        crate::service::fs_guard::validate_session_id(id)?;
    }
    let root = sessions_root(app_handle);
    let workspace_path = storages_dir(app_handle).join("workspace.json");
    let projcache_path = storages_dir(app_handle).join("session_projcache.json");

    // 1) 删除文件系统目录
    for id in &ids {
        let mut found: Option<PathBuf> = None;
        if let Ok(workspaces) = fs::read_dir(&root) {
            for ws in workspaces.flatten() {
                let p = ws.path();
                if !p.is_dir() {
                    continue;
                }
                let candidate = p.join(id);
                if candidate.exists() {
                    found = Some(candidate);
                    break;
                }
            }
        }
        if let Some(target) = found {
            let canonical_target = crate::service::fs_guard::ensure_within(&target, &root)
                .map_err(|e| format!("SESSION_DELETE_FAILED: {e}"))?;
            if canonical_target == dunce::canonicalize(&root).unwrap_or(root.clone()) {
                return Err("SESSION_DELETE_FAILED: refuse to remove root".to_string());
            }
            fs::remove_dir_all(&canonical_target)
                .map_err(|e| format!("SESSION_DELETE_FAILED: remove {} failed: {e}", id))?;
        }
    }

    // 2) 清理 workspace.json
    if workspace_path.exists() {
        let data = fs::read_to_string(&workspace_path)
            .map_err(|e| format!("SESSION_DELETE_FAILED: read workspace.json failed: {e}"))?;
        let mut value: serde_json::Value = serde_json::from_str(&data)
            .map_err(|e| format!("SESSION_DELETE_FAILED: parse workspace.json failed: {e}"))?;
        let mut expanded = HashSet::new();
        for id in &ids {
            expanded.insert(id.clone());
            if id.starts_with("session-") {
                expanded.insert(id["session-".len()..].to_string());
            } else {
                expanded.insert(format!("session-{}", id));
            }
        }
        if let Some(global) = value.get_mut("global") {
            if let Some(arr) = global.get_mut("archivedSessionIds").and_then(|v| v.as_array_mut()) {
                arr.retain(|v| {
                    if let Some(s) = v.as_str() {
                        !expanded.contains(s)
                    } else {
                        true
                    }
                });
            }
        }
        if let Some(tables) = value.get_mut("tables") {
            if let Some(workspaces) = tables.get_mut("workspaces").and_then(|v| v.as_object_mut()) {
                for (_k, ws) in workspaces.iter_mut() {
                    if let Some(arr) = ws.get_mut("sessionIds").and_then(|v| v.as_array_mut()) {
                        arr.retain(|v| {
                            if let Some(s) = v.as_str() {
                                !expanded.contains(s)
                            } else {
                                true
                            }
                        });
                    }
                }
            }
        }
        atomic_write_json(&workspace_path, &value)?;
    }

    // 3) 清理 session_projcache.json
    if projcache_path.exists() {
        let data = fs::read_to_string(&projcache_path)
            .map_err(|e| format!("SESSION_DELETE_FAILED: read projcache failed: {e}"))?;
        let mut value: serde_json::Value = serde_json::from_str(&data)
            .map_err(|e| format!("SESSION_DELETE_FAILED: parse projcache failed: {e}"))?;
        if let Some(tables) = value.get_mut("tables") {
            if let Some(sessions) = tables.get_mut("sessions").and_then(|v| v.as_object_mut()) {
                for id in &ids {
                    sessions.remove(id);
                    if id.starts_with("session-") {
                        sessions.remove(&id["session-".len()..]);
                    } else {
                        sessions.remove(&format!("session-{}", id));
                    }
                }
            }
        }
        atomic_write_json(&projcache_path, &value)?;
    }

    Ok(())
}

/// 恢复归档会话（从 archived 移回 active）
pub fn restore<R: tauri::Runtime>(app_handle: &AppHandle<R>, ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Err("INVALID_ID: ids is empty".to_string());
    }
    if ids.len() > 100 {
        return Err("INVALID_ID: too many ids (max 100)".to_string());
    }
    for id in &ids {
        crate::service::fs_guard::validate_session_id(id)?;
    }
    let workspace_path = storages_dir(app_handle).join("workspace.json");
    if !workspace_path.exists() {
        return Err("SESSION_RESTORE_FAILED: workspace.json not found".to_string());
    }
    let data = fs::read_to_string(&workspace_path)
        .map_err(|e| format!("SESSION_RESTORE_FAILED: read workspace.json failed: {e}"))?;
    let mut value: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| format!("SESSION_RESTORE_FAILED: parse workspace.json failed: {e}"))?;
    let mut expanded = HashSet::new();
    for id in &ids {
        expanded.insert(id.clone());
        if id.starts_with("session-") {
            expanded.insert(id["session-".len()..].to_string());
        } else {
            expanded.insert(format!("session-{}", id));
        }
    }
    // 1) 从 archived 移除
    let mut removed_archived = 0usize;
    if let Some(global) = value.get_mut("global") {
        if let Some(arr) = global.get_mut("archivedSessionIds").and_then(|v| v.as_array_mut()) {
            let before = arr.len();
            arr.retain(|v| {
                if let Some(s) = v.as_str() {
                    !expanded.contains(s)
                } else {
                    true
                }
            });
            removed_archived = before - arr.len();
        }
    }
    if removed_archived == 0 {
        // 无归档命中视为已恢复或非归档，仍尝试确保 active
    }
    // 2) 确保在 active 中（workspaces[].sessionIds）
    // 优先按 projcache cwd 精确匹配 workspace
    let proj_map = load_projcache_map(app_handle);
    // 预取 workspaces 表
    let tables = value.get_mut("tables").and_then(|v| v.as_object_mut());
    if let Some(workspaces) = tables.and_then(|t| t.get_mut("workspaces").and_then(|v| v.as_object_mut())) {
        // 收集现有 active 集合用于去重
        let mut active_all = HashSet::new();
        for ws in workspaces.values() {
            if let Some(arr) = ws.get("sessionIds").and_then(|v| v.as_array()) {
                for v in arr {
                    if let Some(s) = v.as_str() {
                        active_all.insert(s.to_string());
                    }
                }
            }
        }
        for id in &ids {
            // 已在 active 则跳过（检查当前 id 的双形态）
            let mut cur_active = false;
            if active_all.contains(id) {
                cur_active = true;
            } else if id.starts_with("session-") {
                if active_all.contains(&id["session-".len()..].to_string()) {
                    cur_active = true;
                }
            } else if active_all.contains(&format!("session-{}", id)) {
                cur_active = true;
            }
            if cur_active {
                continue;
            }
            // 寻找目标 workspace：优先 cwd 精确匹配
            let mut target_ws_key: Option<String> = None;
            if let Some(entry) = find_proj_entry(&proj_map, id) {
                if let Some(cwd) = &entry.identity.cwd {
                    for (k, ws) in workspaces.iter() {
                        if let Some(path) = ws.get("path").and_then(|v| v.as_str()) {
                            if path == cwd {
                                target_ws_key = Some(k.clone());
                                break;
                            }
                        }
                    }
                }
            }
            // 兜底：取首个 workspace
            if target_ws_key.is_none() {
                if let Some((k, _)) = workspaces.iter().next() {
                    target_ws_key = Some(k.clone());
                }
            }
            if let Some(key) = target_ws_key {
                if let Some(ws) = workspaces.get_mut(&key) {
                    if let Some(arr) = ws.get_mut("sessionIds").and_then(|v| v.as_array_mut()) {
                        // 去重后再 push 原始 id
                        let exists = arr.iter().any(|v| v.as_str() == Some(id.as_str()));
                        if !exists {
                            arr.push(serde_json::Value::String(id.clone()));
                            active_all.insert(id.clone());
                        }
                    }
                }
            }
        }
    }
    atomic_write_json(&workspace_path, &value)?;
    Ok(())
}

pub fn reveal_path<R: tauri::Runtime>(app_handle: &AppHandle<R>, id: String) -> Result<PathBuf, String> {
    crate::service::fs_guard::validate_session_id(&id)?;
    let root = sessions_root(app_handle);
    let mut found: Option<PathBuf> = None;
    if let Ok(workspaces) = fs::read_dir(&root) {
        for ws in workspaces.flatten() {
            let p = ws.path().join(&id);
            if p.exists() {
                found = Some(p);
                break;
            }
        }
    }
    let target = found.ok_or_else(|| format!("SESSION_NOT_FOUND: {id}"))?;
    let canonical = crate::service::fs_guard::ensure_within(&target, &root)
        .map_err(|e| format!("SESSION_REVEAL_FAILED: {e}"))?;
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn test_derive_archived_status() {
        let mut archived = HashSet::new();
        archived.insert("session-abc".to_string());
        let mut active = HashSet::new();
        active.insert("session-def".to_string());
        assert_eq!(derive_archived_status("session-abc", &archived, &active), "archived");
        assert_eq!(derive_archived_status("abc", &archived, &active), "archived");
        assert_eq!(derive_archived_status("session-def", &archived, &active), "active");
        assert_eq!(derive_archived_status("xxx", &archived, &active), "orphan");
    }

    #[test]
    fn test_dir_size_empty() {
        let p = Path::new("/tmp/nonexist_12345");
        assert_eq!(dir_size(p), 0);
    }
}
