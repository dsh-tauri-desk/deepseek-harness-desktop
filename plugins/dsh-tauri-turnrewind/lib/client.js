// Client half of dsh-tauri-turnrewind: raises an in-app dialog when the
// current session carries an unsupported-workspace heads-up from the host.
// Hand-wrapped in the dsh client ModuleLoader format (no build step): the web
// app evaluates this file and registers the module under the plugin name.
if (globalThis.__ModuleLoader__) {
  globalThis.__ModuleLoader__.load({ id: 'dsh-tauri-turnrewind', factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const inject = ['sessions', 'locale']

    const NS = 'dsh-tauri-turnrewind'
    const SEEN_KEY = 'turnrewind.seenUnsupportedNotices'
    const MAX_SEEN = 100

    const dictionaries = {
      zh: {
        title: '撤销功能在此工作区不可用',
        intro: '当前会话的工作区不支持文件撤销。对话照常运行，但本工作区内的文件改动无法用 /undo 撤销。',
        reason: '原因',
        ok: '知道了',
      },
      en: {
        title: 'Undo is unavailable in this workspace',
        intro: 'File undo is disabled for this session\'s workspace. Turns still run normally, but changes in this workspace cannot be reverted with /undo.',
        reason: 'Reason',
        ok: 'Got it',
      },
    }

    function readSeen() {
      try {
        const raw = globalThis.localStorage.getItem(SEEN_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list : []
      }
      catch {
        return []
      }
    }

    function markSeen(id) {
      try {
        const seen = readSeen().filter(entry => entry !== id)
        seen.push(id)
        globalThis.localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-MAX_SEEN)))
      }
      catch {
        // Storage may be unavailable; the dialog just re-shows next reload.
      }
    }

    let dialog

    function palette() {
      const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
      return dark
        ? { card: '#1f2937', text: '#f9fafb', muted: '#9ca3af', box: '#111827', boxBorder: '#374151', backdrop: 'rgba(2, 6, 23, 0.6)', button: '#6366f1', buttonText: '#ffffff' }
        : { card: '#ffffff', text: '#111827', muted: '#6b7280', box: '#f3f4f6', boxBorder: '#e5e7eb', backdrop: 'rgba(15, 23, 42, 0.45)', button: '#4f46e5', buttonText: '#ffffff' }
    }

    function ensureDialog() {
      if (dialog)
        return dialog
      const colors = palette()
      const backdrop = document.createElement('div')
      backdrop.setAttribute('role', 'presentation')
      Object.assign(backdrop.style, {
        display: 'none',
        position: 'fixed',
        inset: '0',
        zIndex: '2147483000',
        alignItems: 'center',
        justifyContent: 'center',
        background: colors.backdrop,
      })

      const card = document.createElement('div')
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'true')
      Object.assign(card.style, {
        maxWidth: '440px',
        width: 'calc(100vw - 48px)',
        boxSizing: 'border-box',
        background: colors.card,
        color: colors.text,
        borderRadius: '12px',
        padding: '20px 22px',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: '1.6',
        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.3)',
      })

      const title = document.createElement('div')
      Object.assign(title.style, { fontSize: '15px', fontWeight: '600', marginBottom: '10px' })

      const intro = document.createElement('div')

      const reasonLabel = document.createElement('div')
      Object.assign(reasonLabel.style, { marginTop: '12px', color: colors.muted, fontSize: '12px' })

      const reasonBox = document.createElement('div')
      Object.assign(reasonBox.style, {
        marginTop: '6px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: colors.box,
        border: `1px solid ${colors.boxBorder}`,
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
        maxHeight: '160px',
        overflowY: 'auto',
      })

      const actions = document.createElement('div')
      Object.assign(actions.style, { marginTop: '16px', textAlign: 'right' })
      const button = document.createElement('button')
      button.type = 'button'
      Object.assign(button.style, {
        background: colors.button,
        color: colors.buttonText,
        border: 'none',
        borderRadius: '8px',
        padding: '6px 18px',
        fontSize: '13px',
        cursor: 'pointer',
      })
      actions.appendChild(button)

      card.append(title, intro, reasonLabel, reasonBox, actions)
      backdrop.appendChild(card)
      document.body.appendChild(backdrop)

      function hide() {
        backdrop.style.display = 'none'
      }
      button.addEventListener('click', hide)
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop)
          hide()
      })

      dialog = { backdrop, title, intro, reasonLabel, reasonBox, button }
      return dialog
    }

    function showDialog(t, notices) {
      const el = ensureDialog()
      el.title.textContent = t('title')
      el.intro.textContent = t('intro')
      el.reasonLabel.textContent = t('reason')
      el.reasonBox.textContent = notices.map(notice => notice.reason || notice.id).join('\n')
      el.button.textContent = t('ok')
      el.backdrop.style.display = 'flex'
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'turnrewind locale')
      const t = ctx.locale.bind(NS)
      // Read through the service store, not the ctx.sessions property proxy:
      // the host session service merges a different member under the same name.
      const sessions = ctx.get('sessions')
      ctx.effect(() => {
        const unsubscribe = sessions.list.subscribe(() => {
          const state = sessions.list.getSnapshot()
          const summary = state.current !== undefined ? state.byId[state.current] : undefined
          const value = summary?.projectionValues?.turnrewind
          const notices = Array.isArray(value?.notices) ? value.notices : []
          const fresh = notices.filter(notice => notice && typeof notice.id === 'string' && !readSeen().includes(notice.id))
          if (fresh.length === 0)
            return
          for (const notice of fresh) markSeen(notice.id)
          showDialog(t, fresh)
        })
        return () => {
          unsubscribe()
        }
      }, 'turnrewind dialog runner')
    }

    Object.assign(exports, { apply, inject })
    return module.exports
  } })
}
