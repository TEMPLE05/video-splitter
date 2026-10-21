import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Auto captions, worked out on this computer with whisper.cpp. Nothing is
 * sent anywhere.
 *
 * The program and its language model are not shipped with the app (the
 * model alone is 148 MB), so the first person to ask for captions downloads
 * them once into `.tools`. On Windows that is a pinned whisper.cpp release; on
 * other systems a `whisper-cli` already on PATH is used.
 *
 * Captions are worked out from the edit's own sound, pieces joined in order
 * with pictures as silence, so every word comes back already in timeline time
 * and cut-out stretches are never transcribed at all.
 */

const WHISPER_ZIP = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip'
const MODELS = {
  base: { label: 'Quick', file: 'ggml-base.bin', size: 147951465 },
  small: { label: 'Better', file: 'ggml-small.bin', size: 487601967 }
}
const modelUrl = (m) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`

export function mountCaptions (app, { ROOT, CACHE_DIR, wrap, httpError, resolveInSource, decodeId, probe, haveTools }) {
  const TOOLS = process.env.VIDEOSPLITTER_TOOLS || path.join(ROOT, '.tools')
  const WDIR = path.join(TOOLS, 'whisper')
  const CAP_DIR = path.join(CACHE_DIR, 'captions')
  const isWin = process.platform === 'win32'

  let install = null // { model, phase, received, total, error }
  const jobs = new Map() // key -> { progress, error, promise }
  let queue = Promise.resolve()

  function findCli () {
    if (!isWin) return 'whisper-cli'
    const walk = (dir, depth) => {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase() === 'whisper-cli.exe') return path.join(dir, e.name)
      }
      if (depth > 3) return null
      for (const e of entries) {
        if (e.isDirectory()) {
          const hit = walk(path.join(dir, e.name), depth + 1)
          if (hit) return hit
        }
      }
      return null
    }
    return walk(WDIR, 0)
  }

  let pathCli = null
  async function cliReady () {
    if (isWin) return Boolean(findCli())
    if (pathCli === null) {
      pathCli = await new Promise((resolve) => {
        const p = spawn('whisper-cli', ['--help'], { windowsHide: true })
        p.on('error', () => resolve(false))
        p.on('close', () => resolve(true))
      })
    }
    return pathCli
  }

  const modelPath = (key) => path.join(WDIR, MODELS[key].file)
  const modelReady = (key) => {
    try { return fs.statSync(modelPath(key)).size === MODELS[key].size } catch { return false }
  }

  async function download (url, target, onBytes) {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || 0
    const part = target + '.part'
    const out = fs.createWriteStream(part)
    let received = 0
    try {
      for await (const chunk of res.body) {
        received += chunk.length
        onBytes(received, total)
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
    } catch (err) {
      out.destroy()
      await fsp.rm(part, { force: true })
      throw err
    }
    await fsp.rename(part, target)
  }

  function unzip (zip, dir) {
    // bsdtar, which ships with Windows 10 and later, reads zip files.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    return new Promise((resolve, reject) => {
      const p = spawn(tar, ['-xf', zip, '-C', dir], { windowsHide: true })
      let err = ''
      p.stderr.on('data', (d) => { err += d })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || 'Could not unpack the program'))))
    })
  }

  async function runInstall (key) {
    await fsp.mkdir(WDIR, { recursive: true })
    if (!(await cliReady())) {
      if (!isWin) throw new Error('Install whisper.cpp so that whisper-cli is on your PATH, then try again')
      install.phase = 'program'
      const zip = path.join(WDIR, 'whisper.zip')
      await download(WHISPER_ZIP, zip, (r, t) => { install.received = r; install.total = t })
      await unzip(zip, WDIR)
      await fsp.rm(zip, { force: true })
      if (!findCli()) throw new Error('The downloaded program did not contain whisper-cli')
    }
    if (!modelReady(key)) {
      install.phase = 'model'
      install.received = 0
      install.total = MODELS[key].size
      await download(modelUrl(MODELS[key]), modelPath(key), (r, t) => { install.received = r; install.total = t || MODELS[key].size })
      if (!modelReady(key)) throw new Error('The language model did not download completely; try again')
    }
  }

  async function status () {
    return {
      supported: isWin || (await cliReady()),
      program: await cliReady(),
      models: Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, { label: m.label, size: m.size, ready: modelReady(k) }])),
      install: install && { model: install.model, phase: install.phase, received: install.received, total: install.total, error: install.error || null }
    }
  }

  app.get('/api/captions/status', wrap(async (_req, res) => {
    res.json(await status())
  }))

  app.post('/api/captions/install', wrap(async (req, res) => {
    const key = MODELS[req.body?.model] ? req.body.model : 'base'
    const busy = install && !install.error && !install.done
    if (!busy) {
      install = { model: key, phase: 'starting', received: 0, total: 0 }
      const mine = install
      runInstall(key)
        .then(() => { mine.done = true })
        .catch((err) => { mine.error = err.message || 'The download failed' })
    }
    res.json(await status())
  }))

  /** Renders the edit's own sound to a 16 kHz mono wav, pieces in order. */
  /**
   * The sound of the edit at 16 kHz mono: the pieces' own sound in order
   * (unless left out), with any added sounds, voice-overs above all, mixed in
   * at their times.
   */
  async function editAudio (file, pieces, out, sounds = [], clipSound = true) {
    const args = ['-hide_banner', '-loglevel', 'error', '-y']
    const graph = []
    const total = pieces.reduce((t, p) => t + (p.kind === 'image' ? p.length : p.end - p.start), 0)
    pieces.forEach((p, i) => {
      if (p.kind === 'image') {
        graph.push(`[${i}:a]atrim=duration=${p.length},asetpts=PTS-STARTPTS[a${i}]`)
        args.push('-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono')
        return
      }
      args.push('-ss', String(p.start), '-t', String(p.end - p.start), '-i', p.file || file)
      if (p.silent || !clipSound) {
        graph.push(`anullsrc=r=16000:cl=mono,atrim=duration=${p.end - p.start}[a${i}]`)
        return
      }
      graph.push(`[${i}:a:0]aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono,apad,atrim=duration=${p.end - p.start},asetpts=PTS-STARTPTS[a${i}]`)
    })
    graph.push(`${pieces.map((_, i) => `[a${i}]`).join('')}concat=n=${pieces.length}:v=0:a=1[clip]`)
    const mixed = ['[clip]']
    sounds.forEach((snd, j) => {
      const k = pieces.length + j
      const from = Math.min(snd.at, total)
      const len = Math.min(snd.len, total - from)
      if (len < 0.05) return
      args.push('-ss', String(snd.from), '-t', String(len), '-i', snd.file)
      graph.push(`[${k}:a:0]aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono,volume=${snd.volume},adelay=${Math.round(from * 1000)}:all=1,apad,atrim=duration=${total}[s${j}]`)
      mixed.push(`[s${j}]`)
    })
    graph.push(mixed.length > 1 ? `${mixed.join('')}amix=inputs=${mixed.length}:duration=first:normalize=0[out]` : '[clip]anull[out]')
    args.push('-filter_complex', graph.join(';'), '-map', '[out]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out)
    const code = await new Promise((resolve) => {
      const p = spawn('ffmpeg', args, { windowsHide: true })
      p.on('error', () => resolve(-1))
      p.on('close', resolve)
    })
    if (code !== 0) throw new Error('Could not read the sound of this edit')
  }

  /**
   * Word by word, each with its own timing. Sounds Whisper describes rather
   * than hears as speech, like "[MUSIC]" or "(laughs)", are left out.
   */
  function wordsFrom (json) {
    const words = []
    let depth = 0
    for (const seg of json.transcription || []) {
      const text = String(seg.text || '').trim()
      if (!text) continue
      const opens = (text.match(/[[(*]/g) || []).length
      const closes = (text.match(/[\])*]/g) || []).length
      const inside = depth > 0 || /^[[(*]/.test(text)
      depth = Math.max(0, depth + opens - closes)
      if (inside || /^\[.*\]$/.test(text)) continue
      words.push({ w: text, a: seg.offsets.from / 1000, b: Math.max(seg.offsets.to, seg.offsets.from + 80) / 1000 })
    }
    return { words, language: json.result?.language || null }
  }

  async function transcribe (job, file, pieces, key, cacheFile, { names, translate, sounds, clipSound }) {
    const base = path.join(os.tmpdir(), `videosplitter-${process.pid}-${crypto.randomUUID()}`)
    const wav = base + '.wav'
    try {
      await editAudio(file, pieces, wav, sounds, clipSound)
      job.progress = 0.02
      const cli = findCli() || 'whisper-cli'
      const threads = String(Math.max(1, Math.min(8, os.cpus().length)))
      await new Promise((resolve, reject) => {
        const p = spawn(cli, ['-m', modelPath(key), '-f', wav, '-l', 'auto', '-t', threads,
          '-ml', '1', '-sow', '-oj', '-of', base, '-pp', '-np',
          // Names and unusual words, so Whisper leans towards spelling them right.
          ...(names ? ['--prompt', 'Names: ' + names + '.'] : []),
          ...(translate ? ['-tr'] : [])], { windowsHide: true, cwd: isWin ? path.dirname(cli) : undefined })
        let err = ''
        p.stderr.on('data', (d) => {
          err = (err + d).slice(-4000)
          const all = [...String(d).matchAll(/progress\s*=\s*(\d+)%/g)]
          if (all.length) job.progress = Math.max(job.progress, 0.02 + 0.97 * Number(all[all.length - 1][1]) / 100)
        })
        p.on('error', reject)
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Whisper failed: ' + (err.trim().split('\n').pop() || code)))))
      })
      const result = wordsFrom(JSON.parse(await fsp.readFile(base + '.json', 'utf8')))
      // A word that sounds like a listed name (same first letter, a letter
      // or two different, like "Messy" for "Messi") takes the listed spelling.
      const listed = String(names || '').split(/[,\n]/).map((n) => n.trim()).filter((n) => n && !/\s/.test(n))
      if (listed.length) {
        for (const w of result.words) {
          const m = /^([^\p{L}\p{N}]*)([\p{L}\p{N}'’-]+)([^\p{L}\p{N}]*)$/u.exec(w.w)
          if (!m) continue
          const heard = m[2].toLowerCase()
          const hit = listed.find((n) => {
            const want = n.toLowerCase()
            if (heard === want) return true
            if (heard[0] !== want[0] || want.length < 4) return false
            return editDistance(heard, want) <= (want.length >= 7 ? 2 : 1)
          })
          if (hit) w.w = m[1] + hit + m[3]
        }
      }
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true })
      await fsp.writeFile(cacheFile, JSON.stringify(result))
      return result
    } finally {
      await fsp.rm(wav, { force: true })
      await fsp.rm(base + '.json', { force: true })
    }
  }

  /**
   * Asked repeatedly by the editor while it waits: starts the job the first
   * time, reports progress while it runs, and hands back the words when done.
   * The same edit asked twice is answered from the cache.
   */
  app.post('/api/captions/transcribe', wrap(async (req, res) => {
    if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')
    const body = req.body || {}
    const model = MODELS[body.model] ? body.model : 'base'
    const names = String(body.names || '').replace(/\s+/g, ' ').trim().slice(0, 400)
    const translate = Boolean(body.translate)
    if (!(await cliReady()) || !modelReady(model)) throw httpError(409, 'Captions need a one-time download first')

    // A project has no clip of its own; every piece names its clip.
    const isProject = Boolean(body.project)
    const file = isProject ? null : resolveInSource(decodeId(String(body.id)))
    let st = { size: 0, mtimeMs: 0 }
    if (!isProject) {
      try { st = await fsp.stat(file) } catch { throw httpError(404, 'That video is no longer there') }
    }
    const clipSound = body.clipSound !== false
    const pieces = []
    const metas = new Map(isProject ? [] : [[file, await probe(file)]])
    for (const p of Array.isArray(body.segments) ? body.segments : []) {
      if (p && p.kind === 'image') {
        const length = Number(p.length)
        if (length > 0) pieces.push({ kind: 'image', length })
        continue
      }
      // A piece from another clip is heard from that clip.
      const pfile = p && p.src ? resolveInSource(decodeId(String(p.src))) : file
      if (!pfile) throw httpError(400, 'A piece of the project does not say which clip it is from')
      if (!metas.has(pfile)) {
        try { metas.set(pfile, await probe(pfile)) } catch { throw httpError(404, 'A clip in the edit is no longer there') }
      }
      const pm = metas.get(pfile)
      const start = Math.max(0, Number(p?.start) || 0)
      const end = Math.min(pm.duration || Number(p?.end), Number(p?.end))
      if (end - start >= 0.05) pieces.push({ kind: 'video', file: pfile, silent: !pm.hasAudio, start, end })
    }
    if (!pieces.length) throw httpError(400, 'Nothing to caption')

    // Added sounds, such as a voice-over, are heard too.
    const sounds = []
    for (const x of Array.isArray(body.sounds) ? body.sounds.slice(0, 50) : []) {
      const sfile = resolveInSource(decodeId(String(x && x.id)))
      if (!fs.existsSync(sfile)) throw httpError(404, 'An added sound file is no longer there')
      const len = Number(x.len)
      if (len > 0) sounds.push({ file: sfile, at: Math.max(0, Number(x.at) || 0), from: Math.max(0, Number(x.from) || 0), len, volume: Math.min(Math.max(Number(x.volume ?? 1), 0), 2) })
    }
    const heard = sounds.length || (clipSound && pieces.some((p) => p.kind === 'video' && !p.silent))
    if (!heard) throw httpError(400, 'There is no sound in this edit to caption. Add a voice-over or turn the clip sound on.')

    const key = crypto.createHash('sha1')
      .update(['captions-v3', file, st.size, st.mtimeMs, model, names, translate, clipSound, JSON.stringify(pieces), JSON.stringify(sounds)].join('|')).digest('hex')
    const cacheFile = path.join(CAP_DIR, key.slice(0, 2), key + '.json')
    try {
      const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'))
      res.json({ state: 'done', ...cached })
      return
    } catch { /* not done yet */ }

    let job = jobs.get(key)
    if (job && job.error) {
      jobs.delete(key)
      res.json({ state: 'error', error: job.error })
      return
    }
    if (!job) {
      job = { progress: 0 }
      jobs.set(key, job)
      // One at a time: Whisper already uses every core.
      queue = queue.then(() => transcribe(job, file, pieces, model, cacheFile, { names, translate, sounds, clipSound }))
        .then(() => { jobs.delete(key) })
        .catch((err) => { job.error = err.message || 'Captions failed' })
    }
    res.json({ state: 'running', progress: job.progress })
  }))
}

/** Letters to change, add or remove to turn one word into another. */
function editDistance (a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = keep
    }
  }
  return row[b.length]
}
