// PING_URL lets one worker file serve more than one deployment.
// The default is the production backend.
const DEFAULT_PING_URL = 'https://api.minerva.ac.id/api/health'

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ping(env.PING_URL || DEFAULT_PING_URL))
  },
}

async function ping(url) {
  const response = await fetch(url)
  if (!response.ok) {
    console.error('keep-warm ping failed:', url, response.status, response.statusText)
  }
}
