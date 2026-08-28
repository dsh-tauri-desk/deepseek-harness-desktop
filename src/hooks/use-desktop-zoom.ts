import type { RefObject } from 'react'
import type { ZoomAction } from '@/utils/zoom'
import { invoke } from '@tauri-apps/api/core'
import { useEffect } from 'react'
import { queryClient } from '@/config/client'
import { getIframeOrigin } from '@/utils/iframe'
import { zoomActionFromBridgeMessage, zoomActionFromShortcut } from '@/utils/zoom'

export function useDesktopZoom(iframeRef: RefObject<HTMLIFrameElement | null>) {
  useEffect(() => {
    function applyZoom(action: ZoomAction) {
      void invoke<number>('adjust_webview_zoom', { action })
        .then(() => queryClient.invalidateQueries({ queryKey: ['config'] }))
        .catch(error => console.error('[zoom] adjust_webview_zoom failed:', error))
    }

    function handleKeyDown(event: KeyboardEvent) {
      const action = zoomActionFromShortcut(event)
      if (!action)
        return
      event.preventDefault()
      applyZoom(action)
    }

    function handleMessage(event: MessageEvent<unknown>) {
      if (event.source !== iframeRef.current?.contentWindow)
        return
      const iframeOrigin = getIframeOrigin(iframeRef)
      if (!iframeOrigin || event.origin !== iframeOrigin)
        return
      const action = zoomActionFromBridgeMessage(event.data)
      if (action)
        applyZoom(action)
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('message', handleMessage)
    }
  }, [iframeRef])
}
