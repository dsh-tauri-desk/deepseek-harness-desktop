//! 原生剪贴板图片读取（Linux/WebKitGTK 贴图回退）。
//!
//! WebKitGTK 不通过 Web API（`ClipboardEvent.clipboardData.items/files`）暴露
//! `image/*` 剪贴板条目，导致桌面端内嵌的 dsh iframe 中输入框「贴图」无效
//! （浏览器里却正常）。本命令在 Rust 侧用 `arboard` 读取系统剪贴板图片、编码为
//! PNG data URL 返回；注入到 iframe 的桥脚本（`desktop::paste::PASTE_SHIM_JS`）
//! 拿到该 data URL 后重新派发 `paste` 事件，让 dsh 聊天框按正常贴图路径处理。

use base64::{engine::general_purpose::STANDARD, Engine};

/// 剪贴板图片读取结果：自包含的 PNG data URL（可直接作为 Blob/File 来源）。
#[derive(serde::Serialize)]
pub struct ClipboardImageResponse {
    /// 形如 `data:image/png;base64,...`
    pub data_url: String,
    pub mime: String,
    pub filename: String,
}

/// 从系统剪贴板读取图片并编码为 PNG data URL。
///
/// 剪贴板无图片时返回 `Ok(None)`；读取/编码失败返回 `Err`（前缀 `CLIPBOARD_IMAGE_`）。
#[tauri::command]
pub async fn read_clipboard_image(
    _app: tauri::AppHandle,
) -> Result<Option<ClipboardImageResponse>, String> {
    // arboard 的 Clipboard::new()/get_image() 是阻塞调用（Linux 上需连接显示服务器），
    // 放到 blocking 线程避免阻塞异步运行时与 UI。
    let result =
        tokio::task::spawn_blocking(move || -> Result<Option<ClipboardImageResponse>, String> {
            // 超过约 50MP 的剪贴板图片（≈200MB RGBA）直接拒绝，避免撑爆内存
            const MAX_PIXELS: u64 = 50_000_000;

            let mut clipboard =
                arboard::Clipboard::new().map_err(|e| format!("CLIPBOARD_IMAGE_ACCESS: {e}"))?;

            let image_data = match clipboard.get_image() {
                Ok(data) => data,
                // 剪贴板里没有图片（普通文本/文件等），不是错误
                Err(arboard::Error::ContentNotAvailable) => return Ok(None),
                Err(e) => return Err(format!("CLIPBOARD_IMAGE_READ: {e}")),
            };

            if image_data.width == 0 || image_data.height == 0 {
                return Ok(None);
            }
            let pixel_count = image_data.width as u64 * image_data.height as u64;
            if pixel_count > MAX_PIXELS {
                return Err(format!(
                    "CLIPBOARD_IMAGE_TOO_LARGE: {}x{} ({} px)",
                    image_data.width, image_data.height, pixel_count
                ));
            }

            // arboard 返回 RGBA8 像素，直接包装为 RgbaImage 后用 image 编码成 PNG
            let rgba = image::RgbaImage::from_raw(
                image_data.width as u32,
                image_data.height as u32,
                image_data.bytes.into_owned(),
            )
            .ok_or_else(|| "CLIPBOARD_IMAGE_DECODE: invalid rgba buffer".to_string())?;

            let mut cursor = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(rgba)
                .write_to(&mut cursor, image::ImageFormat::Png)
                .map_err(|e| format!("CLIPBOARD_IMAGE_ENCODE: {e}"))?;

            let b64 = STANDARD.encode(cursor.into_inner());
            Ok(Some(ClipboardImageResponse {
                data_url: format!("data:image/png;base64,{b64}"),
                mime: "image/png".to_string(),
                filename: "clipboard-image.png".to_string(),
            }))
        })
        .await
        .map_err(|e| format!("CLIPBOARD_IMAGE_TASK: {e}"))??;

    Ok(result)
}
