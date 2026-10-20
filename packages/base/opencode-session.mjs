import { AsyncLocalStorage } from 'node:async_hooks'

export const name = 'dsh-trading-opencode-session'

const sessions = new AsyncLocalStorage()

/** Only OpenCode Go inference receives the current DSH conversation id. */
function isGoRequest(input) {
  try {
    const url = new URL(input instanceof Request ? input.url : input)
    return url.protocol === 'https:' && url.hostname === 'opencode.ai'
      && (url.pathname.startsWith('/zen/go/') || url.pathname.startsWith('/inference/go/'))
  } catch { return false }
}

/** Restore the existing transport on disposal; never change credentials or attribution. */
export function installSessionHeaders() {
  const upstream = globalThis.fetch
  let active = true
  const fetchWithSession = (input, init) => {
    const sessionId = active ? sessions.getStore() : undefined
    if (!sessionId || !isGoRequest(input)) return upstream(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!headers.has('x-opencode-session')) headers.set('x-opencode-session', sessionId)
    return upstream(input, { ...init, headers })
  }
  globalThis.fetch = fetchWithSession
  return () => {
    active = false
    if (globalThis.fetch === fetchWithSession) globalThis.fetch = upstream
  }
}

/** Async generators execute lazily: scope each iteration, including cancellation. */
export async function* streamWithSession(sessionId, next) {
  const iterator = sessions.run(sessionId, () => next()[Symbol.asyncIterator]())
  let completed = false
  try {
    for (;;) {
      const result = await sessions.run(sessionId, () => iterator.next())
      if (result.done) { completed = true; return }
      yield result.value
    }
  } finally {
    if (!completed && iterator.return) await sessions.run(sessionId, () => iterator.return())
  }
}

/** Deployment-local compatibility for host adapters missing Go's session header. */
export function apply(ctx) {
  ctx.effect(installSessionHeaders)
  ctx.on('llm/stream', async function* (options, next) {
    const sessionId = options.sessionId
    if (options.provider !== 'opencode-go' || typeof sessionId !== 'string'
      || !sessionId.trim() || /[\r\n]/.test(sessionId)) {
      yield* next()
      return
    }
    yield* streamWithSession(sessionId, next)
  })
}
