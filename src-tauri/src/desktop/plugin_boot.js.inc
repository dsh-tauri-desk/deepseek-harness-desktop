(function () {
  if (window.__dsh_plugin_boot_reload__) return
  window.__dsh_plugin_boot_reload__ = true
  if (window === window.top) return

  var stopped = false
  var sawSplash = false
  var stalledForCurrentSplash = false
  var stalledTimer = null
  var observer = null
  var fallbackTimer = null
  var loadingLabels = ['Loading plugins', 'Loading plugins…', 'Loading plugins...']

  function normalizedText(node) {
    return ((node && node.textContent) || '').replace(/\s+/g, ' ').trim()
  }

  function rootNode() {
    return document.getElementById('root')
  }

  function hasExactText(root, expected) {
    var nodes = root.querySelectorAll('div, span, p')
    for (var index = 0; index < nodes.length; index++) {
      if (normalizedText(nodes[index]) === expected) return true
    }
    return false
  }

  function isOfficialSplash() {
    var root = rootNode()
    if (!root || root.childElementCount !== 1) return false
    var boot = root.querySelector('[data-dsh-boot]')
    if (!boot || boot.parentElement !== root) return false
    if (root.querySelector('main, nav, [role="main"], button, input, textarea, form, iframe, [contenteditable="true"], [data-dsh-app-shell]')) {
      return false
    }
    var hasLoading = false
    for (var index = 0; index < loadingLabels.length; index++) {
      if (hasExactText(boot, loadingLabels[index])) {
        hasLoading = true
        break
      }
    }
    if (!hasExactText(boot, 'HARNESS') || !hasLoading) return false
    var compact = normalizedText(boot).replace(/\s+/g, '')
    return compact === 'HARNESSLoadingplugins'
      || compact === 'HARNESSLoadingplugins…'
      || compact === 'HARNESSLoadingplugins...'
  }

  function isApplicationShell() {
    var root = rootNode()
    if (!root || isOfficialSplash()) return false
    return root.querySelector('main, nav, [role="main"], button, input, textarea, form, iframe, [contenteditable="true"], [data-dsh-app-shell]') !== null
  }

  function send(type) {
    try {
      window.parent.postMessage({
        source: 'dsh-plugin-boot-bridge',
        type: type,
      }, '*')
    }
    catch (_) {}
  }

  function disarmSplash() {
    if (stalledTimer !== null) {
      clearTimeout(stalledTimer)
      stalledTimer = null
    }
    stalledForCurrentSplash = false
  }

  function stop() {
    if (stopped) return
    stopped = true
    disarmSplash()
    if (fallbackTimer !== null) clearInterval(fallbackTimer)
    if (observer !== null) observer.disconnect()
    window.removeEventListener('pagehide', stop)
  }

  function evaluate() {
    if (stopped) return
    if (isApplicationShell()) {
      if (sawSplash) send('dsh://plugin-boot:ready')
      stop()
      return
    }
    if (!isOfficialSplash()) {
      disarmSplash()
      return
    }
    sawSplash = true
    if (stalledTimer !== null || stalledForCurrentSplash) return
    stalledTimer = setTimeout(function () {
      stalledTimer = null
      if (stopped || !isOfficialSplash()) return
      stalledForCurrentSplash = true
      send('dsh://plugin-boot:stalled')
    }, 8000)
  }

  observer = new MutationObserver(evaluate)
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
  fallbackTimer = setInterval(evaluate, 1000)
  window.addEventListener('pagehide', stop)
  evaluate()
})()
