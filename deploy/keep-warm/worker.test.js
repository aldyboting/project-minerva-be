import { describe, expect, it, mock } from 'bun:test'
import { ping } from './worker.js'

const url = 'https://backend.example/api/health'
const healthy = () => Response.json({ status: 'ok', database: { status: 'connected' } })
const options = () => ({ sleep: mock(async () => {}), logger: { log: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) } })

describe('keep-warm readiness', () => {
  it('accepts the application health response and bypasses caches', async () => {
    const fetcher = mock(async (_url, init) => {
      expect(init.cache).toBe('no-store')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return healthy()
    })
    const deps = options()
    expect((await ping(url, { ...deps, fetcher })).attempt).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(deps.sleep).not.toHaveBeenCalled()
  })

  it('retries a 502 until the application is ready', async () => {
    let attempts = 0
    const fetcher = mock(async () => ++attempts === 1 ? new Response('Bad Gateway', { status: 502 }) : healthy())
    const deps = options()
    expect((await ping(url, { ...deps, fetcher })).attempt).toBe(2)
    expect(deps.sleep).toHaveBeenCalledWith(5_000)
    expect(deps.logger.warn).toHaveBeenCalledWith('keep-warm attempt failed', expect.objectContaining({ status: 502, reason: 'http_error' }))
  })

  it('does not mistake a 200 HTML loading page for a healthy API', async () => {
    let attempts = 0
    const fetcher = mock(async () => ++attempts === 1 ? new Response('<html>Starting</html>') : healthy())
    expect((await ping(url, { ...options(), fetcher })).attempt).toBe(2)
  })

  it('fails the invocation after persistent HTTP errors instead of silently succeeding', async () => {
    const fetcher = mock(async () => new Response('Bad Gateway', { status: 502 }))
    const deps = options()
    await expect(ping(url, { ...deps, fetcher })).rejects.toThrow('failed after 3 attempts')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(deps.sleep.mock.calls).toEqual([[5_000], [10_000]])
    expect(deps.logger.error).toHaveBeenCalledTimes(1)
  })

  it('rejects a disconnected database even when the health endpoint returns 200', async () => {
    const fetcher = mock(async () => Response.json({ status: 'degraded', database: { status: 'disconnected' } }))
    await expect(ping(url, { ...options(), fetcher })).rejects.toThrow('failed after 3 attempts')
  })

  it('recovers from a network failure', async () => {
    let attempts = 0
    const fetcher = mock(async () => {
      if (++attempts === 1) throw new TypeError('fetch failed')
      return healthy()
    })
    expect((await ping(url, { ...options(), fetcher })).attempt).toBe(2)
  })

  it('bounds a hanging request and retries it', async () => {
    let attempts = 0
    const fetcher = mock(async (_url, init) => {
      if (++attempts > 1) return healthy()
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    })
    expect((await ping(url, { ...options(), fetcher, timeoutMs: 20 })).attempt).toBe(2)
  })
})
