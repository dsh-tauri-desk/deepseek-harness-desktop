//! Harness URL 槽位：保存 dsh 通过 stdout 声明的、带 token 的本地访问地址。
//!
//! generation 防旧线程迟到覆盖；事件发送由调用方负责（事件名 `harness-url-detected`）。

use std::sync::{Mutex, OnceLock};

type Slot = (Option<String>, u64);

static SLOT: OnceLock<Mutex<Slot>> = OnceLock::new();

fn lock() -> std::sync::MutexGuard<'static, Slot> {
    SLOT.get_or_init(|| Mutex::new((None, 0)))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// 启动新一轮会话：bump generation、清空旧 URL、返回新 generation。
/// 把返回值传至本轮 spawn 的输出读取线程，让 URL 仅在 generation 仍匹配时写入。
pub fn bump_generation() -> u64 {
    let g = &mut *lock();
    g.1 = g.1.wrapping_add(1);
    g.0 = None;
    g.1
}

/// 仅当 `generation` 仍为当前值时写入 URL。返回是否真的写入。
pub fn try_set(url: String, generation: u64) -> bool {
    let g = &mut *lock();
    if g.1 != generation {
        return false;
    }
    g.0 = Some(url);
    true
}

/// 原子读取 `(url, generation)`。给 [`crate::config::runtime_info`] 用——保证返回给
/// 前端的 fallback URL 与其 generation 来自同一快照，避免 `current_generation()`
/// 单独读取时被 `bump_generation` 撕开而误把端口 fallback 标成新 generation 的
/// token URL。
pub fn snapshot() -> (Option<String>, u64) {
    let g = &*lock();
    (g.0.clone(), g.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // 测试间共享全局 SLOT：串行化避免 bump 互相覆盖对方的 generation。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn bump_increments_and_clears() {
        let _g = lock();
        let g = bump_generation();
        assert!(try_set("http://127.0.0.1:3080/?token=a".into(), g));
        assert_eq!(snapshot().0.as_deref(), Some("http://127.0.0.1:3080/?token=a"));
        bump_generation();
        assert!(snapshot().0.is_none());
    }

    #[test]
    fn stale_generation_writes_are_ignored() {
        let _g = lock();
        let g_old = bump_generation();
        assert!(try_set("http://127.0.0.1:3080/?token=old".into(), g_old));
        let g_new = bump_generation();
        assert!(!try_set("http://127.0.0.1:3080/?token=stale".into(), g_old));
        assert!(snapshot().0.is_none());
        assert!(try_set("http://127.0.0.1:3080/?token=fresh".into(), g_new));
        assert_eq!(snapshot().0.as_deref(), Some("http://127.0.0.1:3080/?token=fresh"));
    }

    #[test]
    fn same_generation_overwrites_idempotently() {
        let _g = lock();
        let g = bump_generation();
        assert!(try_set("http://127.0.0.1:3080/?token=v1".into(), g));
        assert!(try_set("http://127.0.0.1:3080/?token=v2".into(), g));
        assert_eq!(snapshot().0.as_deref(), Some("http://127.0.0.1:3080/?token=v2"));
    }
}
