//! 剪贴板图片回退桥：让 Linux/WebKitGTK 下 iframe 的「贴图」走原生剪贴板。
//!
//! WebKitGTK 不通过 Web API 暴露 `image/*` 剪贴板条目，因此截图复制到系统剪贴板后，
//! 在桌面端内嵌的 dsh iframe 中输入框按 Ctrl+V 时，`paste` 事件的
//! `clipboardData` 里既没有图片也没有文本。本脚本在**捕获阶段**监听 `paste`，
//! 检测到「无图片且无文本」时：preventDefault → 向宿主 postMessage 请求读取系统
//! 剪贴板图片（宿主调用 `bridge::read_clipboard_image`）→ 拿到 PNG data URL →
//! 构造 File 并重发一次合成 `paste` 事件给当前焦点元素，让 dsh 聊天框按普通
//! 贴图路径处理，从而与浏览器行为一致。
//!
//! 与 [`crate::desktop::notification::NOTIFICATION_SHIM_JS`] / [`crate::desktop::nav::NAV_SHIM_JS`]
//! 走同一套注入通道（Windows 在 FrameCreated → ContentLoading 时 ExecuteScript，
//! 其余平台 `initialization_script_for_all_frames`）。脚本带 `__dsh_clipboard_image_bridge__`
//! 幂等守卫，重复注入安全；只处理「直接 iframe」发来的剪贴板请求，避免多层 iframe 误转发。

pub(crate) const PASTE_SHIM_JS: &str = r#"(function () {
  if (window.__dsh_clipboard_image_bridge__) return;
  window.__dsh_clipboard_image_bridge__ = true;

  // 请求方向：iframe → 宿主；响应方向：宿主 → iframe
  var REQ_SRC = 'dsh-clipboard-image-bridge';
  var RES_SRC = 'dsh-desktop-clipboard';
  var REQ_TYPE = 'dsh://clipboard-image:read';

  var reqSeq = 0;
  var pending = {}; // id -> { resolve, target }

  function requestClipboardImage(target) {
    return new Promise(function (resolve) {
      reqSeq += 1;
      var id = 'req-' + reqSeq;
      pending[id] = { resolve: resolve, target: target };
      try {
        window.parent.postMessage({ source: REQ_SRC, type: REQ_TYPE, id: id }, '*');
      } catch (_) {
        delete pending[id];
        resolve(null);
      }
    });
  }

  // 宿主回包
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.source !== RES_SRC) return;
    var item = pending[data.id];
    if (!item) return;
    delete pending[data.id];
    item.resolve(data.data_url || null);
  });

  // 剪贴板事件里是否已带图片（非 WebKitGTK 场景）：不介入，交 dsh 自身处理
  function hasImageData(dt) {
    if (!dt) return false;
    try {
      if (dt.items) {
        for (var i = 0; i < dt.items.length; i++) {
          var it = dt.items[i];
          if (it && it.type && it.type.indexOf('image/') === 0) return true;
        }
      }
      if (dt.files && dt.files.length > 0) return true;
      var types = dt.types || [];
      for (var j = 0; j < types.length; j++) {
        if (types[j] === 'Files') return true;
      }
    } catch (_) {}
    return false;
  }

  // 剪贴板事件里是否带文本/HTML（普通文本复制）：不介入，让 dsh 正常粘贴文本
  function hasTextData(dt) {
    if (!dt) return false;
    try {
      if (dt.getData('text/plain')) return true;
      if (dt.getData('text/html')) return true;
      var types = dt.types || [];
      return types.indexOf('text/plain') !== -1 || types.indexOf('text/html') !== -1;
    } catch (_) {
      return false;
    }
  }

  function isPasteTarget(target) {
    return !!(target && (target.isContentEditable || /^(textarea|INPUT)$/i.test(target.tagName)));
  }

  function dataUrlToBlob(dataUrl) {
    var comma = dataUrl.indexOf(',');
    if (comma === -1) return null;
    var header = dataUrl.slice(0, comma);
    var mime = (header.match(/:(.*?);/) || [])[1] || 'image/png';
    var b64 = dataUrl.slice(comma + 1);
    try {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    } catch (_) {
      return null;
    }
  }

  // 把图片作为 File 塞进新的 DataTransfer，再派发合成 paste 给焦点元素
  function dispatchImagePaste(target, dataUrl) {
    var blob = dataUrlToBlob(dataUrl);
    if (!blob) return;
    var file = new File([blob], 'clipboard-image.png', { type: blob.type || 'image/png' });
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      var ev;
      try {
        ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      } catch (_) {
        // 个别 WebKit 版本 ClipboardEvent 构造器不支持 clipboardData：用普通事件补属性
        ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
      }
      if (target.isConnected) {
        target.dispatchEvent(ev);
      } else {
        var active = document.activeElement;
        if (active && isPasteTarget(active)) active.dispatchEvent(ev);
      }
    } catch (_) {}
  }

  // 捕获阶段先于 dsh 应用自身监听：空剪贴板时接管并走原生读取。
  // 仅当本窗口是子 frame（dsh iframe）时才接管；顶层壳层文档里没有聊天框，
  // 且 `window.parent` 指向自身，postMessage 不会命中宿主（见 handleClipboardImage），
  // 这里直接把拦截限定在子 frame，避免对壳层输入产生任何干扰。
  if (window !== window.parent) {
    document.addEventListener('paste', function (event) {
      var dt = event.clipboardData;
      if (hasImageData(dt)) return;
      if (hasTextData(dt)) return;

      var target = document.activeElement || event.target;
      if (!isPasteTarget(target)) return;

      event.preventDefault();
      requestClipboardImage(target).then(function (dataUrl) {
        if (dataUrl) dispatchImagePaste(target, dataUrl);
      });
    }, true);
  }
})();"#;
