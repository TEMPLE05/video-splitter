import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Library housekeeping: sending clips to the Recycle Bin, moving them between
 * buckets, and tidying the non-video files out of the main folder.
 *
 * Nothing here deletes a file outright. Removing a clip hands it to the
 * system's Recycle Bin (or Trash), where it can be restored, and tidying only
 * moves files into one folder, with an undo.
 */

export const OTHER_FILES = 'Other files'

const KINDS = {
  Pictures: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.tif', '.tiff', '.svg']),
  Audio: new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac', '.wma', '.amr']),
  Documents: new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.pps', '.ppsx', '.xls', '.xlsx', '.csv', '.txt', '.rtf', '.odt', '.odp', '.ods', '.epub'])
}
const kindOf = (name) => {
  const ext = path.extname(name).toLowerCase()
  for (const [k, set] of Object.entries(KINDS)) if (set.has(ext)) return k
  return 'Other'
}

/** Hands files to the system's Recycle Bin. Resolves with the ones that went. */
function toRecycleBin (files) {
  // Tests point this at a plain folder, so they never fill the real bin.
  const fake = process.env.VIDEOSPLITTER_TRASH_DIR
  if (fake) {
    return Promise.all(files.map(async (f) => {
      await fsp.mkdir(fake, { recursive: true })
      await fsp.rename(f, path.join(fake, Date.now() + '-' + path.basename(f)))
    })).then(() => undefined)
  }
  let cmd
  let args
  const env = { ...process.env, VS_TRASH: JSON.stringify(files) }
  if (process.platform === 'win32') {
    // The paths travel in an environment variable, never in the command, so
    // no file name can be read as PowerShell.
    cmd = 'powershell.exe'
    args = ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($f in ($env:VS_TRASH | ConvertFrom-Json)) { ' +
      "try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f, 'OnlyErrorDialogs', 'SendToRecycleBin') } catch { } }"]
  } else if (process.platform === 'darwin') {
    cmd = 'osascript'
    args = ['-l', 'JavaScript', '-e',
      'const f = JSON.parse($.NSProcessInfo.processInfo.environment.objectForKey("VS_TRASH").js); ' +
      'const fm = $.NSFileManager.defaultManager; f.forEach(p => fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(p), null, null))']
  } else {
    cmd = 'gio'
    args = ['trash', '--', ...files]
  }
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, windowsHide: true })
    p.on('error', () => reject(new Error('This computer has no Recycle Bin the app can use')))
    p.on('close', () => resolve())
  })
}

export function mountLibrary (app, { wrap, httpError, resolveInSource, decodeId, encodeId, getConfig, saveConfig, reservePath, savedEdits, VIDEO_EXT, isJunk }) {
  /** A clip the request names: a video file inside the source folder. */
  function clipFile (id) {
    const rel = decodeId(String(id))
    const abs = resolveInSource(rel)
    if (!VIDEO_EXT.has(path.extname(abs).toLowerCase())) throw httpError(400, 'Only clips can be removed or moved here')
    if (!fs.existsSync(abs)) return null
    return { rel, abs, name: path.basename(abs) }
  }

  app.post('/api/clips/trash', wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) throw httpError(400, 'Choose some clips first')
    if (ids.length > 500) throw httpError(400, 'Too many at once; do it in batches of 500')
    const clips = ids.map(clipFile)
    const there = clips.filter(Boolean)
    await toRecycleBin(there.map((c) => c.abs))
    const trashed = there.filter((c) => !fs.existsSync(c.abs)).map((c) => c.name)
    const failed = there.filter((c) => fs.existsSync(c.abs)).map((c) => c.name)
    res.json({ trashed, failed, missing: clips.length - there.length })
  }))

  app.post('/api/clips/move', wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) throw httpError(400, 'Choose some clips first')
    const config = getConfig()
    // No bucket means back to the main folder, to be sorted again.
    let destRel = ''
    if (req.body.bucketId) {
      const bucket = config.buckets.find((b) => b.id === req.body.bucketId)
      if (!bucket) throw httpError(404, 'That bucket is gone')
      destRel = bucket.name
    }
    const destDir = resolveInSource(destRel || '.')
    await fsp.mkdir(destDir, { recursive: true })
    const moved = []
    const failed = []
    for (const id of ids) {
      const c = clipFile(id)
      if (!c) continue
      if (path.dirname(c.abs) === destDir) continue
      try {
        // Reserving the name first means a clip never lands on top of another.
        const target = await reservePath(path.join(destDir, c.name))
        await fsp.rm(target, { force: true })
        try {
          await fsp.rename(c.abs, target)
        } catch (err) {
          if (err.code !== 'EXDEV') throw err
          await fsp.copyFile(c.abs, target)
          await fsp.unlink(c.abs)
        }
        await savedEdits.relink(c.abs, target)
        moved.push({ from: c.name, to: path.basename(target), id: encodeId(path.relative(resolveInSource('.'), target).split(path.sep).join('/')) })
      } catch (err) {
        failed.push({ name: c.name, reason: err.message })
      }
    }
    res.json({ moved, failed })
  }))

  /* ------------------------------------------------------------ tidying up */

  async function strays () {
    const config = getConfig()
    if (!config.sourceDir) return []
    let entries = []
    try { entries = await fsp.readdir(config.sourceDir, { withFileTypes: true }) } catch { return [] }
    const out = []
    for (const e of entries) {
      if (!e.isFile() || VIDEO_EXT.has(path.extname(e.name).toLowerCase())) continue
      if (isJunk(e.name) || e.name.startsWith('.') || e.name.startsWith('~$')) continue
      let size = 0
      try { size = (await fsp.stat(path.join(config.sourceDir, e.name))).size } catch { continue }
      out.push({ name: e.name, kind: kindOf(e.name), size })
    }
    return out
  }

  app.get('/api/tidy', wrap(async (_req, res) => {
    const files = await strays()
    const kinds = {}
    for (const f of files) {
      kinds[f.kind] = kinds[f.kind] || { count: 0, size: 0, examples: [] }
      kinds[f.kind].count++
      kinds[f.kind].size += f.size
      if (kinds[f.kind].examples.length < 3) kinds[f.kind].examples.push(f.name)
    }
    res.json({ count: files.length, kinds, folder: OTHER_FILES, canUndo: Boolean(getConfig().lastTidy?.length) })
  }))

  app.post('/api/tidy', wrap(async (_req, res) => {
    const config = getConfig()
    const files = await strays()
    const record = []
    for (const f of files) {
      const from = path.join(config.sourceDir, f.name)
      const dir = path.join(config.sourceDir, OTHER_FILES, f.kind)
      await fsp.mkdir(dir, { recursive: true })
      const to = await reservePath(path.join(dir, f.name))
      await fsp.rm(to, { force: true })
      try {
        await fsp.rename(from, to)
        record.push({ from, to })
      } catch { /* in use or vanished; leave it be */ }
    }
    config.lastTidy = record
    await saveConfig()
    res.json({ moved: record.length, folder: OTHER_FILES, canUndo: record.length > 0 })
  }))

  app.post('/api/tidy/undo', wrap(async (_req, res) => {
    const config = getConfig()
    const record = config.lastTidy || []
    let back = 0
    for (const { from, to } of record) {
      if (!fs.existsSync(to) || fs.existsSync(from)) continue
      try { await fsp.rename(to, from); back++ } catch { /* leave it */ }
    }
    config.lastTidy = []
    await saveConfig()
    res.json({ back })
  }))
}
