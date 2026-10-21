import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Fonts imported from this computer, for text and captions. Kept in `.fonts`
 * next to the app, shared by every clip. The editor draws text itself, so a
 * font the browser has loaded is all the export needs too.
 */
const FONT_EXT = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' }

export function mountFonts (app, { ROOT, wrap, httpError }) {
  const DIR = process.env.VIDEOSPLITTER_FONTS || path.join(ROOT, '.fonts')

  // A readable family name from the file name: "Bangers-Regular.ttf" -> "Bangers Regular".
  const familyOf = (file) => path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()

  async function list () {
    let names = []
    try { names = await fsp.readdir(DIR) } catch { return [] }
    return names.filter((n) => FONT_EXT[path.extname(n).toLowerCase()]).sort().map((file) => ({ file, family: familyOf(file) }))
  }

  app.get('/api/fonts', wrap(async (_req, res) => {
    res.json({ fonts: await list() })
  }))

  app.get('/api/fonts/file/:file', wrap(async (req, res) => {
    const file = path.basename(String(req.params.file))
    const type = FONT_EXT[path.extname(file).toLowerCase()]
    const full = path.join(DIR, file)
    if (!type || !fs.existsSync(full)) throw httpError(404, 'That font is gone')
    res.set('Cache-Control', 'private, max-age=31536000, immutable')
    res.type(type)
    fs.createReadStream(full).pipe(res)
  }))

  app.post('/api/fonts', wrap(async (req, res) => {
    const name = path.basename(String(req.query.name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
    if (!FONT_EXT[path.extname(name).toLowerCase()]) throw httpError(400, 'That is not a font file. Use .ttf, .otf, .woff or .woff2')
    await fsp.mkdir(DIR, { recursive: true })
    const target = path.join(DIR, name)
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > 20 * 1024 * 1024) throw httpError(400, 'That font file is too big')
      chunks.push(c)
    }
    const buf = Buffer.concat(chunks)
    // A font file starts with one of a few known signatures.
    const sig = buf.subarray(0, 4).toString('latin1')
    if (!['\x00\x01\x00\x00', 'OTTO', 'true', 'wOFF', 'wOF2'].includes(sig)) throw httpError(400, 'That file does not look like a font')
    await fsp.writeFile(target, buf)
    res.json({ fonts: await list(), added: { file: name, family: familyOf(name) } })
  }))

  app.delete('/api/fonts/:file', wrap(async (req, res) => {
    await fsp.rm(path.join(DIR, path.basename(String(req.params.file))), { force: true })
    res.json({ fonts: await list() })
  }))
}
