import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Playable copies of videos the browser cannot play: .mkv and .avi, and
 * phone videos in HEVC on computers without the decoder for it.
 *
 * A copy is made the first time such a video is opened and kept in the
 * cache, never beside the video. When the picture inside is already H.264
 * and only the file type is the problem, the copy is just repackaged, which
 * takes seconds; otherwise it is re-encoded at up to 720p. Exports always
 * read the original, so nothing is lost.
 *
 * Copies are keyed on the file's name, size and modified time, not its
 * folder, so a copy made while sorting is still found once the video has
 * been filed into a bucket.
 */
export function mountPreviews (app, { CACHE_DIR, wrap, httpError, resolveInSource, decodeId, haveTools }) {
  const DIR = path.join(CACHE_DIR, 'previews')
  const ready = new Set()
  try {
    for (const f of fs.readdirSync(DIR)) if (f.endsWith('.mp4')) ready.add(f.slice(0, -4))
  } catch { /* no copies yet */ }

  const keyOf = (abs, st) => crypto.createHash('sha1').update(path.basename(abs) + '|' + st.size + '|' + st.mtimeMs).digest('hex')
  const fileOf = (key) => path.join(DIR, key + '.mp4')

  /** Whether a playable copy of this file is ready (no disk access). */
  const has = (abs, st) => ready.has(keyOf(abs, st))

  // One copy at a time: re-encoding is heavy, and the laptop is in use.
  const jobs = new Map() // key -> { state, progress, error, waiting }
  let running = null
  const line = []

  function probeCodecs (file) {
    return new Promise((resolve) => {
      const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt:format=duration', '-of', 'json', file], { windowsHide: true })
      let out = ''
      p.stdout.on('data', (d) => { out += d })
      p.on('error', () => resolve(null))
      p.on('close', () => {
        try {
          const j = JSON.parse(out)
          const v = (j.streams || []).find((s) => s.codec_type === 'video')
          const a = (j.streams || []).find((s) => s.codec_type === 'audio')
          resolve({ video: v?.codec_name, pix: v?.pix_fmt, audio: a?.codec_name, duration: Number(j.format?.duration) || 0 })
        } catch { resolve(null) }
      })
    })
  }

  async function make (key, file, hevcOk) {
    const job = jobs.get(key)
    job.state = 'making'
    job.started = Date.now()
    const info = await probeCodecs(file)
    if (!info || !info.video) throw new Error('This file has no picture FFmpeg can read')
    // Already H.264 in 8-bit 4:2:0, or HEVC when the browser asking can
    // decode it (it said so): only the packaging is wrong, so copy it.
    const eightBit = !info.pix || info.pix === 'yuv420p' || info.pix === 'yuvj420p'
    const repack = eightBit && (info.video === 'h264' || (info.video === 'hevc' && hevcOk))
    job.repack = repack
    const video = repack
      ? ['-c:v', 'copy', ...(info.video === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
      : ['-vf', "scale='if(gte(iw,ih),-2,min(720,iw))':'if(gte(iw,ih),min(720,ih),-2)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']
    const audio = !info.audio ? ['-an'] : info.audio === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']
    await fsp.mkdir(DIR, { recursive: true })
    const tmp = fileOf(key) + '.' + process.pid + '.part.mp4'
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats', '-i', file,
      '-map', '0:v:0', '-map', '0:a:0?', ...video, ...audio, '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', tmp]
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', args, { windowsHide: true })
      let err = ''
      p.stdout.on('data', (d) => {
        const m = /out_time_us=(\d+)/.exec(String(d))
        if (m && info.duration > 0) job.progress = Math.min(0.99, Number(m[1]) / 1e6 / info.duration)
      })
      p.stderr.on('data', (d) => { err += d })
      p.on('error', reject)
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || 'FFmpeg could not make a copy')))
    })
    await fsp.rename(tmp, fileOf(key))
    ready.add(key)
  }

  function pump () {
    if (running || !line.length) return
    const { key, file, hevcOk } = line.shift()
    running = key
    make(key, file, hevcOk)
      .then(() => { jobs.delete(key) })
      .catch((err) => { const j = jobs.get(key); if (j) { j.state = 'failed'; j.error = err.message } })
      .finally(() => { running = null; pump() })
  }

  function status (key) {
    if (ready.has(key)) return { state: 'ready', progress: 1 }
    const j = jobs.get(key)
    if (!j) return { state: 'none', progress: 0 }
    // Time left, once enough is done to judge the pace.
    const left = j.state === 'making' && j.progress > 0.02 ? Math.round((Date.now() - j.started) / 1000 * (1 - j.progress) / j.progress) : null
    return { state: j.state, progress: j.progress || 0, left, repack: j.repack, error: j.error, ahead: j.state === 'waiting' ? line.findIndex((x) => x.key === key) + (running ? 1 : 0) : 0 }
  }

  async function locate (id) {
    const file = resolveInSource(decodeId(id))
    try { return { file, key: keyOf(file, await fsp.stat(file)) } } catch { throw httpError(404, 'That video is no longer there') }
  }

  app.get('/api/preview/:id/status', wrap(async (req, res) => {
    const { key } = await locate(req.params.id)
    res.json(status(key))
  }))

  // Start making a copy (or report the one already made or under way).
  app.post('/api/preview/:id', wrap(async (req, res) => {
    if (!(await haveTools())) throw httpError(503, 'FFmpeg is needed to make a playable copy. Install it from the set-up window.')
    const { file, key } = await locate(req.params.id)
    const j = jobs.get(key)
    if (!ready.has(key) && (!j || j.state === 'failed')) {
      jobs.set(key, { state: 'waiting', progress: 0 })
      line.push({ key, file, hevcOk: Boolean(req.body && req.body.hevc) })
      pump()
    }
    res.json(status(key))
  }))

  // The copy itself; Express handles ranges, so seeking works.
  app.get('/api/preview/:id', wrap(async (req, res) => {
    const { key } = await locate(req.params.id)
    if (!ready.has(key)) throw httpError(404, 'No playable copy yet')
    res.set('Cache-Control', 'private, max-age=3600')
    res.sendFile(fileOf(key))
  }))

  return { has }
}
