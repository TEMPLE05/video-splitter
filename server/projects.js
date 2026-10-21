import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Projects: edits that start from nothing rather than from one clip. A video
 * made of pictures, voice-overs, transitions and captions, say. Each belongs
 * to a bucket, where its exports go, and is kept as a small JSON file in
 * `.edits/projects` beside the app, never in your own folders.
 */
export const SHAPES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] }

export function mountProjects (app, { ROOT, wrap, httpError, getConfig }) {
  const DIR = path.join(process.env.VIDEOSPLITTER_EDITS || path.join(ROOT, '.edits'), 'projects')
  const fileOf = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw httpError(400, 'Not a project')
    return path.join(DIR, id + '.json')
  }

  async function read (id) {
    try { return JSON.parse(await fsp.readFile(fileOf(id), 'utf8')) } catch { throw httpError(404, 'That project is gone') }
  }
  async function write (rec) {
    await fsp.mkdir(DIR, { recursive: true })
    const tmp = fileOf(rec.id) + '.' + process.pid + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(rec))
    await fsp.rename(tmp, fileOf(rec.id))
  }
  const cleanName = (n) => String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

  /** What the library shows for a project: its name, length and a cover. */
  const summary = (rec) => {
    const pieces = rec.edit?.pieces || []
    const first = pieces[0]
    return {
      id: rec.id,
      name: rec.name,
      shape: rec.shape,
      savedAt: rec.savedAt || rec.createdAt,
      length: pieces.reduce((t, p) => t + (p.end - p.start), 0),
      cover: first ? (first.kind === 'image' ? { image: first.image } : { clip: first.src }) : null
    }
  }

  /** Every project, newest first, or only those of one bucket. */
  async function list (bucketId) {
    let names = []
    try { names = await fsp.readdir(DIR) } catch { names = [] }
    const out = []
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      try {
        const rec = JSON.parse(await fsp.readFile(path.join(DIR, n), 'utf8'))
        if (!bucketId || rec.bucketId === bucketId) out.push({ ...summary(rec), bucketId: rec.bucketId, bucketName: rec.bucketName })
      } catch { /* a half-written file; skip it */ }
    }
    out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    return out
  }

  app.get('/api/projects', wrap(async (_req, res) => {
    res.json({ projects: await list() })
  }))

  app.get('/api/bucket/:id/projects', wrap(async (req, res) => {
    res.json({ projects: await list(req.params.id) })
  }))

  app.post('/api/projects', wrap(async (req, res) => {
    const b = req.body || {}
    const bucket = getConfig().buckets.find((x) => x.id === b.bucketId)
    if (!bucket) throw httpError(404, 'Choose a bucket for the project')
    const name = cleanName(b.name)
    if (!name) throw httpError(400, 'Give the project a name')
    const shape = SHAPES[b.shape] ? b.shape : '9:16'
    const [width, height] = SHAPES[shape]
    const now = new Date().toISOString()
    const rec = { id: crypto.randomUUID(), name, bucketId: bucket.id, bucketName: bucket.name, shape, width, height, createdAt: now, savedAt: now, edit: null, extra: {} }
    await write(rec)
    res.json(rec)
  }))

  app.get('/api/projects/:id', wrap(async (req, res) => {
    res.json(await read(req.params.id))
  }))

  app.put('/api/projects/:id', wrap(async (req, res) => {
    const rec = await read(req.params.id)
    const b = req.body || {}
    if (b.edit) {
      if (!Array.isArray(b.edit.pieces)) throw httpError(400, 'Nothing to save')
      rec.edit = b.edit
    }
    if (b.extra) rec.extra = b.extra
    if (b.name !== undefined) {
      const name = cleanName(b.name)
      if (name) rec.name = name
    }
    rec.savedAt = new Date().toISOString()
    await write(rec)
    res.json({ savedAt: rec.savedAt, name: rec.name })
  }))

  app.delete('/api/projects/:id', wrap(async (req, res) => {
    await fsp.rm(fileOf(req.params.id), { force: true })
    res.json({ ok: true })
  }))

  return { read, exists: (id) => fs.existsSync(fileOf(id)) }
}
