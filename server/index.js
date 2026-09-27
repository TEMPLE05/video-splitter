import express from 'express'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CONFIG_PATH = path.join(ROOT, 'videosplitter.config.json')
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
      const dir = path.join(config.sourceDir, b.name)
      let count = 0
      try {
        const files = await fsp.readdir(dir, { withFileTypes: true })
        count = files.filter(
          (f) => f.isFile() && VIDEO_EXT.has(path.extname(f.name).toLowerCase())
        ).length
      } catch {
        count = 0
      }
      return { id: b.id, name: b.name, count }
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

  const files = entries.filter(
    (e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())
  )

  const out = []
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase()
    let size = 0
    try {
      size = (await fsp.stat(path.join(config.sourceDir, f.name))).size
    } catch {
      // File vanished between readdir and stat. Skip it.
      continue
    }
    out.push({
      id: encodeId(f.name),
      name: f.name,
      size,
      ext,
      playable: PLAYABLE_EXT.has(ext)
    })
  }

  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return out
}

async function snapshot () {
  const [buckets, queue] = await Promise.all([listBuckets(), listQueue()])
  return {
    sourceDir: config.sourceDir,
    buckets,
    queue,
    canUndo: history.length > 0
  }
}

/* ---------------------------------------------------------------------- app */

const app = express()
app.use(express.json())

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

app.get('/api/state', wrap(async (_req, res) => {
  res.json(await snapshot())
}))

// Directory picker. With no dir we hand back the drive letters, because a
// browser cannot give us a server-side folder path any other way.
app.get('/api/browse', wrap(async (req, res) => {
  const dir = req.query.dir

  if (!dir) {
    const drives = []
    for (let c = 65; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\'
      if (fs.existsSync(root)) drives.push({ name: root, path: root })
    }
    if (drives.length === 0) drives.push({ name: '/', path: '/' })
    return res.json({ dir: null, parent: null, entries: drives })
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
    .sort((a, b) => a.name.localeCompare(b.name))

  const parent = path.dirname(full)
  res.json({ dir: full, parent: parent === full ? null : parent, entries: dirs })
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

// Removes the bucket from the sidebar only. The folder and the videos already
// filed into it stay on disk, because deleting sorted work is unrecoverable.
app.delete('/api/buckets/:id', wrap(async (req, res) => {
  config.buckets = config.buckets.filter((b) => b.id !== req.params.id)
  await saveConfig()
  res.json(await snapshot())
}))

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
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }

  res.status(200).set({
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Type': type
  })
  fs.createReadStream(file).pipe(res)
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

  const state = await snapshot()
  res.json({ ...state, moved: { name, bucket: bucket.name } })
}))

app.post('/api/undo', wrap(async (_req, res) => {
  const last = history.pop()
  if (!last) throw httpError(400, 'Nothing to undo')
  if (!fs.existsSync(last.to)) {
    throw httpError(400, 'That file has moved since, so it cannot be undone')
  }

  const restored = await moveFile(last.to, last.from)
  const state = await snapshot()
  res.json({
    ...state,
    restored: { id: encodeId(path.basename(restored)), name: path.basename(restored) }
  })
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
