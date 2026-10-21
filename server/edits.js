import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Edits saved as you work, so leaving the editor never loses anything.
 *
 * One small JSON file per clip, kept next to the app in `.edits`, never in
 * your own folders (where it would block removing a bucket and get swept
 * along when clips move). Each is found by the clip's full path; a clip that
 * has moved, say to another bucket, is still found by its name and size.
 */
export function mountEdits (app, { ROOT, wrap, httpError, resolveInSource, decodeId }) {
  const DIR = process.env.VIDEOSPLITTER_EDITS || path.join(ROOT, '.edits')
  const INDEX = path.join(DIR, 'index.json')
  let index = null // key -> { path, name, size, savedAt }

  const keyOf = (abs) => crypto.createHash('sha1').update(path.resolve(abs).toLowerCase()).digest('hex')
  const fileOf = (key) => path.join(DIR, key + '.json')

  function load () {
    if (index) return index
    try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')) } catch { index = {} }
    return index
  }

  let writing = Promise.resolve()
  function saveIndex () {
    const snapshot = JSON.stringify(index)
    writing = writing.then(async () => {
      await fsp.mkdir(DIR, { recursive: true })
      const tmp = INDEX + '.' + process.pid + '.tmp'
      await fsp.writeFile(tmp, snapshot)
      await fsp.rename(tmp, INDEX)
    }).catch(() => {})
    return writing
  }

  /** The saved entry for a clip: by its path, or failing that by name and size. */
  function find (abs, size) {
    const idx = load()
    const key = keyOf(abs)
    if (idx[key]) return { key, entry: idx[key], moved: false }
    const name = path.basename(abs).toLowerCase()
    for (const [k, e] of Object.entries(idx)) {
      if (e.name.toLowerCase() === name && e.size === size && !fs.existsSync(e.path)) return { key: k, entry: e, moved: true }
    }
    return null
  }

  async function clipOf (id) {
    const abs = resolveInSource(decodeId(String(id)))
    try {
      return { abs, size: (await fsp.stat(abs)).size }
    } catch {
      throw httpError(404, 'That video is no longer there')
    }
  }

  app.get('/api/edit/:id', wrap(async (req, res) => {
    const { abs, size } = await clipOf(req.params.id)
    const hit = find(abs, size)
    if (!hit) { res.json({ none: true }); return }
    let saved
    try { saved = JSON.parse(await fsp.readFile(fileOf(hit.key), 'utf8')) } catch { res.json({ none: true }); return }
    // A clip found by name after a move takes its saved edit with it.
    if (hit.moved) await relink(hit.entry.path, abs)
    res.json({ ...saved, moved: hit.moved, sizeChanged: saved.size !== size })
  }))

  app.put('/api/edit/:id', wrap(async (req, res) => {
    const { abs, size } = await clipOf(req.params.id)
    const body = req.body || {}
    if (!body.edit || !Array.isArray(body.edit.pieces)) throw httpError(400, 'Nothing to save')
    const key = keyOf(abs)
    const savedAt = new Date().toISOString()
    const record = { path: abs, name: path.basename(abs), size, savedAt, edit: body.edit, extra: body.extra || {} }
    await fsp.mkdir(DIR, { recursive: true })
    const tmp = fileOf(key) + '.' + process.pid + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(record))
    await fsp.rename(tmp, fileOf(key))
    load()[key] = { path: abs, name: record.name, size, savedAt }
    await saveIndex()
    res.json({ savedAt })
  }))

  app.delete('/api/edit/:id', wrap(async (req, res) => {
    const { abs } = await clipOf(req.params.id)
    await forget(abs)
    res.json({ ok: true })
  }))

  async function forget (abs) {
    const key = keyOf(abs)
    await fsp.rm(fileOf(key), { force: true })
    if (load()[key]) { delete index[key]; await saveIndex() }
  }

  /** Follows a clip to its new place, so its edit goes with it. */
  async function relink (from, to) {
    const idx = load()
    const a = keyOf(from)
    const b = keyOf(to)
    if (!idx[a] || a === b) return
    try { await fsp.rename(fileOf(a), fileOf(b)) } catch { return }
    idx[b] = { ...idx[a], path: to, name: path.basename(to) }
    delete idx[a]
    await saveIndex()
  }

  return {
    has: (abs) => Boolean(load()[keyOf(abs)]),
    relink,
    forget
  }
}
