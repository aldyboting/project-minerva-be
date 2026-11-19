// PING_URL lets one worker file serve more than one deployment.
// The default is the production backend.
const DEFAULT_PING_URL = 'https://api.minerva.ac.id/api/health'

export default {
  async scheduled(_event, env) {
    // Keep the invocation open until the API is actually ready, and let a
    // failed health check fail the Cron event instead of recording success.
    await ping(env.PING_URL || DEFAULT_PING_URL)
  },
}

export async function ping(url, {
  fetcher = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
  timeoutMs = 40_000,
} = {}) {
  const started = Date.now()
  const target = new URL(url).origin
  for (let attempt = 1; attempt <= 3; attempt++) {
    let status = null
    let reason = 'network_or_timeout'
    try {
      const response = await fetcher(url, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = response.status
      if (!response.ok) {
        reason = 'http_error'
        await response.body?.cancel()
        throw new Error('Backend returned an unsuccessful HTTP status')
      }

      // Render can return an HTML wake-up page with HTTP 200. Only the
      // application's own health response proves it has finished starting.
      reason = 'invalid_health_response'
      const health = await response.json()
      if (health?.status !== 'ok' || health?.database?.status !== 'connected') {
        throw new Error('Backend is not ready')
      }

      const result = { target, attempt, status, durationMs: Date.now() - started }
      logger.log('keep-warm healthy', result)
      return result
    } catch {
      logger.warn('keep-warm attempt failed', { target, attempt, status, reason })
      if (attempt < 3) await sleep(5_000 * attempt)
    }
  }
  logger.error('keep-warm unhealthy', { target, attempts: 3, durationMs: Date.now() - started })
  throw new Error(`Backend health check failed after 3 attempts: ${target}`)
}
