import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Duplicates: the same video already sitting in a bucket, whatever it is
 * called (a "(2)" or "copy" from downloading it twice). Two files are the
 * same video when their contents are identical.
 *
 * Identical files are the same size, so only files of exactly the size of
 * the one being checked are compared at all, and only those are read to
 * fingerprint them. Most checks therefore read nothing. Fingerprints are
 * kept, keyed on path, size and modified time.
 */
export function mountDupes (app, { wrap, httpError, resolveInSource, decodeId, encodeId, getConfig, VIDEO_EXT }) {
  const prints = new Map()

  async function fingerprint (abs, st) {
    const key = abs + '|' + st.size + '|' + st.mtimeMs
    const known = prints.get(key)
    if (known) return known
    const made = new Promise((resolve, reject) => {
      const h = crypto.createHash('sha1')
      fs.createReadStream(abs).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
    })
    prints.set(key, made)
    if (prints.size > 5000) prints.delete(prints.keys().next().value)
    try { return await made } catch (err) { prints.delete(key); throw err }
  }

  /** Every bucket video identical to the file at `abs` (itself excluded). */
  async function find (abs) {
    const st = await fsp.stat(abs)
    const config = getConfig()
    const out = []
    let mine = null
    for (const bucket of config.buckets) {
      const dir = resolveInSource(bucket.name)
      let entries = []
      try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (!e.isFile() || !VIDEO_EXT.has(path.extname(e.name).toLowerCase())) continue
        const other = path.join(dir, e.name)
        if (other === abs) continue
        let ost
        try { ost = await fsp.stat(other) } catch { continue }
        if (ost.size !== st.size) continue
        mine = mine || await fingerprint(abs, st)
        if (await fingerprint(other, ost) === mine) {
          out.push({ bucketId: bucket.id, bucket: bucket.name, name: e.name, id: encodeId(bucket.name + '/' + e.name) })
        }
      }
    }
    return out
  }

  app.get('/api/dupes/:id', wrap(async (req, res) => {
    const abs = resolveInSource(decodeId(req.params.id))
    if (!fs.existsSync(abs)) throw httpError(404, 'That video is no longer there')
    res.json({ matches: await find(abs) })
  }))

  return { find }
}
