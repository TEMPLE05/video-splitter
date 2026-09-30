import express from 'express'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
// Both are overridable so a test run can boot an isolated server instead of
// borrowing the one you have open. Sharing it meant a test could repoint your
// source folder and rewrite your bucket list out from under you.
const CONFIG_PATH = process.env.VIDEOSPLITTER_CONFIG || path.join(ROOT, 'videosplitter.config.json')
const PORT = process.env.PORT || 5174

// Browsers can only play a subset of what people have on disk. We still list
// the rest so nothing silently disappears from the queue; the UI flags them.
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'])
const PLAYABLE_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm'])

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo'
}

/* ------------------------------------------------------------------ config */

let config = { sourceDir: null, buckets: [] }

function loadConfig () {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    config = { sourceDir: null, buckets: [], ...raw }
  } catch {
    config = { sourceDir: null, buckets: [] }
  }
}

async function saveConfig () {
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

loadConfig()

/* ------------------------------------------------------------- undo history */

// Session-scoped. Each entry is one completed move, newest last.
const history = []

/* -------------------------------------------------------------- path helpers */

const encodeId = (name) => Buffer.from(name, 'utf8').toString('base64url')
const decodeId = (id) => Buffer.from(id, 'base64url').toString('utf8')

function httpError (status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

// Guards against a crafted id escaping the source folder via .. or an absolute
// path. Everything the API touches has to resolve inside sourceDir.
function resolveInSource (name) {
  if (!config.sourceDir) throw httpError(400, 'No source folder selected')
  const base = path.resolve(config.sourceDir)
  const full = path.resolve(base, name)
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw httpError(400, 'Path escapes the source folder')
  }
  return full
}

// Never overwrite. "clip.mp4" becomes "clip (2).mp4" if the name is taken.
async function uniquePath (target) {
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const stem = path.basename(target, ext)
  let candidate = target
  let n = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, stem + ' (' + n + ')' + ext)
    n += 1
  }
  return candidate
}

// rename() fails with EXDEV across volumes, which happens the moment a bucket
// lives on a different drive than the source. Fall back to copy + unlink.
async function moveFile (from, to) {
  const target = await uniquePath(to)
  try {
    await fsp.rename(from, target)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await fsp.copyFile(from, target)
    await fsp.unlink(from)
  }
  return target
}

/* ------------------------------------------------------------------ scanning */

async function listBuckets () {
  if (!config.sourceDir) return []

  let entries = []
  try {
    entries = await fsp.readdir(config.sourceDir, { withFileTypes: true })
  } catch {
    return []
  }
  const onDisk = entries.filter((e) => e.isDirectory()).map((e) => e.name)

  // Folders that already exist on disk count as buckets. That way the tool
  // adopts the layout you already have instead of ignoring it.
  const known = new Set(config.buckets.map((b) => b.name))
  let changed = false
  for (const name of onDisk) {
    if (!known.has(name)) {
      config.buckets.push({ id: encodeId(name), name })
      changed = true
    }
  }

  // Drop buckets whose folder was deleted outside the app.
  const present = new Set(onDisk)
  const kept = config.buckets.filter((b) => present.has(b.name))
  if (kept.length !== config.buckets.length) {
    config.buckets = kept
    changed = true
  }
  if (changed) await saveConfig()

  return Promise.all(
    config.buckets.map(async (b) => {
      // The UI needs all three to decide what removing this bucket would do
      // before it asks the user to confirm.
      const inside = await bucketContents(path.join(config.sourceDir, b.name))
      return {
        id: b.id,
        name: b.name,
        count: inside ? inside.videos.length : 0,
        edits: inside ? inside.edits : 0,
        others: inside ? inside.others.length : 0
      }
    })
  )
}

async function listQueue () {
  if (!config.sourceDir) return []

  let entries = []
  try {
    entries = await fsp.readdir(config.sourceDir, { withFileTypes: true })
  } catch {
    return []
  }

  // Deliberately no stat() per file. readdir already tells us everything the
  // queue needs, and stat-ing each one turned a folder of a thousand clips
  // into half a second of disk work on every single action.
  const out = entries
    .filter((e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => {
      const ext = path.extname(e.name).toLowerCase()
      return {
        id: encodeId(e.name),
        name: e.name,
        ext,
        playable: PLAYABLE_EXT.has(ext)
      }
    })

  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return out
}

// One bucket's counts, for replies that only need to report what changed.
async function bucketSummary (bucket) {
  const inside = await bucketContents(path.join(config.sourceDir, bucket.name))
  return {
    id: bucket.id,
    name: bucket.name,
    count: inside ? inside.videos.length : 0,
    edits: inside ? inside.edits : 0,
    others: inside ? inside.others.length : 0
  }
}

function queueEntry (name) {
  const ext = path.extname(name).toLowerCase()
  return { id: encodeId(name), name, ext, playable: PLAYABLE_EXT.has(ext) }
}

async function snapshot () {
  const [buckets, queue, tools] = await Promise.all([listBuckets(), listQueue(), haveTools()])
  return {
    sourceDir: config.sourceDir,
    buckets,
    queue,
    canUndo: history.length > 0,
    // The editor is useless without FFmpeg, so the UI needs to know up front.
    tools
  }
}

/* ---------------------------------------------------------------------- app */

const app = express()
app.use(express.json())

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

app.get('/api/state', wrap(async (_req, res) => {
  res.json(await snapshot())
}))

const isVideoName = (n) => VIDEO_EXT.has(path.extname(n).toLowerCase())

async function countVideos (dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && isVideoName(e.name)).length
  } catch {
    // Permission denied on a system folder is normal while browsing.
    return null
  }
}

function listDrives () {
  const drives = []
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\'
    if (fs.existsSync(root)) drives.push({ name: root, path: root })
  }
  if (drives.length === 0) drives.push({ name: '/', path: '/' })
  return drives
}

// The places people actually keep phone transfers, so nobody has to walk down
// from C:\ every time. OneDrive relocates Desktop and Documents, so both
// locations are offered when both exist.
app.get('/api/places', wrap(async (_req, res) => {
  const home = os.homedir()
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer

  const candidates = [
    { label: 'Desktop', dir: path.join(home, 'Desktop') },
    { label: 'Downloads', dir: path.join(home, 'Downloads') },
    { label: 'Videos', dir: path.join(home, 'Videos') },
    { label: 'Pictures', dir: path.join(home, 'Pictures') },
    { label: 'Documents', dir: path.join(home, 'Documents') },
    ...(oneDrive
      ? [
          { label: 'OneDrive Desktop', dir: path.join(oneDrive, 'Desktop') },
          { label: 'OneDrive Documents', dir: path.join(oneDrive, 'Documents') },
          { label: 'OneDrive Pictures', dir: path.join(oneDrive, 'Pictures') }
        ]
      : []),
    { label: 'Home', dir: home }
  ]

  const seen = new Set()
  const places = []
  for (const c of candidates) {
    const full = path.resolve(c.dir)
    if (seen.has(full.toLowerCase()) || !fs.existsSync(full)) continue
    seen.add(full.toLowerCase())
    places.push({ label: c.label, path: full, videos: await countVideos(full) })
  }

  res.json({ places, drives: listDrives() })
}))

// Directory picker. With no dir we hand back the drive letters, because a
// browser cannot give us a server-side folder path any other way.
app.get('/api/browse', wrap(async (req, res) => {
  const dir = req.query.dir

  if (!dir) {
    return res.json({ dir: null, parent: null, crumbs: [], videos: 0, entries: listDrives() })
  }

  const full = path.resolve(String(dir))
  let entries = []
  try {
    entries = await fsp.readdir(full, { withFileTypes: true })
  } catch {
    throw httpError(400, 'Cannot open that folder')
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map((e) => ({ name: e.name, path: path.join(full, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  // Counting inside every subfolder is what makes the list useful: you can see
  // where the videos are without opening each one. Capped so a folder with
  // hundreds of children does not stall the request.
  const SCAN_LIMIT = 60
  await Promise.all(
    dirs.slice(0, SCAN_LIMIT).map(async (d) => { d.videos = await countVideos(d.path) })
  )

  // Clickable breadcrumb segments, so you can jump back up several levels.
  const crumbs = []
  let walk = full
  while (true) {
    const parent = path.dirname(walk)
    crumbs.unshift({ name: path.basename(walk) || walk, path: walk })
    if (parent === walk) break
    walk = parent
  }

  const parent = path.dirname(full)
  res.json({
    dir: full,
    parent: parent === full ? null : parent,
    crumbs,
    videos: await countVideos(full),
    entries: dirs
  })
}))

app.post('/api/source', wrap(async (req, res) => {
  const dir = String((req.body && req.body.dir) || '').trim()
  if (!dir) throw httpError(400, 'A folder path is required')

  const full = path.resolve(dir)
  let stat
  try {
    stat = await fsp.stat(full)
  } catch {
    throw httpError(400, 'That folder does not exist: ' + full)
  }
  if (!stat.isDirectory()) throw httpError(400, 'That path is a file, not a folder')

  config.sourceDir = full
  config.buckets = []
  history.length = 0
  await saveConfig()
  res.json(await snapshot())
}))

// Unselects the current folder and goes back to the picker. Only the app's own
// config is cleared; the folder, its buckets and every video stay on disk.
app.delete('/api/source', wrap(async (_req, res) => {
  config.sourceDir = null
  config.buckets = []
  history.length = 0
  await saveConfig()
  res.json(await snapshot())
}))

app.post('/api/buckets', wrap(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim()
  if (!name) throw httpError(400, 'A bucket name is required')
  if (/[\\/:*?"<>|]/.test(name)) {
    throw httpError(400, 'A bucket name cannot contain these characters: \\ / : * ? " < > |')
  }

  const dir = resolveInSource(name)
  await fsp.mkdir(dir, { recursive: true })
  if (!config.buckets.some((b) => b.name === name)) {
    config.buckets.push({ id: encodeId(name), name })
    await saveConfig()
  }
  res.json(await snapshot())
}))

async function bucketContents (dir) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const isVideo = (n) => VIDEO_EXT.has(path.extname(n).toLowerCase())
  const files = entries.filter((e) => e.isFile()).map((e) => e.name)

  let edits = 0
  try {
    const made = await fsp.readdir(path.join(dir, 'edits'), { withFileTypes: true })
    edits = made.filter((f) => f.isFile()).length
  } catch {
    edits = 0
  }

  return {
    videos: files.filter(isVideo),
    others: files.filter((n) => !isVideo(n)),
    edits
  }
}

/**
 * Removes a bucket for real.
 *
 * Dropping it from the config alone did nothing, because the next scan re-adopts
 * any folder sitting in the source directory. The folder itself has to go.
 *
 * Nothing is deleted: videos are moved back to the source folder so they land
 * in the queue again. Exports and unrecognised files are never touched, and a
 * bucket holding them is refused rather than quietly emptied.
 */
app.delete('/api/buckets/:id', wrap(async (req, res) => {
  const bucket = config.buckets.find((b) => b.id === req.params.id)
  if (!bucket) throw httpError(404, 'Unknown bucket')

  const dir = resolveInSource(bucket.name)
  const inside = await bucketContents(dir)

  // Folder already gone: just forget it.
  if (!inside) {
    config.buckets = config.buckets.filter((b) => b.id !== bucket.id)
    await saveConfig()
    res.json({ ...(await snapshot()), removed: bucket.name, unfiled: 0 })
    return
  }

  if (inside.edits > 0) {
    throw httpError(409,
      `"${bucket.name}" holds ${inside.edits} exported clip${inside.edits === 1 ? '' : 's'} ` +
      'in its edits folder. Move or delete those first, then remove the bucket.')
  }

  if (inside.others.length > 0) {
    throw httpError(409,
      `"${bucket.name}" holds files that are not videos (${inside.others.slice(0, 3).join(', ')}` +
      `${inside.others.length > 3 ? ', …' : ''}). Move them out first, so nothing is lost.`)
  }

  if (inside.videos.length > 0 && req.query.unfile !== '1') {
    throw httpError(409,
      `"${bucket.name}" still holds ${inside.videos.length} video` +
      `${inside.videos.length === 1 ? '' : 's'}.`)
  }

  for (const name of inside.videos) {
    await moveFile(path.join(dir, name), path.join(config.sourceDir, name))
  }

  // Only an empty folder, plus possibly an empty edits folder, is left.
  await fsp.rm(dir, { recursive: true, force: true })

  config.buckets = config.buckets.filter((b) => b.id !== bucket.id)
  await saveConfig()

  res.json({
    ...(await snapshot()),
    removed: bucket.name,
    unfiled: inside.videos.length
  })
}))

/**
 * Pipes a file to the response and, crucially, closes the file when the
 * browser walks away.
 *
 * pipe() does not destroy its source when the destination closes. Every clip
 * change abandons a range request mid-stream, so each one used to leave a file
 * handle and its buffers open for the life of the process. Measured at 40
 * abandoned requests leaking 43 handles, which is why a long sorting session
 * slowly turned choppy and why reloading the page never helped: the leak was
 * on this side.
 */
function sendStream (stream, res) {
  const shut = () => stream.destroy()
  res.on('close', shut)
  res.on('error', shut)
  stream.on('error', () => res.destroy())
  stream.on('close', () => {
    res.off('close', shut)
    res.off('error', shut)
  })
  stream.pipe(res)
}

app.get('/api/video/:id', wrap(async (req, res) => {
  const name = decodeId(req.params.id)
  const file = resolveInSource(name)

  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    throw httpError(404, 'That video is no longer there')
  }

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  const range = req.headers.range

  // Range support is what makes the scrub bar work. Without it the browser has
  // to pull the whole clip down before it can seek.
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    let start = match && match[1] ? parseInt(match[1], 10) : 0
    let end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1

    if (start > end) {
      res.status(416).set('Content-Range', 'bytes */' + stat.size).end()
      return
    }

    res.status(206).set({
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type
    })
    sendStream(fs.createReadStream(file, { start, end }), res)
    return
  }

  res.status(200).set({
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Type': type
  })
  sendStream(fs.createReadStream(file), res)
}))

app.post('/api/assign', wrap(async (req, res) => {
  const body = req.body || {}
  const bucket = config.buckets.find((b) => b.id === body.bucketId)
  if (!bucket) throw httpError(400, 'Unknown bucket')

  const name = decodeId(String(body.id))
  const from = resolveInSource(name)
  if (!fs.existsSync(from)) throw httpError(404, 'That video is no longer there')

  const bucketDir = resolveInSource(bucket.name)
  await fsp.mkdir(bucketDir, { recursive: true })
  const to = await moveFile(from, path.join(bucketDir, name))

  history.push({ from, to, bucket: bucket.name })

  // Only what changed. Returning a full snapshot meant re-listing every bucket
  // and the whole queue on each click, which is what made filing feel stuck on
  // a large folder. The client removes the item and updates this one count.
  res.json({
    moved: { id: body.id, name, bucket: bucket.name },
    bucket: await bucketSummary(bucket),
    canUndo: true
  })
}))

app.post('/api/undo', wrap(async (_req, res) => {
  const last = history.pop()
  if (!last) throw httpError(400, 'Nothing to undo')
  if (!fs.existsSync(last.to)) {
    throw httpError(400, 'That file has moved since, so it cannot be undone')
  }

  const restored = await moveFile(last.to, last.from)
  const name = path.basename(restored)
  const bucket = config.buckets.find((b) => b.name === last.bucket)

  res.json({
    restored: queueEntry(name),
    bucket: bucket ? await bucketSummary(bucket) : null,
    canUndo: history.length > 0
  })
}))

/* ------------------------------------------------------------ ffmpeg layer */

// Always spawned with an argument array and never through a shell, so a
// filename containing spaces or quotes cannot turn into extra arguments.
function run (cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

let toolsReady = null
async function haveTools () {
  if (toolsReady !== null) return toolsReady
  const [a, b] = await Promise.all([
    run('ffmpeg', ['-version']),
    run('ffprobe', ['-version'])
  ])
  toolsReady = a.code === 0 && b.code === 0
  return toolsReady
}

async function probe (file) {
  const { code, stdout } = await run('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file
  ])
  if (code !== 0) throw httpError(500, 'Could not read that video')

  const info = JSON.parse(stdout)
  const video = (info.streams || []).find((s) => s.codec_type === 'video')
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio')
  return {
    duration: Number(info.format?.duration) || 0,
    width: video?.width || 0,
    height: video?.height || 0,
    hasAudio: Boolean(audio),
    vcodec: video?.codec_name || null,
    acodec: audio?.codec_name || null
  }
}

/* ---------------------------------------------------------- editing routes */

// Videos inside one bucket. Ids encode the path relative to the source folder,
// so the existing /api/video route streams them with no change.
app.get('/api/bucket/:id', wrap(async (req, res) => {
  const bucket = config.buckets.find((b) => b.id === req.params.id)
  if (!bucket) throw httpError(404, 'Unknown bucket')

  const dir = resolveInSource(bucket.name)
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    throw httpError(404, 'That bucket folder is gone')
  }

  const videos = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!VIDEO_EXT.has(ext)) continue
    let size = 0
    try {
      size = (await fsp.stat(path.join(dir, entry.name))).size
    } catch {
      continue
    }
    videos.push({
      id: encodeId(bucket.name + '/' + entry.name),
      name: entry.name,
      size,
      ext,
      playable: PLAYABLE_EXT.has(ext)
    })
  }
  videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  // Exports land in a subfolder so they never mix with the originals.
  let edits = 0
  try {
    const made = await fsp.readdir(path.join(dir, 'edits'), { withFileTypes: true })
    edits = made.filter((f) => f.isFile() && VIDEO_EXT.has(path.extname(f.name).toLowerCase())).length
  } catch {
    edits = 0
  }

  res.json({ bucket: { id: bucket.id, name: bucket.name }, videos, edits })
}))

app.get('/api/probe/:id', wrap(async (req, res) => {
  if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')
  const file = resolveInSource(decodeId(req.params.id))
  if (!fs.existsSync(file)) throw httpError(404, 'That video is no longer there')
  res.json(await probe(file))
}))

app.post('/api/export', wrap(async (req, res) => {
  if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')

  const body = req.body || {}
  const file = resolveInSource(decodeId(String(body.id)))
  if (!fs.existsSync(file)) throw httpError(404, 'That video is no longer there')

  const stripAudio = Boolean(body.stripAudio)
  const fast = body.mode === 'fast'
  const segments = Array.isArray(body.segments) ? body.segments : []
  if (segments.length === 0) throw httpError(400, 'Nothing to export. Keep at least one segment.')

  const meta = await probe(file)
  const clean = []
  for (const seg of segments) {
    const start = Math.max(0, Number(seg.start) || 0)
    const end = Math.min(meta.duration || Number(seg.end), Number(seg.end))
    if (!(end > start)) throw httpError(400, 'A segment ends before it starts')
    if (end - start < 0.05) throw httpError(400, 'A segment is too short to export')
    clean.push({ start, end })
  }

  const outDir = path.join(path.dirname(file), 'edits')
  await fsp.mkdir(outDir, { recursive: true })

  const stem = path.basename(file, path.extname(file))
  const written = []

  for (let i = 0; i < clean.length; i++) {
    const { start, end } = clean[i]
    const label = clean.length > 1 ? ' part ' + (i + 1) : ' cut'
    const target = await uniquePath(path.join(outDir, stem + label + '.mp4'))

    // -ss before -i seeks fast; -t then counts forward from there, which is
    // unambiguous. Re-encoding makes the cut land on the exact frame, where a
    // stream copy can only land on a keyframe and drifts by a second or two.
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', file, '-t', String(end - start)]

    if (fast) {
      args.push('-c', 'copy')
      if (stripAudio) args.push('-an')
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
      if (stripAudio) args.push('-an')
      else args.push('-c:a', 'aac')
    }
    args.push('-movflags', '+faststart', target)

    const { code, stderr } = await run('ffmpeg', args)
    if (code !== 0) {
      throw httpError(500, 'FFmpeg failed: ' + (stderr.trim().split('\n').pop() || 'unknown error'))
    }
    let size = 0
    try {
      size = (await fsp.stat(target)).size
    } catch { /* ignore */ }
    written.push({ name: path.basename(target), size })
  }

  res.json({ written, dir: outDir })
}))

/**
 * Pulls the audio out of a clip into its own file.
 *
 * Default is a straight stream copy into .m4a: instant, and bit for bit the
 * audio that was already in the video, with no quality lost to a second
 * encode. Converting to .mp3 is offered because more things will play it, but
 * it re-encodes, so it is the deliberate choice rather than the default.
 */
async function extractAudioTo (file, wantsMp3, { skipIfPresent = false } = {}) {
  const meta = await probe(file)
  if (!meta.hasAudio) return { status: 'no-audio' }

  // A stream copy only works into a container that accepts the codec already
  // there. Anything unusual falls back to mp3.
  const copyable = meta.acodec === 'aac' || meta.acodec === 'alac'
  const lossless = !wantsMp3 && copyable

  const outDir = path.join(path.dirname(file), 'audio')
  await fsp.mkdir(outDir, { recursive: true })

  const stem = path.basename(file, path.extname(file))
  const plain = path.join(outDir, stem + (lossless ? '.m4a' : '.mp3'))

  // Batch runs skip what is already there, so doing a whole bucket twice does
  // not leave you with two of everything.
  if (skipIfPresent && fs.existsSync(plain)) {
    return { status: 'already', name: path.basename(plain), dir: outDir }
  }

  const target = skipIfPresent ? plain : await uniquePath(plain)

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-map', '0:a:0']
  if (lossless) args.push('-c:a', 'copy')
  else args.push('-c:a', 'libmp3lame', '-q:a', '2')
  args.push(target)

  const { code, stderr } = await run('ffmpeg', args)
  if (code !== 0) {
    return { status: 'failed', reason: stderr.trim().split('\n').pop() || 'unknown error' }
  }

  let size = 0
  try {
    size = (await fsp.stat(target)).size
  } catch { /* ignore */ }

  return { status: 'done', name: path.basename(target), size, lossless, dir: outDir, codec: meta.acodec }
}

app.post('/api/audio', wrap(async (req, res) => {
  if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')

  const body = req.body || {}
  const file = resolveInSource(decodeId(String(body.id)))
  if (!fs.existsSync(file)) throw httpError(404, 'That video is no longer there')

  const out = await extractAudioTo(file, body.format === 'mp3')
  if (out.status === 'no-audio') throw httpError(400, 'That clip has no audio track to pull')
  if (out.status === 'failed') throw httpError(500, 'FFmpeg failed: ' + out.reason)

  res.json({
    written: { name: out.name, size: out.size },
    dir: out.dir,
    lossless: out.lossless,
    codec: out.codec
  })
}))

/**
 * Pulls the audio from every clip in one bucket, into that bucket's audio
 * folder. That folder is then a plain folder of tracks, so any music player,
 * on this machine or a phone, can open it as a playlist.
 */
app.post('/api/bucket/:id/audio', wrap(async (req, res) => {
  if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')

  const bucket = config.buckets.find((b) => b.id === req.params.id)
  if (!bucket) throw httpError(404, 'Unknown bucket')

  const dir = resolveInSource(bucket.name)
  const inside = await bucketContents(dir)
  if (!inside) throw httpError(404, 'That bucket folder is gone')
  if (inside.videos.length === 0) throw httpError(400, 'That bucket has no videos in it')

  const wantsMp3 = (req.body || {}).format === 'mp3'
  const tally = { done: 0, already: 0, silent: 0, failed: 0 }
  const problems = []

  for (const name of inside.videos) {
    const out = await extractAudioTo(path.join(dir, name), wantsMp3, { skipIfPresent: true })
    if (out.status === 'done') tally.done++
    else if (out.status === 'already') tally.already++
    else if (out.status === 'no-audio') tally.silent++
    else {
      tally.failed++
      if (problems.length < 3) problems.push(name)
    }
  }

  res.json({ ...tally, total: inside.videos.length, dir: path.join(dir, 'audio'), problems })
}))

/* ----------------------------------------------------- static build, if any */

const DIST = path.join(ROOT, 'dist')
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(DIST, 'index.html'))
  })
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500
  if (status >= 500) console.error(err)
  res.status(status).json({ error: err.message || 'Something went wrong' })
})

app.listen(PORT, '127.0.0.1', () => {
  console.log('  video-splitter api  ->  http://127.0.0.1:' + PORT)
  if (config.sourceDir) console.log('  source folder       ->  ' + config.sourceDir)
})
