import crypto from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { loadIdentity } from './localsend-cert.js'

/**
 * Receiving videos from a phone with LocalSend (https://localsend.org), over
 * the Wi-Fi, with no internet and no cable.
 *
 * While it is switched on, this PC is a LocalSend device: it answers phones
 * that look for devices on the network (multicast discovery), and accepts
 * transfers through the LocalSend v2 protocol over HTTPS. Every transfer
 * waits for you to press Accept, unless you said to always accept that
 * phone. Only videos are taken; they land in the videos folder and join the
 * sorting queue through the folder watch (server/arrivals.js).
 *
 * This listener is separate from the app's own server and serves nothing but
 * the five LocalSend routes, so the rest of the app is never reachable from
 * the network. Requests from outside the local network are refused.
 *
 * Phones are told apart by the fingerprint of the certificate they present
 * during the encrypted handshake, which cannot be faked; the name a phone
 * gives itself can. "Always accept" is therefore only offered for a phone
 * that proved its fingerprint.
 */

const GROUP = '224.0.0.167'
const VERSION = '2.1'
const DECIDE_MS = 2 * 60 * 1000 // a request left unanswered this long is declined
const IDLE_MS = 5 * 60 * 1000 // a transfer with no data for this long is ended
const STALL_MS = 90 * 1000 // one file with no data for this long is dropped
const MAX_FILES = 10000

/** Addresses on this computer's own networks (and loopback, for tests). */
function isLocalNet (ip) {
  ip = String(ip || '').replace(/^::ffff:/, '')
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(ip)) return true
  const m = /^172\.(\d+)\./.exec(ip)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  return ip === '::1' || /^(fe80:|fc|fd)/i.test(ip)
}

/** This PC's IPv4 addresses on its networks. */
function addresses () {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  }
  return out
}

/** A phone's file name made safe to save on Windows. */
function cleanName (name) {
  let n = String(name || '').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim()
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n
  return n.slice(0, 200)
}

class Refused extends Error {
  constructor (status, message) { super(message); this.status = status }
}

function readBody (req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Refused(413, 'Too big')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson (req, limit) {
  try { return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}') } catch (err) {
    throw err instanceof Refused ? err : new Refused(400, 'Invalid body')
  }
}

export function mountLocalSend (app, { ROOT, wrap, httpError, getConfig, saveConfig, getSourceDir, isVideoName, uniquePath, emit }) {
  const PORT = Number(process.env.VIDEOSPLITTER_LS_PORT) || 53317
  const DIR = process.env.VIDEOSPLITTER_LOCALSEND || path.join(ROOT, '.localsend')
  const ALIAS = 'Video Splitter (' + os.hostname() + ')'

  let identity = null
  let server = null
  let udp = null
  let state = 'off' // off | starting | on
  let problem = null
  let pending = null // a phone waiting for Accept or Decline
  let session = null // a transfer under way
  let last = null // how the last transfer ended, for the app to show
  const nearby = new Map() // fingerprint -> { alias, model, ip, at }

  const settings = () => {
    const c = getConfig()
    c.localsend = c.localsend || { on: false, trusted: {} }
    c.localsend.trusted = c.localsend.trusted || {}
    return c.localsend
  }

  const info = () => ({
    alias: ALIAS,
    version: VERSION,
    deviceModel: 'Windows',
    deviceType: 'desktop',
    fingerprint: identity ? identity.fingerprint : '',
    port: PORT,
    protocol: 'https',
    download: false
  })

  /* --------------------------------------------------- what the app sees */

  function status () {
    const s = settings()
    return {
      on: state === 'on',
      starting: state === 'starting',
      problem,
      alias: ALIAS,
      addresses: addresses(),
      nearby: [...nearby.values()].filter((d) => Date.now() - d.at < 10 * 60 * 1000).map(({ alias, model }) => ({ alias, model })),
      trusted: Object.entries(s.trusted).map(([fingerprint, t]) => ({ fingerprint, alias: t.alias })),
      request: pending && {
        id: pending.id,
        from: pending.sender.alias,
        model: pending.sender.model,
        canTrust: Boolean(pending.sender.proven),
        count: pending.videos.length,
        bytes: pending.bytes,
        skipped: pending.skipped,
        names: pending.videos.slice(0, 4).map((f) => f.name)
      },
      receiving: session && {
        from: session.alias,
        count: session.files.size,
        done: session.done,
        failed: session.failed,
        bytes: session.bytes,
        received: session.received
      },
      last
    }
  }

  let tick = null
  function changed (now) {
    if (now) { clearTimeout(tick); tick = null; emit('phone', status()); return }
    if (tick) return
    tick = setTimeout(() => { tick = null; emit('phone', status()) }, 400)
  }

  /* ----------------------------------------------- the network listener */

  function reply (res, status, body) {
    if (res.headersSent) return
    res.writeHead(status, body ? { 'Content-Type': 'application/json' } : {})
    res.end(body ? JSON.stringify(body) : undefined)
  }

  /** The fingerprint of the certificate the phone presented, if any. */
  function peerFingerprint (req) {
    try {
      const raw = req.socket.getPeerCertificate(true)?.raw
      return raw ? crypto.createHash('sha256').update(raw).digest('hex').toUpperCase() : null
    } catch { return null }
  }

  async function handle (req, res) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
    if (!isLocalNet(ip)) { reply(res, 403, { message: 'Local network only' }); return }
    const url = new URL(req.url, 'https://localhost')
    const route = req.method + ' ' + url.pathname
    try {
      if (route === 'POST /api/localsend/v2/register') {
        const body = await readJson(req, 64 * 1024)
        seen(body, ip, peerFingerprint(req))
        reply(res, 200, { ...info(), port: undefined, protocol: undefined })
      } else if (route === 'GET /api/localsend/v2/info') {
        reply(res, 200, { ...info(), port: undefined, protocol: undefined })
      } else if (route === 'POST /api/localsend/v2/prepare-upload') {
        await prepare(req, res, ip)
      } else if (route === 'POST /api/localsend/v2/upload') {
        await upload(req, res, ip, url.searchParams)
      } else if (route === 'POST /api/localsend/v2/cancel') {
        cancel(ip, url.searchParams.get('sessionId'))
        reply(res, 200)
      } else {
        reply(res, 404, { message: 'Not found' })
      }
    } catch (err) {
      reply(res, err.status || 500, { message: err.message || 'Unknown error' })
    }
  }

  /** A phone that showed itself on the network, so the app can say it is there. */
  function seen (dev, ip, proven) {
    if (!dev || typeof dev.alias !== 'string') return
    const fp = proven || String(dev.fingerprint || '').toUpperCase()
    if (!fp || (identity && fp === identity.fingerprint)) return
    const had = nearby.has(fp)
    nearby.set(fp, { alias: dev.alias.slice(0, 80), model: typeof dev.deviceModel === 'string' ? dev.deviceModel.slice(0, 40) : null, ip, at: Date.now() })
    if (!had) changed()
  }

  async function prepare (req, res, ip) {
    if (pending || session) throw new Refused(409, 'Blocked by another session')
    const body = await readJson(req, 64 * 1024 * 1024) // previews can make it large
    const sender = body && body.info
    const files = body && body.files
    if (!sender || typeof sender.alias !== 'string' || !files || typeof files !== 'object') throw new Refused(400, 'Invalid body')
    const entries = Object.entries(files)
    if (!entries.length) throw new Refused(400, 'No files provided')
    if (entries.length > MAX_FILES) throw new Refused(400, 'Too many files')

    const src = getSourceDir()
    if (!src) { last = { kind: 'no-folder', from: sender.alias }; changed(true); throw new Refused(403, 'Rejected') }

    const videos = []
    let skipped = 0
    for (const [fid, f] of entries) {
      const name = cleanName(f && f.fileName)
      const size = Number(f && f.size)
      if (!name || !isVideoName(name) || !Number.isSafeInteger(size) || size < 0) { skipped++; continue }
      const modified = Date.parse(f.metadata && f.metadata.modified)
      videos.push({ id: String(fid), name, size, sha256: typeof f.sha256 === 'string' ? f.sha256.toLowerCase() : null, modified: Number.isFinite(modified) ? modified : null })
    }
    const bytes = videos.reduce((t, f) => t + f.size, 0)
    if (!videos.length) {
      last = { kind: 'no-videos', from: sender.alias, skipped }
      changed(true)
      throw new Refused(403, 'Rejected')
    }

    // Enough room on the disk, with a little to spare.
    try {
      const fsInfo = await fsp.statfs(src)
      if (bytes > fsInfo.bavail * fsInfo.bsize - 200 * 1024 * 1024) {
        last = { kind: 'no-room', from: sender.alias, bytes }
        changed(true)
        throw new Refused(403, 'Rejected')
      }
    } catch (err) { if (err instanceof Refused) throw err }

    // The phone's fingerprint counts only if its certificate proves it.
    const certFp = peerFingerprint(req)
    const claimed = String(sender.fingerprint || '').toUpperCase()
    const proven = certFp && (!claimed || claimed === certFp) ? certFp : null
    const who = { alias: sender.alias.slice(0, 80), model: typeof sender.deviceModel === 'string' ? sender.deviceModel.slice(0, 40) : null, proven }
    seen(sender, ip, proven)

    let accepted
    if (proven && settings().trusted[proven]) {
      accepted = true
    } else {
      accepted = await new Promise((resolve) => {
        pending = { id: crypto.randomUUID(), ip, sender: who, videos, skipped, bytes, resolve, timer: setTimeout(() => resolve(false), DECIDE_MS) }
        // The phone gave up waiting (or pressed Cancel and dropped the line).
        res.on('close', () => { if (!res.writableEnded) resolve(false) })
        changed(true)
      })
      clearTimeout(pending && pending.timer)
      pending = null
      changed(true)
    }
    if (!accepted) throw new Refused(403, 'Rejected')
    if (res.destroyed) return

    session = {
      id: crypto.randomUUID(),
      ip,
      alias: who.alias,
      dir: src,
      files: new Map(videos.map((f) => [f.id, { ...f, token: crypto.randomUUID(), status: 'waiting', received: 0 }])),
      bytes,
      received: 0,
      done: 0,
      failed: 0,
      skipped,
      idle: null
    }
    poke()
    last = null
    changed(true)
    reply(res, 200, { sessionId: session.id, files: Object.fromEntries([...session.files].map(([fid, f]) => [fid, f.token])) })
  }

  /** Ends a transfer that has gone quiet. */
  function poke () {
    if (!session) return
    clearTimeout(session.idle)
    const s = session
    s.idle = setTimeout(() => { if (session === s) finish('stalled') }, IDLE_MS)
  }

  function finish (how) {
    const s = session
    if (!s) return
    clearTimeout(s.idle)
    session = null
    for (const f of s.files.values()) if (f.abort) f.abort()
    last = { kind: how, from: s.alias, done: s.done, failed: s.failed + [...s.files.values()].filter((f) => f.status === 'waiting').length, skipped: s.skipped }
    changed(true)
  }

  // Finishing touches one at a time, so two files of the same name never
  // both take "clip (2).mp4".
  let naming = Promise.resolve()
  const place = (fn) => { const p = naming.then(fn); naming = p.catch(() => {}); return p }

  async function upload (req, res, ip, q) {
    const s = session
    const f = s && s.files.get(q.get('fileId') || '')
    if (!q.get('sessionId') || !q.get('fileId') || !q.get('token')) throw new Refused(400, 'Missing parameters')
    if (!s || s.id !== q.get('sessionId') || s.ip !== ip || !f || f.token !== q.get('token') || f.status !== 'waiting') throw new Refused(403, 'Invalid token or IP address')
    f.status = 'busy'
    poke()

    // Written under a name the folder watch ignores, then renamed when whole.
    const tmp = path.join(s.dir, '.' + f.token.slice(0, 8) + '.vs-part')
    const out = fs.createWriteStream(tmp, { flags: 'wx' })
    const hash = f.sha256 ? crypto.createHash('sha256') : null
    let got = 0
    let stall = null
    const ok = await new Promise((resolve) => {
      let settled = false
      const end = (v) => { if (settled) return; settled = true; clearTimeout(stall); resolve(v) }
      const quiet = () => { clearTimeout(stall); stall = setTimeout(() => { req.destroy(); end('stalled') }, STALL_MS) }
      f.abort = () => { req.destroy(); end('cancelled') }
      quiet()
      req.on('data', (c) => {
        got += c.length
        if (got > f.size) { req.destroy(); end('too-big'); return }
        if (hash) hash.update(c)
        f.received = got
        s.received += c.length
        quiet()
        poke()
        changed()
        if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()) }
      })
      req.on('end', () => out.end(() => end(got === f.size ? (hash && hash.digest('hex') !== f.sha256 ? 'checksum' : 'ok') : 'short')))
      req.on('aborted', () => end('cut'))
      req.on('error', () => end('cut'))
      res.on('close', () => end('cut'))
      out.on('error', () => { req.destroy(); end('disk') })
    })
    f.abort = null
    if (ok !== 'ok') {
      // Wait for the file to close (it may still be opening) before removing it.
      if (!out.closed) await new Promise((resolve) => { out.once('close', resolve); out.destroy() })
      await fsp.rm(tmp, { force: true }).catch(() => {})
      f.status = 'failed'
      if (session === s) { s.failed++; s.received -= got; f.received = 0; maybeDone(s) }
      throw new Refused(ok === 'checksum' ? 422 : ok === 'too-big' || ok === 'short' ? 400 : 500, ok === 'checksum' ? 'Checksum mismatch' : 'Upload failed')
    }
    try {
      await place(async () => {
        const target = await uniquePath(path.join(s.dir, f.name))
        await fsp.rename(tmp, target)
        if (f.modified) await fsp.utimes(target, new Date(), new Date(f.modified)).catch(() => {})
      })
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      f.status = 'failed'
      if (session === s) { s.failed++; maybeDone(s) }
      throw new Refused(500, 'Could not save the file')
    }
    f.status = 'done'
    if (session === s) { s.done++; maybeDone(s) }
    reply(res, 200)
  }

  function maybeDone (s) {
    changed()
    if ([...s.files.values()].every((f) => f.status === 'done' || f.status === 'failed')) finish('finished')
  }

  function cancel (ip, sessionId) {
    if (pending && pending.ip === ip) { pending.resolve(false); return }
    if (session && session.ip === ip && (!sessionId || sessionId === session.id)) finish('cancelled')
  }

  /* ----------------------------------------------------------- discovery */

  function announce () {
    if (!udp) return
    const msg = Buffer.from(JSON.stringify({ ...info(), announce: true, announcement: true }))
    for (const delay of [100, 500, 2000]) {
      setTimeout(() => {
        if (!udp) return
        for (const addr of addresses()) {
          try { udp.setMulticastInterface(addr); udp.send(msg, PORT, GROUP) } catch { /* that network went away */ }
        }
      }, delay)
    }
  }

  /** Answers a phone's "who is there?" by introducing this PC to it. */
  function answer (ip, m) {
    if (!isLocalNet(ip)) return
    const port = Number(m.port) || 53317
    const secure = m.protocol !== 'http'
    const body = JSON.stringify(info())
    const opts = {
      host: ip,
      port,
      path: '/api/localsend/v2/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
      ...(secure ? { rejectUnauthorized: false, cert: identity.cert, key: identity.key } : {})
    }
    const req = (secure ? https : http).request(opts, (res) => {
      // Over HTTPS the phone must be the device it announced.
      if (secure) {
        const raw = res.socket.getPeerCertificate && res.socket.getPeerCertificate(true)?.raw
        const fp = raw && crypto.createHash('sha256').update(raw).digest('hex').toUpperCase()
        if (!fp || fp !== String(m.fingerprint || '').toUpperCase()) { res.destroy(); return }
      }
      res.resume()
    })
    req.on('timeout', () => req.destroy())
    // Unreachable over HTTP: answer on the multicast group instead.
    req.on('error', () => {
      if (!udp) return
      try { udp.send(Buffer.from(JSON.stringify({ ...info(), announce: false, announcement: false })), PORT, GROUP) } catch { /* gone */ }
    })
    req.end(body)
  }

  function onMessage (buf, rinfo) {
    let m
    try { m = JSON.parse(buf.toString('utf8')) } catch { return }
    if (!m || typeof m !== 'object' || !m.fingerprint || (identity && String(m.fingerprint).toUpperCase() === identity.fingerprint)) return
    seen(m, rinfo.address, null)
    if (m.announce || m.announcement) answer(rinfo.address, m)
  }

  /* --------------------------------------------------------- on and off */

  async function start () {
    if (state !== 'off') return
    state = 'starting'
    problem = null
    changed(true)
    try {
      identity = await loadIdentity(DIR)
      server = https.createServer({ key: identity.key, cert: identity.cert, requestCert: true, rejectUnauthorized: false }, (req, res) => { handle(req, res) })
      // Big videos over slow Wi-Fi take a long time; uploads have their own
      // stall check instead of Node's overall request limit.
      server.requestTimeout = 0
      server.headersTimeout = 30000
      server.maxConnections = 64
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(PORT, '0.0.0.0', () => { server.off('error', reject); resolve() })
      })
      server.on('error', () => {})

      udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      udp.on('message', onMessage)
      udp.on('error', () => {})
      await new Promise((resolve) => udp.bind(PORT, () => {
        for (const addr of addresses()) { try { udp.addMembership(GROUP, addr) } catch { /* not on that network */ } }
        try { udp.setMulticastTTL(1) } catch { /* default */ }
        resolve()
      }))
      state = 'on'
      announce()
    } catch (err) {
      await stop()
      problem = err && err.code === 'EADDRINUSE'
        ? 'Another program on this PC is already receiving on LocalSend\'s port. Close the LocalSend app on this PC, then switch this on again.'
        : 'Could not start receiving: ' + (err && err.message)
    }
    changed(true)
  }

  async function stop () {
    if (pending) pending.resolve(false)
    if (session) finish('cancelled')
    if (udp) { try { udp.close() } catch { /* closed */ } udp = null }
    if (server) {
      const s = server
      server = null
      const closed = new Promise((resolve) => s.close(() => resolve()))
      s.closeAllConnections() // phones keep connections open; close() alone would wait on them
      await closed
    }
    state = 'off'
    changed(true)
  }

  // Back on after a restart if it was on before.
  if (settings().on) start()

  /* -------------------------------------------------- the app's own API */

  app.get('/api/phone', (_req, res) => { res.json(status()) })

  app.post('/api/phone', wrap(async (req, res) => {
    const on = Boolean(req.body && req.body.on)
    settings().on = on
    await saveConfig()
    if (on) await start(); else { problem = null; await stop() }
    res.json(status())
  }))

  app.post('/api/phone/answer', wrap(async (req, res) => {
    const b = req.body || {}
    if (!pending || pending.id !== b.id) throw httpError(404, 'That request is gone')
    if (b.accept && b.always && pending.sender.proven) {
      settings().trusted[pending.sender.proven] = { alias: pending.sender.alias, at: new Date().toISOString() }
      await saveConfig()
    }
    pending.resolve(Boolean(b.accept))
    res.json(status())
  }))

  app.post('/api/phone/look', (_req, res) => { announce(); res.json(status()) })

  app.post('/api/phone/stop', (_req, res) => { finish('cancelled'); res.json(status()) })

  app.delete('/api/phone/trusted/:fp', wrap(async (req, res) => {
    delete settings().trusted[String(req.params.fp).toUpperCase()]
    await saveConfig()
    res.json(status())
  }))

  return { status, stop }
}
