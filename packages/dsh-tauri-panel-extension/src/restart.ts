/**
 * Self-restart for standalone `dsh web`: relaunch the exact invocation that
 * booted this host, then stop this process — so MCP row changes compose
 * without leaving the UI. The desktop shell owns restarts there
 * (DSH_DESKTOP=1 refuses this path — a supervised sidecar must never
 * replace itself, or the supervisor respawns a second process).
 *
 * The replacement is spawned directly with windowsHide: CREATE_NO_WINDOW
 * gives it a hidden console its own console children inherit (no popping
 * windows), unlike a DETACHED_PROCESS spawn which leaves children to create
 * visible consoles. No helper process and no powershell wrapper — on at
 * least one machine a node→node→powershell→node chain was silently blocked
 * by host software before the inner node could even start, while direct
 * node→node spawns are the most battle-tested pattern there is.
 */

import type { IncomingMessage } from 'node:http'
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

/** The boot invocation to replay: entry from argv, execArgv preserved. */
export function dshLaunch(argv: readonly string[] = process.argv, execArgv: readonly string[] = process.execArgv): {
  file: string
  args: string[]
  cwd: string | undefined
  viaShell: boolean
} {
  const entry = argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    // Source launches (`pnpm dsh`) pass a relative entry that the child would
    // resolve against its OWN cwd — absolutize, and keep cwd near the entry
    // so execArgv module hooks (tsx/esm) stay resolvable.
    const abs = resolve(entry)
    return { file: process.execPath, args: [...execArgv, abs, ...argv.slice(2)], cwd: dirname(abs), viaShell: false }
  }
  // Bare `dsh` on Windows is a .cmd shim only a shell can start.
  return { file: 'dsh', args: [...argv.slice(2)], cwd: undefined, viaShell: process.platform === 'win32' }
}

/**
 * Relaunch this exact dsh invocation, then stop this process. The replacement
 * boots slowly (module loading) while this process dies within 500 ms, so
 * port handover needs no delay even for fixed-port launches. Replacement
 * output is logged under tmpdir for post-mortem.
 */
export function scheduleRestart(launch: ReturnType<typeof dshLaunch>): {
  pid: number
  replacementPid: number | undefined
  logOut: string
  logErr: string
} {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = `${tmpdir()}${tmpdir().endsWith('/') ? '' : '\\'}dsh-tauri-panel-extension-restart-${stamp}.out.log`
  const logErr = logOut.replace('.out.log', '.err.log')
  const child = spawn(launch.file, launch.args, {
    cwd: launch.cwd,
    stdio: ['ignore', openSync(logOut, 'a'), openSync(logErr, 'a')],
    env: process.env,
    shell: launch.viaShell,
    windowsHide: true,
  })
  child.unref()
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  return { pid: process.pid, replacementPid: child.pid, logOut, logErr }
}

/**
 * A restart request is process control: only a direct same-origin loopback
 * request qualifies. Any forwarding trace means the loopback peer is a
 * proxy, not the user's browser.
 */
export function trustedRestartRequest(request: IncomingMessage, socketAddress?: string): boolean {
  const address = socketAddress ?? (request.socket.remoteAddress ?? '')
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1')
    return false
  if (request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined) {
    return false
  }
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined)
    return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  }
  catch {
    return false
  }
}

/** Restart ownership: the desktop shell supervises the sidecar and restarts it. */
export function restartOwnedByShell(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DSH_DESKTOP === '1'
}
