import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mountCaptions } from './captions.js'
import { mountEdits } from './edits.js'
import { OTHER_FILES, mountLibrary } from './library.js'

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
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

// What the editor can lay over a clip: a new soundtrack, or a still image.
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac'])
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

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

// Natural filename order ("clip 2" before "clip 10"), built once.
// localeCompare with an options object builds a fresh collator on every single
// comparison: measured at 217 ms to sort 1,070 names against 8 ms with this
// shared one. That cost was paid on every refresh of the sorting queue and,
// after the library rebuild, for every folder's cover as well.
const byName = new Intl.Collator(undefined, { numeric: true }).compare

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

/**
 * Claims a free name for a file about to be written, by creating it.
 *
 * uniquePath only looks, so two exports started together both saw the same
 * free name and the second overwrote the first. Creating the file with the
 * exclusive flag is atomic: exactly one caller gets each name, and the writer
 * then fills the empty placeholder.
 */
async function reservePath (target) {
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const stem = path.basename(target, ext)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? target : path.join(dir, stem + ' (' + n + ')' + ext)
    try {
      const handle = await fsp.open(candidate, 'wx')
      await handle.close()
      return candidate
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
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
  // The tidy-up folder holds pictures and documents, never clips to sort.
  const onDisk = entries.filter((e) => e.isDirectory() && e.name !== OTHER_FILES).map((e) => e.name)

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

  return Promise.all(config.buckets.map((b) => bucketGlance(b)))
}

/**
 * The cheap view of a bucket that every screen needs: how many clips, and
 * which one to show as its cover. One directory read, nothing deeper.
 *
 * What removing a bucket would cost is a separate, thorough question asked
 * only when someone is about to remove it, via /api/buckets/:id/contents.
 * Answering it here as well meant scanning every bucket's subfolders on
 * every refresh.
 */
async function bucketGlance (bucket) {
  let entries = []
  try {
    entries = await fsp.readdir(path.join(config.sourceDir, bucket.name), { withFileTypes: true })
  } catch {
    entries = []
  }
  const vids = entries
    .filter((e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
  // The cover is the first clip in name order. Finding it is one pass; no need
  // to sort the whole folder on every refresh just to read element zero.
  const first = vids.reduce((best, n) => (best === null || byName(n, best) < 0 ? n : best), null)
  return {
    id: bucket.id,
    name: bucket.name,
    count: vids.length,
    cover: first ? encodeId(bucket.name + '/' + first) : null
  }
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

  out.sort((a, b) => byName(a.name, b.name))
  return out
}

// One bucket's counts, for replies that only need to report what changed.
const bucketSummary = (bucket) => bucketGlance(bucket)

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
// Exports carry the editor's text as pictures, which for an animated or
// word-by-word captioned episode can run to a hundred megabytes.
app.use(express.json({ limit: '512mb' }))

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
    .sort((a, b) => byName(a.name, b.name))

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

/* ------------------------------------------------------------- saved looks */

/**
 * Looks: a crop, a shape and fill, a caption style and fades, saved under a
 * name to put on any clip in one go. Kept in the config file with the
 * buckets, since they belong to the person rather than to one clip.
 */
const num = (v, lo, hi, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d }

function cleanLook (b) {
  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!name) throw httpError(400, 'Give the look a name')
  const look = { id: String(b.id || crypto.randomUUID()), name, savedAt: new Date().toISOString() }
  if (b.crop && typeof b.crop === 'object') {
    look.crop = { x: num(b.crop.x, 0, 1), y: num(b.crop.y, 0, 1), w: num(b.crop.w, 0.05, 1, 1), h: num(b.crop.h, 0.05, 1, 1) }
    look.cropAspect = num(b.cropAspect, 0.1, 10, 1)
  }
  if (b.canvas !== undefined) {
    look.canvas = ASPECTS[b.canvas] ? b.canvas : 'original'
    look.background = b.background === 'black' ? 'black' : 'blur'
  }
  if (b.caption && typeof b.caption === 'object') {
    const c = b.caption
    look.caption = {
      x: num(c.x, 0, 1, 0.5), y: num(c.y, 0, 1, 0.78), size: num(c.size, 0.02, 0.2, 0.05),
      font: String(c.font || 'heavy').slice(0, 20), style: String(c.style || 'outline').slice(0, 20),
      color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#ffffff', anim: String(c.anim || 'none').slice(0, 20),
      hl: /^#[0-9a-f]{6}$/i.test(c.hl) ? c.hl : '#ffe14d'
    }
  }
  if (b.fadeIn !== undefined || b.fadeOut !== undefined) {
    look.fadeIn = num(b.fadeIn, 0, 5)
    look.fadeOut = num(b.fadeOut, 0, 5)
  }
  look.autoCaptions = Boolean(b.autoCaptions)
  return look
}

app.get('/api/looks', wrap(async (_req, res) => {
  res.json({ looks: config.looks || [] })
}))

app.post('/api/looks', wrap(async (req, res) => {
  const look = cleanLook(req.body || {})
  const looks = (config.looks || []).filter((l) => l.id !== look.id && l.name.toLowerCase() !== look.name.toLowerCase())
  if (looks.length >= 50) throw httpError(400, 'That is a lot of looks; remove one first')
  config.looks = [...looks, look]
  await saveConfig()
  res.json({ looks: config.looks, saved: look })
}))

app.delete('/api/looks/:id', wrap(async (req, res) => {
  config.looks = (config.looks || []).filter((l) => l.id !== req.params.id)
  await saveConfig()
  res.json({ looks: config.looks })
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

// Files Windows and macOS drop into folders on their own. They carry no work of
// yours, so they neither block a removal nor survive one.
const OS_JUNK = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])
const isJunk = (name) => OS_JUNK.has(name.toLowerCase())

// Counts every real file under a folder, however deep.
async function countFilesDeep (dir) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let n = 0
  for (const e of entries) {
    if (e.isDirectory()) n += await countFilesDeep(path.join(dir, e.name))
    else if (!isJunk(e.name)) n++
  }
  return n
}

/**
 * A complete inventory of a bucket, used to decide whether removing it is safe.
 *
 * The earlier version only looked at top-level files and the edits folder. It
 * never looked inside audio/ or any folder you made yourself, so removal
 * reported those buckets as safe and then deleted them recursively, tracks and
 * all. Everything under the bucket is accounted for now.
 */
async function bucketContents (dir) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const isVideo = (n) => VIDEO_EXT.has(path.extname(n).toLowerCase())
  const files = entries.filter((e) => e.isFile() && !isJunk(e.name)).map((e) => e.name)

  const subdirs = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => ({ name: e.name, files: await countFilesDeep(path.join(dir, e.name)) }))
  )
  const sub = (name) => subdirs.find((s) => s.name.toLowerCase() === name)?.files || 0

  return {
    videos: files.filter(isVideo),
    others: files.filter((n) => !isVideo(n)),
    edits: sub('edits'),
    audio: sub('audio'),
    // Any other folder with something in it, such as one you made by hand.
    folders: subdirs
      .filter((s) => s.name.toLowerCase() !== 'edits' && s.name.toLowerCase() !== 'audio' && s.files > 0)
      .map((s) => ({ name: s.name, files: s.files }))
  }
}

/**
 * Deletes a folder only if it holds nothing but empty folders and OS junk.
 *
 * Deliberately not fs.rm with recursive: rmdir refuses a folder that still has
 * anything in it, so even if a check upstream were wrong, or a file arrived
 * mid-removal, this can only ever remove empty structure.
 */
async function removeEmptyTree (dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await removeEmptyTree(full)
    else if (isJunk(e.name)) await fsp.unlink(full)
    else throw httpError(409, `Found "${e.name}" while removing the folder, so it was left in place. Nothing was deleted.`)
  }
  await fsp.rmdir(dir)
}

// What would be lost if this bucket were removed, in words. Null means nothing.
function removalBlocker (name, inside) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  const held = []
  if (inside.audio > 0) held.push(plural(inside.audio, 'pulled audio track', 'pulled audio tracks') + ' in its audio folder')
  if (inside.edits > 0) held.push(plural(inside.edits, 'exported clip', 'exported clips') + ' in its edits folder')
  for (const f of inside.folders) held.push(`${plural(f.files, 'file', 'files')} in a folder called "${f.name}"`)
  if (inside.others.length > 0) {
    held.push(plural(inside.others.length, 'file that is not a video', 'files that are not videos') +
      ` (${inside.others.slice(0, 3).join(', ')}${inside.others.length > 3 ? ', â€¦' : ''})`)
  }
  if (held.length === 0) return null
  const total = inside.audio + inside.edits + inside.others.length +
    inside.folders.reduce((sum, f) => sum + f.files, 0)
  return `"${name}" holds ${held.join(', ')}. Move ${total === 1 ? 'that' : 'those'} out first, so nothing is lost.`
}

// The confirmation sheet asks this before offering the button, so it can say
// exactly what is inside rather than guessing from cached counts.
app.get('/api/buckets/:id/contents', wrap(async (req, res) => {
  const bucket = config.buckets.find((b) => b.id === req.params.id)
  if (!bucket) throw httpError(404, 'Unknown bucket')
  const inside = await bucketContents(resolveInSource(bucket.name))
  if (!inside) {
    res.json({ gone: true, videos: 0, audio: 0, edits: 0, others: 0, folders: [], blocker: null })
    return
  }
  res.json({
    gone: false,
    videos: inside.videos.length,
    audio: inside.audio,
    edits: inside.edits,
    others: inside.others.length,
    folders: inside.folders,
    blocker: removalBlocker(bucket.name, inside)
  })
}))

/**
 * Removes a bucket for real.
 *
 * Dropping it from the config alone did nothing, because the next scan re-adopts
 * any folder sitting in the source directory. The folder itself has to go.
 *
 * Nothing is deleted: videos are moved back to the source folder so they land
 * in the queue again. Anything else in the bucket, whether pulled audio,
 * exports, your own folders or stray files, makes the removal refuse rather
 * than take it with it.
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

  const blocker = removalBlocker(bucket.name, inside)
  if (blocker) throw httpError(409, blocker)

  if (inside.videos.length > 0 && req.query.unfile !== '1') {
    throw httpError(409,
      `"${bucket.name}" still holds ${inside.videos.length} video` +
      `${inside.videos.length === 1 ? '' : 's'}.`)
  }

  for (const name of inside.videos) {
    await moveFile(path.join(dir, name), path.join(config.sourceDir, name))
  }

  // Never a recursive delete. If anything other than empty folders and OS junk
  // is somehow still here, this refuses and leaves the folder alone.
  await removeEmptyTree(dir)

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

  // These clips run around 20 Mbps, so a single 8 second one is 20 MB. Without
  // a validator the browser re-pulls all of it every time you step back with B
  // or undo a filing. The tag covers size and modified time, so an edited or
  // replaced file still invalidates correctly.
  const stamp = stat.mtime.toUTCString()
  const etag = 'W/"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"'
  res.set({
    ETag: etag,
    'Last-Modified': stamp,
    'Cache-Control': 'private, max-age=3600'
  })

  const known = req.headers['if-none-match']
  const since = req.headers['if-modified-since']
  if (!range && ((known && known === etag) || (since && since === stamp))) {
    res.status(304).end()
    return
  }

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

// Subtitle formats that are text, and so can be retimed and carried into an
// mp4. Picture-based ones (Blu-ray PGS, DVD) cannot go into mp4 at all.
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])

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
  // Album art embedded in an audio file shows up as a one-frame "video" stream;
  // it is not a picture track anyone can edit.
  const video = (info.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio')
  const subtitles = (info.streams || [])
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({ index: s.index, codec: s.codec_name, lang: s.tags?.language || null, text: TEXT_SUBS.has(s.codec_name) }))

  // avg_frame_rate reflects what actually plays for variable-rate phone clips;
  // r_frame_rate is the fallback when the average is missing.
  const rate = (s) => {
    const [n, d] = String(s || '').split('/').map(Number)
    return n > 0 && d > 0 ? n / d : 0
  }
  const fps = rate(video?.avg_frame_rate) || rate(video?.r_frame_rate) || 30

  // A phone clip filmed upright is often stored sideways with a rotation flag.
  // FFmpeg turns it upright when decoding, so crops and canvas sizes have to be
  // worked out on the upright size, which is what this reports.
  const rotation = Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0)
  const sideways = Math.abs(rotation) % 180 === 90

  return {
    duration: Number(info.format?.duration) || 0,
    width: (sideways ? video?.height : video?.width) || 0,
    height: (sideways ? video?.width : video?.height) || 0,
    fps: Math.min(Math.max(fps, 1), 240),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    vcodec: video?.codec_name || null,
    acodec: audio?.codec_name || null,
    subtitles
  }
}

/* ---------------------------------------------------------- editing routes */

// Videos inside one bucket. Ids encode the path relative to the source folder,
// so the existing /api/video route streams them with no change.
// Saved edits, so the library can mark clips you have worked on.
const savedEdits = mountEdits(app, { ROOT, wrap, httpError, resolveInSource, decodeId })
mountLibrary(app, {
  wrap, httpError, resolveInSource, decodeId, encodeId, getConfig: () => config, saveConfig, reservePath, savedEdits, VIDEO_EXT, isJunk
})

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

  // Sizes read in parallel. One at a time, a folder of 187 clips on OneDrive
  // took up to 275 ms before the library could draw anything.
  const candidates = entries.filter((e) =>
    e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
  const videos = (await Promise.all(candidates.map(async (entry) => {
    const ext = path.extname(entry.name).toLowerCase()
    try {
      const st = await fsp.stat(path.join(dir, entry.name))
      return {
        id: encodeId(bucket.name + '/' + entry.name),
        name: entry.name,
        size: st.size,
        ext,
        playable: PLAYABLE_EXT.has(ext),
        edited: savedEdits.has(path.join(dir, entry.name))
      }
    } catch {
      return null
    }
  }))).filter(Boolean)
  videos.sort((a, b) => byName(a.name, b.name))

  // Exports and pulled audio live in subfolders so they never mix with the
  // originals; the header shows how many of each there are.
  const countIn = async (sub, test) => {
    try {
      const made = await fsp.readdir(path.join(dir, sub), { withFileTypes: true })
      return made.filter((f) => f.isFile() && test(f.name)).length
    } catch {
      return 0
    }
  }
  const [edits, audio] = await Promise.all([
    countIn('edits', (n) => VIDEO_EXT.has(path.extname(n).toLowerCase())),
    countIn('audio', (n) => !isJunk(n))
  ])

  res.json({ bucket: { id: bucket.id, name: bucket.name }, videos, edits, audio })
}))

/* ---------------------------------------------------------------- thumbnails */

// Kept beside the app, never inside your folders, so the cache can't end up in
// a bucket or get swept along by anything that moves files around.
const CACHE_DIR = process.env.VIDEOSPLITTER_CACHE || path.join(ROOT, '.cache')
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs')

// Runs at most `max` jobs at once and queues the rest.
function limiter (max) {
  let active = 0
  const waiting = []
  const pump = () => {
    while (active < max && waiting.length) {
      const job = waiting.shift()
      active++
      job.fn().then(job.resolve, job.reject).finally(() => {
        active--
        pump()
      })
    }
  }
  return (fn) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject })
    pump()
  })
}

// Three at a time: enough to fill a screen of cards quickly without a big
// folder starting dozens of FFmpeg processes at once.
const thumbSlot = limiter(3)
const thumbsInFlight = new Map()

async function renderThumb (file, out) {
  await fsp.mkdir(path.dirname(out), { recursive: true })
  const tmp = out.replace(/\.jpg$/, `.${process.pid}.${Date.now()}.tmp.jpg`)
  // Half a second in usually skips a black opening frame. Clips shorter than
  // that fall back to the very first frame.
  for (const at of ['0.5', '0']) {
    const { code } = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', at, '-i', file,
      '-frames:v', '1', '-an', '-sn',
      '-vf', "scale='min(360,iw)':-2",
      '-q:v', '6', '-update', '1', tmp
    ])
    let made = false
    try {
      made = code === 0 && (await fsp.stat(tmp)).size > 0
    } catch {
      made = false
    }
    if (made) {
      // Written under a temporary name and renamed into place, so a request
      // can never be handed a half-written image.
      await fsp.rename(tmp, out)
      return true
    }
    await fsp.rm(tmp, { force: true })
  }
  // Remember the failure, so an audio-only file is not retried on every view.
  await fsp.writeFile(out + '.none', '')
  return false
}

/**
 * A small still frame for a library card.
 *
 * Cards used to be <video> elements, so opening a folder of 187 clips made the
 * browser start 187 video downloads at once. Browsers only allow six
 * connections to one server, so every other click queued behind them. A cached
 * JPEG of a few kilobytes replaces each of those.
 */
app.get('/api/thumb/:id', wrap(async (req, res) => {
  const file = resolveInSource(decodeId(req.params.id))
  let st
  try {
    st = await fsp.stat(file)
  } catch {
    throw httpError(404, 'That video is no longer there')
  }

  // Keyed on path, size and modified time, so a replaced or edited file gets a
  // fresh frame rather than a stale one.
  const key = crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs).digest('hex')
  const etag = '"' + key + '"'
  res.set({ ETag: etag, 'Cache-Control': 'private, max-age=3600' })
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end()
    return
  }

  const out = path.join(THUMB_DIR, key.slice(0, 2), key + '.jpg')
  if (fs.existsSync(out + '.none')) throw httpError(404, 'No frame could be taken from that video')

  if (!fs.existsSync(out)) {
    if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')
    // Several cards can ask for the same frame at once; they share one render.
    let job = thumbsInFlight.get(key)
    if (!job) {
      job = thumbSlot(() => renderThumb(file, out)).finally(() => thumbsInFlight.delete(key))
      thumbsInFlight.set(key, job)
    }
    if (!(await job)) throw httpError(404, 'No frame could be taken from that video')
  }

  res.type('image/jpeg')
  sendStream(fs.createReadStream(out), res)
}))

/* ------------------------------------------------- editor strip and waveform */

const STRIP_DIR = path.join(CACHE_DIR, 'strips')
const WAVE_DIR = path.join(CACHE_DIR, 'waves')
const STRIP_H = 72
const STRIP_COLS = 20
const STRIP_MAX = 240
const WAVE_RATE = 50

// Both decode whole files, so they get their own small pool and never crowd
// out the thumbnail renders the library depends on.
const heavySlot = limiter(2)
const heavyInFlight = new Map()

function cacheKey (kind, file, st) {
  return crypto.createHash('sha1').update(kind + '|' + file + '|' + st.size + '|' + st.mtimeMs).digest('hex')
}

/** Builds once, shares the build between simultaneous callers, keeps it on disk. */
async function cachedJson (dir, key, build) {
  const file = path.join(dir, key.slice(0, 2), key + '.json')
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch { /* not built yet */ }

  let job = heavyInFlight.get(key)
  if (!job) {
    job = heavySlot(async () => {
      const value = await build()
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, JSON.stringify(value))
      return value
    }).finally(() => heavyInFlight.delete(key))
    heavyInFlight.set(key, job)
  }
  return job
}

/**
 * A strip of frames across a whole clip, tiled into one image, plus the time
 * each frame was taken at.
 *
 * Short clips are cheap to decode, so they get two frames a second. Long ones
 * decode keyframes only, which skips nearly all the work: a nine-minute episode
 * takes under two seconds this way. The frames are spaced out so no clip
 * produces more than STRIP_MAX of them.
 */
async function buildStrip (file, key) {
  const meta = await probe(file)
  if (!meta.hasVideo || !(meta.duration > 0)) return { none: true }

  const out = path.join(STRIP_DIR, key.slice(0, 2), key + '.jpg')
  await fsp.mkdir(path.dirname(out), { recursive: true })
  const tmp = out.replace(/\.jpg$/, `.${process.pid}.${Date.now()}.tmp.jpg`)

  const short = meta.duration <= 120
  const expected = short ? Math.ceil(meta.duration * 2) + 2 : STRIP_MAX + 2
  const rows = Math.max(1, Math.ceil(expected / STRIP_COLS))
  const interval = meta.duration / STRIP_MAX

  // showinfo reports each frame's timestamp as it is tiled, so the times come
  // from the frames actually used rather than from an estimate.
  const pick = short
    ? 'fps=2'
    : `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval.toFixed(3)})'`
  const args = [
    '-hide_banner', '-loglevel', 'info', '-y',
    ...(short ? [] : ['-skip_frame', 'nokey']),
    '-i', file, '-an', '-sn',
    '-vf', `${pick},scale=-2:${STRIP_H},showinfo,tile=${STRIP_COLS}x${rows}`,
    '-frames:v', '1', '-update', '1', '-q:v', '5', tmp
  ]
  const { code, stderr } = await run('ffmpeg', args)

  const lines = stderr.split(/\r?\n/).filter((l) => l.includes('Parsed_showinfo') && l.includes('pts_time:'))
  const times = lines.map((l) => Number(/pts_time:\s*([-\d.]+)/.exec(l)?.[1])).filter(Number.isFinite)
  const size = /\ss:(\d+)x(\d+)/.exec(lines[0] || '')

  let made = false
  try {
    made = code === 0 && (await fsp.stat(tmp)).size > 0
  } catch {
    made = false
  }
  if (!made || !times.length || !size) {
    await fsp.rm(tmp, { force: true })
    return { none: true }
  }
  await fsp.rename(tmp, out)

  return {
    cols: STRIP_COLS,
    rows,
    frameW: Number(size[1]),
    frameH: Number(size[2]),
    // Never more cells than the tile holds, in case a final frame spilled over.
    times: times.slice(0, STRIP_COLS * rows)
  }
}

/** Peak loudness, WAVE_RATE values per second, each squeezed into one byte. */
function buildWave (file, hasAudio) {
  if (!hasAudio) return Promise.resolve({ rate: WAVE_RATE, hasAudio: false, peaks: '' })
  const SR = 4000
  const per = SR / WAVE_RATE
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { windowsHide: true })
    const peaks = []
    let carry = Buffer.alloc(0)
    let count = 0
    let peak = 0
    p.stdout.on('data', (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const usable = buf.length - (buf.length % 2)
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i))
        if (v > peak) peak = v
        if (++count === per) {
          peaks.push(peak)
          peak = 0
          count = 0
        }
      }
      carry = buf.subarray(usable)
    })
    p.on('error', () => resolve({ rate: WAVE_RATE, hasAudio: false, peaks: '' }))
    p.on('close', () => {
      if (count) peaks.push(peak)
      // Square root so quiet speech still shows, rather than only the loud bits.
      const bytes = Uint8Array.from(peaks, (v) => Math.min(255, Math.round(Math.sqrt(v / 32768) * 255)))
      resolve({ rate: WAVE_RATE, hasAudio: true, peaks: Buffer.from(bytes).toString('base64') })
    })
  })
}

async function statSource (id) {
  const file = resolveInSource(decodeId(id))
  try {
    return { file, st: await fsp.stat(file) }
  } catch {
    throw httpError(404, 'That video is no longer there')
  }
}

app.get('/api/strip/:id', wrap(async (req, res) => {
  if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')
  const { file, st } = await statSource(req.params.id)
  const key = cacheKey('strip-v1', file, st)
  const manifest = await cachedJson(STRIP_DIR, key, () => buildStrip(file, key))
  res.set('Cache-Control', 'private, max-age=3600')
  res.json(manifest.none ? manifest : { ...manifest, image: `/api/strip/${req.params.id}/image?k=${key}` })
}))

app.get('/api/strip/:id/image', wrap(async (req, res) => {
  const { file, st } = await statSource(req.params.id)
  const key = cacheKey('strip-v1', file, st)
  const out = path.join(STRIP_DIR, key.slice(0, 2), key + '.jpg')
  if (!fs.existsSync(out)) throw httpError(404, 'Strip not built yet')
  // The key is in the URL, so a changed file gets a different address and
  // this one can be cached for good.
  res.set('Cache-Control', 'private, max-age=31536000, immutable')
  res.type('image/jpeg')
  sendStream(fs.createReadStream(out), res)
}))

app.get('/api/wave/:id', wrap(async (req, res) => {
  if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')
  const { file, st } = await statSource(req.params.id)
  const key = cacheKey('wave-v1', file, st)
  const wave = await cachedJson(WAVE_DIR, key, async () => buildWave(file, (await probe(file)).hasAudio))
  res.set('Cache-Control', 'private, max-age=3600')
  res.json(wave)
}))

app.get('/api/probe/:id', wrap(async (req, res) => {
  if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')
  const file = resolveInSource(decodeId(req.params.id))
  if (!fs.existsSync(file)) throw httpError(404, 'That video is no longer there')
  res.json(await probe(file))
}))

/* ------------------------------------------------- editor media: audio, images */

const mediaKinds = {
  audio: { folder: 'audio', ext: AUDIO_EXT },
  image: { folder: 'images', ext: IMAGE_EXT }
}

function bucketOf (id) {
  const bucket = config.buckets.find((b) => b.id === id)
  if (!bucket) throw httpError(404, 'Unknown bucket')
  return bucket
}

/**
 * Sound files and pictures a clip in this bucket can use: whatever sits in the
 * bucket's own `audio` or `images` folder, plus any loose in the bucket.
 * Pulled audio lands in `audio`, so a track pulled from one clip can go
 * straight under another.
 */
app.get('/api/bucket/:id/media', wrap(async (req, res) => {
  const bucket = bucketOf(req.params.id)
  const kind = mediaKinds[req.query.kind]
  if (!kind) throw httpError(400, 'Ask for audio or image')
  const found = []
  for (const sub of [kind.folder, '']) {
    const rel = sub ? bucket.name + '/' + sub : bucket.name
    let entries = []
    try {
      entries = await fsp.readdir(resolveInSource(rel), { withFileTypes: true })
    } catch { continue }
    for (const e of entries) {
      if (!e.isFile() || !kind.ext.has(path.extname(e.name).toLowerCase())) continue
      found.push({ id: encodeId(rel + '/' + e.name), name: e.name, folder: sub || null })
    }
  }
  found.sort((a, b) => byName(a.name, b.name))
  res.json({ files: found })
}))

/**
 * Copies a file from the computer into the bucket's `audio` or `images`
 * folder, so the edit can use it and it stays with the clips that use it.
 * The body is the raw file, streamed straight to disk.
 */
app.post('/api/bucket/:id/upload', wrap(async (req, res) => {
  const bucket = bucketOf(req.params.id)
  const kind = mediaKinds[req.query.kind]
  if (!kind) throw httpError(400, 'Upload audio or an image')
  const name = path.basename(String(req.query.name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  if (!name || !kind.ext.has(path.extname(name).toLowerCase())) {
    throw httpError(400, `That is not a ${req.query.kind === 'audio' ? 'sound' : 'picture'} file this app can use`)
  }
  const dir = resolveInSource(bucket.name + '/' + kind.folder)
  await fsp.mkdir(dir, { recursive: true })
  const target = await reservePath(path.join(dir, name))
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(target)
      req.pipe(out)
      req.on('error', reject)
      req.on('aborted', () => reject(new Error('Upload cut off')))
      out.on('error', reject)
      out.on('finish', resolve)
    })
  } catch (err) {
    await fsp.rm(target, { force: true })
    throw httpError(500, 'Could not save that file: ' + err.message)
  }
  const saved = path.basename(target)
  res.json({ id: encodeId(bucket.name + '/' + kind.folder + '/' + saved), name: saved, folder: kind.folder })
}))

/* ---------------------------------------------------------------- subtitles */

const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000))
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}

/** Every line of one text subtitle track, as { a, b, text } in source time. */
async function readCues (file, index) {
  const { code, stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:${index}`, '-f', 'srt', '-'])
  if (code !== 0) return []
  const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
  const cues = []
  for (const block of stdout.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(lines[at])
    const text = lines.slice(at + 1).join('\n').trim()
    if (m && text) cues.push({ a: toSec(m[1], m[2], m[3], m[4]), b: toSec(m[5], m[6], m[7], m[8]), text })
  }
  return cues
}

/** The text subtitle tracks of a file, read once per export. */
async function loadSubtitles (meta, file) {
  const tracks = []
  for (const s of (meta.subtitles || []).filter((x) => x.text).slice(0, 8)) {
    const cues = await readCues(file, s.index)
    if (cues.length) tracks.push({ lang: s.lang, cues })
  }
  return tracks
}

/** Width and height from a PNG's header, or null if it is not a PNG. */
function pngSize (buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const pieceLength = (p) => (p.kind === 'image' ? p.length : p.end - p.start)

/**
 * Writes each track retimed to an edit: lines inside the kept pieces move to
 * where those pieces land in the output, lines in cut-out stretches vanish, and
 * a line spanning a cut is clipped to it. Image pieces just take up time. The
 * output seek of a fast cut does not apply to these inputs, so every edit
 * times them from zero.
 */
async function writeSubtitles (tracks, pieces) {
  const out = []
  for (const track of tracks) {
    const lines = []
    let offset = 0
    for (const piece of pieces) {
      if (piece.kind !== 'image') {
        for (const c of track.cues) {
          const a = Math.max(c.a, piece.start)
          const b = Math.min(c.b, piece.end)
          if (b - a > 0.04) lines.push({ a: a - piece.start + offset, b: b - piece.start + offset, text: c.text })
        }
      }
      offset += pieceLength(piece)
    }
    if (!lines.length) continue
    lines.sort((x, y) => x.a - y.a)
    const file = path.join(os.tmpdir(), `videosplitter-${process.pid}-${crypto.randomUUID()}.srt`)
    await fsp.writeFile(file, lines.map((l, i) => `${i + 1}\n${srtTime(l.a)} --> ${srtTime(l.b)}\n${l.text}\n`).join('\n'))
    out.push({ file, lang: track.lang })
  }
  return out
}

/** Adds subtitle files as inputs after `first` existing ones, mapped into mp4. */
function subtitleArgs (subs, first) {
  const inputs = []
  const outputs = []
  subs.forEach((s, j) => {
    inputs.push('-i', s.file)
    outputs.push('-map', `${first + j}:0`)
    if (s.lang) outputs.push(`-metadata:s:s:${j}`, `language=${s.lang}`)
  })
  if (subs.length) outputs.push('-c:s', 'mov_text')
  return { inputs, outputs }
}

/** The last keyframe at or before `t`, so a stream copy can start on it. */
async function keyframeAtOrBefore (file, t) {
  for (const from of [Math.max(0, t - 30), 0]) {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
      '-read_intervals', `${from}%${t + 0.05}`, '-show_entries', 'frame=pts_time,best_effort_timestamp_time',
      '-of', 'csv=p=0', file])
    const times = stdout.split(/\r?\n/)
      .map((l) => l.split(',').map(Number).find((n) => Number.isFinite(n)))
      .filter((n) => Number.isFinite(n) && n <= t + 0.001)
    if (times.length) return Math.max(...times)
    if (from === 0) break
  }
  return 0
}

/* ------------------------------------------------------- the look of the frame */

// Output shapes offered by the canvas tool, as width over height.
const ASPECTS = { '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9, '3:4': 3 / 4 }
const even = (n) => Math.max(2, Math.round(n / 2) * 2)

/** A crop as fractions of the frame, or null when it would crop nothing. */
function cleanCrop (crop) {
  if (!crop || typeof crop !== 'object') return null
  const n = (v) => Math.min(Math.max(Number(v) || 0, 0), 1)
  const x = n(crop.x)
  const y = n(crop.y)
  const w = Math.min(n(crop.w), 1 - x)
  const h = Math.min(n(crop.h), 1 - y)
  if (w < 0.05 || h < 0.05) throw httpError(400, 'That crop is too small')
  if (x < 0.002 && y < 0.002 && w > 0.996 && h > 0.996) return null
  return { x, y, w, h }
}

/**
 * Size of the finished frame. The video keeps its own pixels (cropped, if
 * cropped); a canvas shape adds room around it rather than shrinking it, and
 * the long side is capped at 1920 so a landscape clip on a 9:16 canvas does
 * not become a 3,400 pixel tall file.
 */
function frameSize (meta, crop, canvas, cap = 1920) {
  const vw = meta.width * (crop ? crop.w : 1)
  const vh = meta.height * (crop ? crop.h : 1)
  const A = ASPECTS[canvas]
  let W = vw
  let H = vh
  if (A && vw / vh > A + 0.01) H = vw / A
  else if (A && vw / vh < A - 0.01) W = vh * A
  const scale = Math.min(1, cap / Math.max(W, H))
  return { W: even(W * scale), H: even(H * scale), padded: Boolean(A) && Math.abs(vw / vh - A) > 0.01 }
}

/**
 * Filter text that turns one input picture into a W x H frame: letterboxed on
 * black, or on a blurred, zoomed copy of itself the way phone apps fill a
 * vertical frame. The blur is done at a twelfth of the size, which looks the
 * same and costs almost nothing.
 */
function fitInto (input, output, W, H, background, tag) {
  const fg = `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
  if (background === 'blur') {
    const sw = even(W / 12)
    const sh = even(H / 12)
    return `${input}split=2[f${tag}][b${tag}];` +
      `[b${tag}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${sw}:${sh},gblur=sigma=3,scale=${W}:${H},setsar=1[bb${tag}];` +
      `[f${tag}]${fg}[ff${tag}];[bb${tag}][ff${tag}]overlay=(W-w)/2:(H-h)/2${output}`
  }
  return `${input}${fg},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black${output}`
}

const AFMT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'

// Transitions offered by the editor, as FFmpeg's xfade names them.
const TRANSITIONS = { fade: 'fade', black: 'fadeblack', white: 'fadewhite', slide: 'slideleft', wipe: 'wipeleft', zoom: 'zoomin', circle: 'circleopen', blur: 'hblur' }

// Encoder settings per quality, and the longest side each allows.
const QUALITY = {
  high: { crf: '18', preset: 'medium', audio: '256k', cap: 1920 },
  standard: { crf: '20', preset: 'veryfast', audio: '192k', cap: 1920 },
  small: { crf: '27', preset: 'veryfast', audio: '128k', cap: 1280 }
}

/**
 * Runs FFmpeg for an export, reporting how far it has got and letting the
 * export be stopped. Without a job it is the plain runner.
 */
function runTracked (args, job, outLen) {
  if (!job) return run('ffmpeg', args)
  return new Promise((resolve) => {
    if (job.cancelled) { resolve({ code: -2, stdout: '', stderr: 'stopped' }); return }
    const child = spawn('ffmpeg', ['-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true })
    job.child = child
    let stderr = ''
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = /^out_time_us=(\d+)/.exec(buf.slice(0, i).trim())
        buf = buf.slice(i + 1)
        if (m) job.done = job.base + Math.min(outLen, Number(m[1]) / 1e6)
      }
    })
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000) })
    child.on('error', (err) => { job.child = null; resolve({ code: -1, stdout: '', stderr: err.message }) })
    child.on('close', (code) => { job.child = null; resolve({ code, stdout: '', stderr }) })
  })
}

/**
 * Renders pieces into one file, re-encoded. Used for the finished video (all
 * pieces) and for each separate part (one piece each), so both get the same
 * crop, canvas, soundtrack, text, transitions and fades.
 *
 * Video pieces are seeked inputs of their clip; picture pieces are a still
 * looped for their length. Every piece is brought to the same size, rate and
 * sound format. Runs of pieces with plain cuts are joined with concat; where a
 * transition is asked for, the two sides overlap with xfade. The overlap uses
 * a little footage from just beyond each cut, half a transition each side, so
 * the edit keeps exactly its length and everything timed to it (song, text,
 * captions) stays where it was put.
 */
async function render ({ main, pieces, target, withOriginal, music, crop, canvas, background, at, tracks, temps, overlays, overlayBlank, quality, gif, fades, job }) {
  const meta = main.meta
  const Q = QUALITY[quality] || QUALITY.standard
  const { W, H, padded } = frameSize(meta, crop, canvas, Q.cap)
  const fps = meta.fps.toFixed(3)
  const total = pieces.reduce((s, p) => s + pieceLength(p), 0)
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  const graph = []

  // How much each cut's transition borrows from either side.
  const room = (p, side) => {
    if (p.kind === 'image') return Infinity
    return side === 'after' ? Math.max(0, p.meta.duration - p.end) : Math.max(0, p.start)
  }
  const ext = pieces.map(() => ({ before: 0, after: 0 }))
  const joins = pieces.map((p, k) => {
    if (k === 0 || !p.transition || !TRANSITIONS[p.transition.type]) return null
    // Half from each side if both have footage to spare; if one side has
    // none (a clip's very first frame, say), the other covers it all. Any
    // split keeps the edit's length, since the overlap equals what was added.
    const d = Math.min(Number(p.transition.d) || 0, 4, pieceLength(pieces[k - 1]) / 2 + pieceLength(p) / 2)
    const roomA = Math.min(room(pieces[k - 1], 'after'), pieceLength(pieces[k - 1]) / 2)
    const roomB = Math.min(room(p, 'before'), pieceLength(p) / 2)
    let eB = Math.min(d / 2, roomB)
    const eA = Math.min(d - eB, roomA)
    eB = Math.min(d - eA, roomB)
    if (!(eA + eB >= 0.08)) return null
    ext[k - 1].after = eA
    ext[k].before = eB
    return { type: TRANSITIONS[p.transition.type], d: eA + eB }
  })

  pieces.forEach((p, i) => {
    const len = pieceLength(p) + ext[i].before + ext[i].after
    const own = p.file === main.file
    if (p.kind === 'image') {
      args.push('-loop', '1', '-framerate', fps, '-t', String(len), '-i', p.file)
      graph.push(fitInto(`[${i}:v:0]`, `[s${i}]`, W, H, background, i))
    } else {
      args.push('-ss', String(p.start - ext[i].before), '-t', String(len), '-i', p.file)
      // The crop belongs to the clip it was drawn on; other clips are fitted.
      const cropText = crop && own
        ? `crop=${even(crop.w * meta.width)}:${even(crop.h * meta.height)}:${Math.round(crop.x * meta.width)}:${Math.round(crop.y * meta.height)},`
        : ''
      const fills = !own ? Math.abs(p.meta.width / p.meta.height - W / H) > 0.01 : padded
      if (!fills) graph.push(`[${i}:v:0]${cropText}scale=${W}:${H},setsar=1[s${i}]`)
      else graph.push(fitInto(`[${i}:v:0]${cropText}`, `[s${i}]`, W, H, background, i))
    }
    graph.push(`[s${i}]fps=${fps},format=yuv420p,trim=duration=${len},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`)
    if (withOriginal) {
      graph.push(p.kind === 'image' || !p.meta.hasAudio
        ? `anullsrc=r=48000:cl=stereo,atrim=duration=${len}[a${i}]`
        : `[${i}:a:0]${AFMT},apad,atrim=duration=${len},asetpts=PTS-STARTPTS[a${i}]`)
    }
  })

  // Runs of plain cuts, each joined with concat; then transitions between runs.
  const runs = [[0]]
  for (let k = 1; k < pieces.length; k++) {
    if (joins[k]) runs.push([k])
    else runs[runs.length - 1].push(k)
  }
  const lenOf = (i) => pieceLength(pieces[i]) + ext[i].before + ext[i].after
  let v = null
  let a = null
  let have = 0
  runs.forEach((ids, r) => {
    let rv = `[v${ids[0]}]`
    let ra = withOriginal ? `[a${ids[0]}]` : null
    if (ids.length > 1) {
      const pairs = ids.map((i) => (withOriginal ? `[v${i}][a${i}]` : `[v${i}]`)).join('')
      graph.push(`${pairs}concat=n=${ids.length}:v=1:a=${withOriginal ? 1 : 0}[rv${r}]${withOriginal ? `[ra${r}]` : ''}`)
      rv = `[rv${r}]`
      ra = withOriginal ? `[ra${r}]` : null
    }
    const runLen = ids.reduce((s, i) => s + lenOf(i), 0)
    if (!v) {
      v = rv; a = ra; have = runLen
      return
    }
    const j = joins[ids[0]]
    const d = j.d
    graph.push(`${v}${rv}xfade=transition=${j.type}:duration=${d.toFixed(4)}:offset=${(have - d).toFixed(4)}[x${r}]`)
    v = `[x${r}]`
    if (withOriginal) {
      graph.push(`${a}${ra}acrossfade=d=${d.toFixed(4)}:c1=tri:c2=tri[xa${r}]`)
      a = `[xa${r}]`
    }
    have += runLen - d
  })
  graph.push(`${v}null[vout]`)
  if (withOriginal) graph.push(`${a}anull[base]`)

  let audioOut = withOriginal ? '[base]' : null
  let next = pieces.length
  if (music && !gif) {
    // The song's own time at the first moment of this render. Negative means
    // the song has not started yet, so it waits.
    const songAt = at + music.offset
    if (songAt > 0) args.push('-ss', String(songAt))
    args.push('-i', music.file)
    const wait = songAt < 0 ? `,adelay=${Math.round(-songAt * 1000)}:all=1` : ''
    graph.push(`[${next}:a:0]${AFMT},volume=${music.volume}${wait},apad,atrim=duration=${total},asetpts=PTS-STARTPTS[song]`)
    next += 1
    if (withOriginal) {
      graph.push('[base][song]amix=inputs=2:duration=first:normalize=0[mixed]')
      audioOut = '[mixed]'
    } else {
      audioOut = '[song]'
    }
  }

  // Text and captions, drawn by the editor as transparent full-frame pictures
  // so the export matches the preview exactly. Each lane is a slideshow of
  // non-overlapping pictures with transparent gaps, laid over the video; one
  // lane holds every caption, however many there are.
  let videoOut = '[vout]'
  if (overlays && overlays.length) {
    const lanes = []
    for (const o of overlays) {
      const lane = lanes.find((l) => l.end <= o.a + 0.001)
      if (lane) { lane.items.push(o); lane.end = o.b } else lanes.push({ end: o.b, items: [o] })
    }
    if (lanes.length > 8) throw httpError(400, 'Too many texts on screen at the same moment; keep it to 8')
    const q = (f) => `file '${f.replace(/\\/g, '/')}'`
    lanes.forEach((lane, j) => {
      const lines = ['ffconcat version 1.0']
      let cursor = 0
      for (const o of lane.items) {
        if (o.a > cursor + 0.001) lines.push(q(overlayBlank.file), `duration ${(o.a - cursor).toFixed(4)}`)
        lines.push(q(o.file), `duration ${(o.b - o.a).toFixed(4)}`)
        cursor = o.b
      }
      lines.push(q(overlayBlank.file), `duration ${Math.max(0.05, total - cursor + 0.05).toFixed(4)}`)
      // The last entry's duration is ignored by the concat reader, so the
      // blank is listed once more to close the lane.
      lines.push(q(overlayBlank.file))
      const list = path.join(os.tmpdir(), `videosplitter-${process.pid}-${crypto.randomUUID()}.txt`)
      fs.writeFileSync(list, lines.join('\n'))
      temps.push(list)
      args.push('-f', 'concat', '-safe', '0', '-i', list)
      graph.push(`[${next}:v]fps=${fps},scale=${W}:${H},format=rgba,setpts=PTS-STARTPTS[L${j}]`)
      graph.push(`${videoOut}[L${j}]overlay=0:0:eof_action=pass[o${j}]`)
      videoOut = `[o${j}]`
      next += 1
    })
  }

  // Fading in from black and out to black, picture and sound together.
  const fin = Math.min(Number(fades?.in) || 0, total / 2)
  const fout = Math.min(Number(fades?.out) || 0, total / 2)
  if (fin > 0 || fout > 0) {
    const vf = [fin > 0 ? `fade=t=in:st=0:d=${fin}` : null, fout > 0 ? `fade=t=out:st=${(total - fout).toFixed(4)}:d=${fout}` : null].filter(Boolean).join(',')
    graph.push(`${videoOut}${vf}[faded]`)
    videoOut = '[faded]'
    if (audioOut) {
      const af = [fin > 0 ? `afade=t=in:st=0:d=${fin}` : null, fout > 0 ? `afade=t=out:st=${(total - fout).toFixed(4)}:d=${fout}` : null].filter(Boolean).join(',')
      graph.push(`${audioOut}${af}[afaded]`)
      audioOut = '[afaded]'
    }
  }

  if (gif) {
    // A small looping picture: fewer frames, fewer colours, one palette made
    // for this clip so it still looks right.
    const gw = Math.min(480, W)
    graph.push(`${videoOut}fps=12,scale=${gw}:-2:flags=lanczos,split[g1][g2];[g1]palettegen=stats_mode=diff[pal];[g2][pal]paletteuse=dither=bayer:bayer_scale=4[gif]`)
    args.push('-filter_complex', graph.join(';'), '-map', '[gif]', '-loop', '0', target)
    const result = await runTracked(args, job, total)
    return { ...result, subtitles: 0, width: gw, height: 0 }
  }

  const subs = await writeSubtitles(tracks, pieces.map((p) => (p.file === main.file ? p : { kind: 'image', length: pieceLength(p) })))
  temps.push(...subs.map((s) => s.file))
  const sub = subtitleArgs(subs, next)
  args.push(...sub.inputs, '-filter_complex', graph.join(';'), '-map', videoOut)
  if (audioOut) args.push('-map', audioOut, '-c:a', 'aac', '-b:a', Q.audio)
  args.push(...sub.outputs, '-c:v', 'libx264', '-preset', Q.preset, '-crf', Q.crf, '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', target)
  const result = await runTracked(args, job, total)
  return { ...result, subtitles: subs.length, width: W, height: H }
}

/** Captions as a subtitle file, for players and sites that take one. */
async function writeSrt (target, captions, at, len) {
  const lines = captions
    .filter((c) => c.end > at + 0.01 && c.start < at + len - 0.01)
    .map((c) => ({ a: Math.max(0, c.start - at), b: Math.min(len, c.end - at), text: String(c.text || '').trim() }))
    .filter((c) => c.text)
  if (!lines.length) return null
  const file = await reservePath(target.replace(/\.(mp4|gif)$/i, '') + '.srt')
  await fsp.writeFile(file, lines.map((l, i) => `${i + 1}\n${srtTime(l.a)} --> ${srtTime(l.b)}\n${l.text}\n`).join('\n'))
  return path.basename(file)
}

/**
 * The whole export, from a request body to finished files. With a job it
 * reports progress as it goes and can be stopped part way.
 */
async function doExport (body, job) {
  if (!(await haveTools())) throw httpError(503, 'FFmpeg is not installed or not on PATH')
  const file = resolveInSource(decodeId(String(body.id)))
  if (!fs.existsSync(file)) throw httpError(404, 'That video is no longer there')

  const stripAudio = Boolean(body.stripAudio)
  const segments = Array.isArray(body.segments) ? body.segments : []
  if (segments.length === 0) throw httpError(400, 'Nothing to export. Keep at least one segment.')
  if (segments.length > 100) throw httpError(400, 'Too many pieces; keep it under 100')

  const meta = await probe(file)
  if (!meta.hasVideo) throw httpError(400, 'That file has no picture to cut')
  const main = { file, meta }
  const metas = new Map([[file, meta]])

  const clean = []
  for (const seg of segments) {
    const transition = seg && seg.transition && TRANSITIONS[seg.transition.type]
      ? { type: seg.transition.type, d: Math.min(Math.max(Number(seg.transition.d) || 0.5, 0.1), 4) }
      : null
    if (seg && seg.kind === 'image') {
      const img = resolveInSource(decodeId(String(seg.image)))
      if (!IMAGE_EXT.has(path.extname(img).toLowerCase()) || !fs.existsSync(img)) throw httpError(404, 'A picture in the edit is no longer there')
      const length = Number(seg.length)
      if (!(length >= 0.1 && length <= 600)) throw httpError(400, 'A picture has to show for between 0.1 and 600 seconds')
      clean.push({ kind: 'image', file: img, length, transition })
      continue
    }
    // A piece can come from another clip in the library.
    let pfile = file
    if (seg && seg.src && seg.src !== body.id) {
      pfile = resolveInSource(decodeId(String(seg.src)))
      if (!VIDEO_EXT.has(path.extname(pfile).toLowerCase()) || !fs.existsSync(pfile)) throw httpError(404, 'A clip in the edit is no longer there')
    }
    if (!metas.has(pfile)) {
      const m = await probe(pfile)
      if (!m.hasVideo) throw httpError(400, 'A clip in the edit has no picture')
      metas.set(pfile, m)
    }
    const pm = metas.get(pfile)
    const start = Math.max(0, Number(seg.start) || 0)
    const end = Math.min(pm.duration || Number(seg.end), Number(seg.end))
    if (!(end > start)) throw httpError(400, 'A segment ends before it starts')
    if (end - start < 0.05) throw httpError(400, 'A segment is too short to export')
    clean.push({ kind: 'video', file: pfile, meta: pm, start, end, transition })
  }

  let music = null
  if (body.music && body.music.id) {
    const mfile = resolveInSource(decodeId(String(body.music.id)))
    if (!fs.existsSync(mfile)) throw httpError(404, 'The added sound file is no longer there')
    const volume = Math.min(Math.max(Number(body.music.volume ?? 1), 0), 2)
    music = { file: mfile, offset: Number(body.music.offset) || 0, volume }
  }
  const look = body.look || {}
  const crop = cleanCrop(look.crop)
  const canvas = ASPECTS[look.canvas] ? look.canvas : 'original'
  const background = look.background === 'black' ? 'black' : 'blur'
  const fades = { in: Math.min(Math.max(Number(look.fadeIn) || 0, 0), 5), out: Math.min(Math.max(Number(look.fadeOut) || 0, 0), 5) }
  const quality = QUALITY[body.quality] ? body.quality : 'standard'
  const gif = body.format === 'gif'
  const texts = Array.isArray(body.overlays) ? body.overlays : []
  const captions = Array.isArray(body.captions) ? body.captions : []
  if (texts.length > 30000) throw httpError(400, 'Too much text animation in one export')
  const totalLen = clean.reduce((t, p) => t + pieceLength(p), 0)
  if (gif && !body.join) throw httpError(400, 'A GIF is always one file; choose One video')
  if (gif && totalLen > 60) throw httpError(400, 'A GIF of more than a minute would be enormous; keep it under 60 seconds')

  const plain = !music && !crop && canvas === 'original' && !texts.length && !fades.in && !fades.out && quality === 'standard' &&
    clean.every((p) => p.kind === 'video' && p.file === file)
  const fast = body.mode === 'fast' && !body.join && plain

  const outDir = path.join(path.dirname(file), 'edits')
  await fsp.mkdir(outDir, { recursive: true })
  const stem = path.basename(file, path.extname(file))
  const withOriginal = !gif && clean.some((p) => p.kind === 'video' && p.meta.hasAudio) && !stripAudio
  const tracks = gif ? [] : await loadSubtitles(meta, file)
  const temps = []
  if (job) { job.total = totalLen; job.base = 0; job.done = 0 }

  const fail = async (target, stderr, extra = '') => {
    // Never leave a half-written file behind looking like a finished one.
    await fsp.rm(target, { force: true })
    if (job && job.cancelled) throw httpError(499, 'Export stopped.' + extra)
    throw httpError(500, 'FFmpeg failed: ' + (stderr.trim().split('\n').pop() || 'unknown error') + extra)
  }
  const sizeOf = async (f) => {
    try { return (await fsp.stat(f)).size } catch { return 0 }
  }

  try {
    // Text pictures go to temporary files once; each part takes its own slice.
    const overlays = []
    let overlayBlank = null
    if (job) job.stage = 'Preparing text'
    for (const o of texts) {
      const m = /^data:image\/png;base64,(.+)$/.exec(String(o && o.png))
      const a = Number(o && o.start)
      const b = Number(o && o.end)
      if (!m || !(b > a) || a < 0) throw httpError(400, 'A text in the edit could not be read')
      const buf = Buffer.from(m[1], 'base64')
      const size = pngSize(buf)
      if (!size) throw httpError(400, 'A text in the edit could not be read')
      if (overlayBlank && (size.w !== overlayBlank.w || size.h !== overlayBlank.h)) throw httpError(400, 'Texts were drawn at different sizes')
      if (!overlayBlank) overlayBlank = { ...size }
      const f = path.join(os.tmpdir(), `videosplitter-${process.pid}-${crypto.randomUUID()}.png`)
      temps.push(f)
      await fsp.writeFile(f, buf)
      overlays.push({ a, b, file: f })
    }
    overlays.sort((x, y) => x.a - y.a)
    if (overlayBlank) {
      overlayBlank.file = path.join(os.tmpdir(), `videosplitter-${process.pid}-${crypto.randomUUID()}.png`)
      temps.push(overlayBlank.file)
      const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', `color=c=black@0:s=${overlayBlank.w}x${overlayBlank.h},format=rgba`, '-frames:v', '1', overlayBlank.file])
      if (r.code !== 0) throw httpError(500, 'Could not prepare the text layer')
    }
    const slice = (at, len) => overlays
      .filter((o) => o.b > at + 0.01 && o.a < at + len - 0.01)
      .map((o) => ({ a: Math.max(0, o.a - at), b: Math.min(len, o.b - at), file: o.file }))

    const common = { main, withOriginal, music, crop, canvas, background, tracks, temps, overlayBlank, quality, gif, fades, job }
    if (job) job.stage = 'Exporting'

    // One finished video: every piece, in order, gaps closed. Always
    // re-encoded, since joining stream-copied pieces glitches at every cut.
    if (body.join) {
      const target = await reservePath(path.join(outDir, stem + (gif ? ' edit.gif' : ' edit.mp4')))
      const r = await render({ ...common, pieces: clean, target, at: 0, overlays: slice(0, totalLen) })
      if (r.code !== 0) await fail(target, r.stderr)
      const written = [{ name: path.basename(target), size: await sizeOf(target) }]
      const srt = body.srt && !gif ? await writeSrt(target, captions, 0, totalLen) : null
      if (srt) written.push({ name: srt, size: await sizeOf(path.join(outDir, srt)), subtitleFile: true })
      return { written, dir: outDir, joined: true, subtitles: r.subtitles, size: { width: r.width, height: r.height } }
    }

    const written = []
    let at = 0
    let subtitles = 0
    for (let i = 0; i < clean.length; i++) {
      const piece = { ...clean[i], transition: null }
      const len = pieceLength(piece)
      const label = clean.length > 1 ? ' part ' + (i + 1) : ' cut'
      const target = await reservePath(path.join(outDir, stem + label + '.mp4'))
      const finished = written.length ? ` Finished parts kept: ${written.map((w) => w.name).join(', ')}.` : ''
      const entry = { name: '', size: 0 }
      if (job) job.base = at

      if (fast) {
        // A stream copy can only begin on a keyframe. It used to seek on the
        // input, which kept the footage back to the previous keyframe hidden
        // inside the file behind an edit list: most players skipped it, some
        // showed it, and a 2 second cut could weigh 6 seconds. Now the cut
        // starts openly on that keyframe, the output seek drops everything
        // before it, and the reply says where it really starts.
        const from = await keyframeAtOrBefore(file, piece.start)
        const seekIn = Math.max(0, from - 0.5)
        const subs = await writeSubtitles(tracks, [{ kind: 'video', start: from, end: piece.end }])
        temps.push(...subs.map((s) => s.file))
        subtitles = Math.max(subtitles, subs.length)
        const sub = subtitleArgs(subs, 1)
        const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(seekIn), '-i', file, ...sub.inputs,
          '-ss', String(from - seekIn), '-t', String(piece.end - from), '-map', '0:v:0']
        if (withOriginal) args.push('-map', '0:a:0')
        args.push(...sub.outputs, '-c:v', 'copy', '-c:a', 'copy')
        if (subs.length) args.push('-c:s', 'mov_text')
        args.push('-movflags', '+faststart', target)
        const r = await runTracked(args, job, len)
        if (r.code !== 0) await fail(target, r.stderr, finished)
        Object.assign(entry, { asked: piece.start, startedAt: Math.round(from * 1000) / 1000 })
      } else {
        const r = await render({ ...common, pieces: [piece], target, at, overlays: slice(at, len) })
        if (r.code !== 0) await fail(target, r.stderr, finished)
        subtitles = Math.max(subtitles, r.subtitles)
      }
      entry.name = path.basename(target)
      entry.size = await sizeOf(target)
      written.push(entry)
      if (body.srt) {
        const srt = await writeSrt(target, captions, at, len)
        if (srt) written.push({ name: srt, size: await sizeOf(path.join(outDir, srt)), subtitleFile: true })
      }
      at += len
    }
    return { written, dir: outDir, subtitles }
  } finally {
    await Promise.all(temps.map((f) => fsp.rm(f, { force: true })))
  }
}

app.post('/api/export', wrap(async (req, res) => {
  const body = req.body || {}
  if (!body.async) {
    res.json(await doExport(body, null))
    return
  }
  // Long exports run in the background; the editor asks how far along they are.
  const id = crypto.randomUUID()
  const job = { id, state: 'running', stage: 'Starting', base: 0, done: 0, total: 0, startedAt: Date.now() }
  exportJobs.set(id, job)
  doExport(body, job)
    .then((result) => { job.state = 'done'; job.result = result })
    .catch((err) => { job.state = job.cancelled ? 'stopped' : 'error'; job.error = err.message })
    .finally(() => { setTimeout(() => exportJobs.delete(id), 10 * 60 * 1000) })
  res.json({ job: id })
}))

const exportJobs = new Map()

app.get('/api/export/job/:id', wrap(async (req, res) => {
  const job = exportJobs.get(req.params.id)
  if (!job) throw httpError(404, 'That export is no longer known')
  res.json({
    state: job.state,
    stage: job.stage,
    progress: job.total ? Math.min(1, job.done / job.total) : 0,
    result: job.result || null,
    error: job.error || null
  })
}))

app.post('/api/export/job/:id/stop', wrap(async (req, res) => {
  const job = exportJobs.get(req.params.id)
  if (!job) throw httpError(404, 'That export is no longer known')
  job.cancelled = true
  try { job.child?.kill() } catch { /* already gone */ }
  res.json({ ok: true })
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

  const target = skipIfPresent ? plain : await reservePath(plain)

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-map', '0:a:0']
  if (lossless) args.push('-c:a', 'copy')
  else args.push('-c:a', 'libmp3lame', '-q:a', '2')
  args.push(target)

  const { code, stderr } = await run('ffmpeg', args)
  if (code !== 0) {
    await fsp.rm(target, { force: true })
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

mountCaptions(app, { ROOT, CACHE_DIR, wrap, httpError, resolveInSource, decodeId, probe, haveTools })

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
