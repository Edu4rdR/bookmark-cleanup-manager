import express from 'express'

const app = express()
const port = Number(process.env.PORT || 8787)

app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

const clampTimeout = (value) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return 8000
  return Math.min(Math.max(value, 1500), 20000)
}

const isHttpUrl = (value) => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

const attemptFetch = async (url, method, timeoutMs) => {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method,
        redirect: 'follow',
        headers: {
          'User-Agent': 'BookmarkCleanupManager/0.1',
          Accept: 'text/html,application/xhtml+xml',
        },
      },
      timeoutMs,
    )
    response.body?.cancel()
    return { response, method }
  } catch (error) {
    return { error, method }
  }
}

const normalizeError = (error) => {
  if (!error) return 'Unknown error'
  if (error.name === 'AbortError') return 'Timeout'
  return error.message || 'Request failed'
}

app.post('/api/check', async (req, res) => {
  const { url, timeoutMs } = req.body ?? {}
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ ok: false, error: 'Missing url' })
    return
  }

  if (!isHttpUrl(url)) {
    res
      .status(400)
      .json({ ok: false, error: 'Only http/https URLs are supported' })
    return
  }

  const timeout = clampTimeout(timeoutMs)
  const start = Date.now()

  let attempt = await attemptFetch(url, 'HEAD', timeout)
  if (attempt.response) {
    if (attempt.response.status === 405 || attempt.response.status === 403) {
      attempt = await attemptFetch(url, 'GET', timeout)
    }
  } else if (attempt.error) {
    const fallback = await attemptFetch(url, 'GET', timeout)
    if (fallback.response) {
      attempt = fallback
    }
  }

  const durationMs = Date.now() - start

  if (attempt.error || !attempt.response) {
    res.json({
      ok: false,
      error: normalizeError(attempt.error),
      durationMs,
      method: attempt.method,
    })
    return
  }

  res.json({
    ok: true,
    status: attempt.response.status,
    durationMs,
    method: attempt.method,
  })
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.listen(port, () => {
  console.log(`Scan server listening on http://localhost:${port}`)
})
