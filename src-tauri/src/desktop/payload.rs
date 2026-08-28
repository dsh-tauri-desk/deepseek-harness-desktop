/// 下载完成事件载荷：`on_download` 的 Finished 分支向前端 emit，
/// 由桌面外壳展示"已保存 + 打开文件夹"提示（iframe 内的下载对用户不可见）。
#[derive(Clone, serde::Serialize)]
pub struct DownloadFinishedPayload {
    /// 原始下载地址（dsh 的 /api/session.export?sessionId=...）
    pub(crate) url: String,
    /// 保存到本地的完整路径；失败或平台拿不到路径时为 None
    pub(crate) path: Option<String>,
    /// 下载是否成功
    pub(crate) success: bool,
}

/// iframe 内 DSH 页面发来的原生通知请求载荷。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNotificationPayload {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) tag: Option<String>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
}
