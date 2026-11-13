import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * New videos landing in the videos folder while the app is open, from
 * LocalSend, a phone cable or a copy in Explorer, join the sorting queue
 * without a reload.
 *
 * The folder's top level is watched (only there, since that is the queue;
 * buckets are its subfolders). A file being sent arrives a piece at a time,
 * so it is announced only once its size has stopped changing. Announcements
 * are gathered for a moment and go out together, so twenty videos sent at
 * once make one "20 new videos" rather than twenty.
 *
 * The app listens on GET /api/events, a stream of server-sent events:
 *   hello                          on every connection, so the app can catch
 *                                  up after the server restarts
 *   arrived  { items: [entry] }    new videos for the queue
 */
const SETTLE_MS = 1200 // a file's size must hold this long
const GATHER_MS = 1500 // arrivals within this window go out together
const GIVE_UP_MS = 30 * 60 * 1000 // a send that stalls this long is dropped

export function mountArrivals (app, { getSourceDir, isVideoName, queueEntry }) {
  const clients = new Set()
  let watcher = null
  let watching = null
  const pending = new Map() // name -> { size, since, timer }
  let batch = []
  let batchTimer = null

  function send (event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) {
      try { res.write(line) } catch { clients.delete(res) }
    }
  }

  function announce (name) {
    batch.push(queueEntry(name))
    clearTimeout(batchTimer)
    batchTimer = setTimeout(() => {
      const items = batch
      batch = []
      if (items.length) send('arrived', { items })
    }, GATHER_MS)
  }

  /** Looks at a file until its size settles, then announces it. */
  function settle (dir, name) {
    const file = path.join(dir, name)
    const prev = pending.get(name)
    if (prev) clearTimeout(prev.timer)
    const check = async () => {
      const p = pending.get(name)
      if (!p || watching !== dir) return
      let st
      try { st = await fsp.stat(file) } catch { pending.delete(name); return } // gone, or renamed
      if (!st.isFile()) { pending.delete(name); return }
      if (st.size > 0 && st.size === p.size) {
        pending.delete(name)
        announce(name)
        return
      }
      if (Date.now() - p.since > GIVE_UP_MS) { pending.delete(name); return }
      p.size = st.size
      p.timer = setTimeout(check, SETTLE_MS)
    }
    pending.set(name, { size: -1, since: prev ? prev.since : Date.now(), timer: setTimeout(check, 300) })
  }

  /** Watches the current videos folder; call again whenever it changes. */
  function rewatch () {
    const dir = getSourceDir()
    if (dir === watching && watcher) return
    if (watcher) { try { watcher.close() } catch { /* already closed */ } }
    watcher = null
    watching = dir || null
    for (const p of pending.values()) clearTimeout(p.timer)
    pending.clear()
    if (!dir) return
    try {
      watcher = fs.watch(dir, { persistent: false }, (_type, name) => {
        if (!name || name.includes(path.sep) || !isVideoName(name)) return
        settle(dir, name)
      })
      // The folder deleted or renamed under the app: try again shortly.
      watcher.on('error', () => {
        try { watcher.close() } catch { /* gone */ }
        watcher = null
        setTimeout(rewatch, 5000)
      })
    } catch {
      watcher = null
      setTimeout(rewatch, 5000)
    }
  }

  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    res.flushHeaders()
    res.write('retry: 3000\n\n')
    clients.add(res)
    send('hello', {})
    // A comment now and then, so nothing between closes a quiet connection.
    const beat = setInterval(() => { try { res.write(': still here\n\n') } catch { /* closing */ } }, 25000)
    req.on('close', () => { clearInterval(beat); clients.delete(res) })
  })

  rewatch()
  return { rewatch }
}
