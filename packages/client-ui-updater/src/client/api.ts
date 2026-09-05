/**
 * Updater bridge client: same-origin fetch wrappers over
 * /dshtrading/api/updater (the node half registers the route behind the
 * browser-auth fence; same-origin fetch carries the auth cookie by default).
 * Error semantics mirror the tasks bridge: non-2xx or { ok:false } envelopes
 * become rejections carrying the business code.
 */
import type { UpdaterSnapshot } from '../updater-service.ts'

export class UpdaterBridgeError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
  }
}

async function updaterJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined
    const detail = typeof body?.message === 'string' && body.message !== '' ? ': ' + body.message : ''
    throw new UpdaterBridgeError(response.status, 'updater ' + path + ' failed: ' + String(response.status) + detail, body?.code)
  }
  const wire = await response.json() as T
  if (wire !== null && typeof wire === 'object' && (wire as { ok?: unknown }).ok === false) {
    const business = wire as { code?: string; message?: string }
    throw new UpdaterBridgeError(200, (business.code ?? 'UPDATER_UNKNOWN') + ': ' + (business.message ?? 'updater bridge error'), business.code)
  }
  return wire
}

/** Current updater snapshot (environment + check + apply state). */
export async function fetchUpdaterState(): Promise<UpdaterSnapshot> {
  return updaterJson<UpdaterSnapshot>('/dshtrading/api/updater/state', { headers: { accept: 'application/json' } })
}

/** Run a GitHub release check; force=true bypasses the host-side TTL cache. */
export async function requestUpdaterCheck(force: boolean): Promise<UpdaterSnapshot> {
  return updaterJson<UpdaterSnapshot>(`/dshtrading/api/updater/check?force=${force ? '1' : '0'}`, { headers: { accept: 'application/json' } })
}

/** Start the incremental apply pipeline; returns the running snapshot. */
export async function requestUpdaterApply(): Promise<UpdaterSnapshot> {
  return updaterJson<UpdaterSnapshot>('/dshtrading/api/updater/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

/** Electron shell bridge exposed by the desktop preload (absent in browsers). */
interface DesktopBridge {
  relaunch?: () => void
}

/** Resolve the desktop shell bridge, if this page runs inside DSH Trading. */
export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined' || !('desktop' in window)) return undefined
  return (window as { desktop?: DesktopBridge }).desktop
}
