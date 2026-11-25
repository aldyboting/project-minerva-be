import { setTimeout as sleep } from 'node:timers/promises'

const backend = 'https://minerva-be-mentorship.onrender.com'
const frontend = 'https://minerva-mentorship.pages.dev'
const deadline = Date.now() + 5 * 60_000

async function readJson(url) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('Readiness deadline reached')
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(Math.min(90_000, remaining)),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Expected API JSON, received a loading page or other response')
  }
  return response.json()
}

let ready = false
for (let attempt = 1; Date.now() < deadline; attempt++) {
  let step = 'Backend health'
  try {
    console.log(`Attempt ${attempt}: contacting the mentorship backend`)
    const health = await readJson(`${backend}/api/health`)
    if (health?.status !== 'ok' || health.database?.status !== 'connected') {
      throw new Error('API or MongoDB is still starting')
    }

    step = 'Scholarships through the frontend'
    const page = await readJson(`${frontend}/api/scholarships?pageSize=1`)
    if (!Array.isArray(page?.scholarships) || !Number.isInteger(page.total)) {
      throw new Error('Unexpected scholarship response')
    }

    ready = true
    console.log(`Ready for testing: ${frontend}`)
    break
  } catch (error) {
    console.warn(`${step}: ${error.message}`)
    await sleep(Math.max(0, Math.min(10_000, deadline - Date.now())))
  }
}

if (!ready) {
  console.error(`Readiness checks failed after five minutes. Open ${backend}/api/health and share this run with your mentor if the problem persists.`)
  process.exitCode = 1
}
