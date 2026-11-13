#!/usr/bin/env node
/**
 * Video Splitter as MCP tools, so Claude Code (or any MCP client) can sort,
 * cut, caption and export clips by asking, while the app is running.
 *
 * This is a thin layer over the app's own HTTP API: every tool here does
 * what a click in the app does, through the same routes, so whatever Claude
 * changes shows up in the editor and the library straight away. It never
 * touches the video files itself.
 *
 * It talks to the app at VIDEOSPLITTER_URL (http://127.0.0.1:5174 unless
 * set) over stdio, which is how Claude Code starts it: see .mcp.json.
 * Nothing here may write to stdout, which carries the protocol.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import { TRANSITIONS, initial, isImage, newId, speedsOf, speedFields, total } from '../src/editor/model.js'
import { CAPTION_LOOK, FONTS, IN_ANIMS, LOOP_ANIMS, OUT_ANIMS, STYLES, captionChunks } from '../src/editor/text.js'

const BASE = (process.env.VIDEOSPLITTER_URL || 'http://127.0.0.1:5174').replace(/\/+$/, '')
const CHARACTER_LIMIT = 25000
const VERSION = '1.0.0'

/* ------------------------------------------------------------- the app */

/** Calls the app's API; errors say what went wrong and what to do about it. */
async function api (route, { method = 'GET', body, signal, timeout = 60000 } = {}) {
  let res
  try {
    res = await fetch(BASE + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
    })
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled')
    throw new Error(`Video Splitter is not running at ${BASE}. Start it (double-click "Video Splitter.bat" in its folder, or run npm start) and try again. (${err.message})`)
  }
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = null }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} from ${route}`)
  if (data === null) throw new Error(`The app sent something unexpected for ${route}; is ${BASE} really Video Splitter?`)
  return data
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Cancelled')) }, { once: true })
})

const signalOf = (ctx) => ctx?.mcpReq?.signal

/* ----------------------------------------------------------------- words */

const clock = (s) => {
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`
}
const mb = (bytes) => (bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB' : (bytes / 1e6).toFixed(1) + ' MB')
const decodeId = (id) => Buffer.from(String(id), 'base64url').toString('utf8')
const nameOf = (id) => decodeId(id).split('/').pop()
const bucketOf = (id) => { const p = decodeId(id).split('/'); return p.length > 1 ? p[0] : null }

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const json = (data) => text(JSON.stringify(data, null, 2))

/** Keeps a page under the character limit by returning fewer items. */
function page (items, offset, render, more) {
  let n = items.length
  let out = render(items)
  while (n > 1 && out.length + 80 > CHARACTER_LIMIT) {
    n = Math.floor(n * 0.7)
    out = render(items.slice(0, n))
  }
  const next = offset + n
  if (n < items.length || more > next) out += `\n\nMore: call again with offset=${next}.`
  return out
}

/* ------------------------------------------------------------ the edit */

const PLAIN_LOOK = { crop: null, canvas: 'original', background: 'blur' }

/** The clip's saved edit, or a fresh one of the whole clip. */
async function editOf (id, signal) {
  const info = await api('/api/probe/' + encodeURIComponent(id), { signal })
  if (!info.hasVideo) throw new Error('That file has no picture to edit')
  const saved = await api('/api/edit/' + encodeURIComponent(id), { signal })
  if (saved.none) return { info, fresh: true, edit: { pieces: initial(info.duration), sounds: [], look: PLAIN_LOOK, texts: [] }, extra: {} }
  return { info, fresh: false, edit: { texts: [], sounds: [], look: PLAIN_LOOK, ...saved.edit }, extra: saved.extra || {}, savedAt: saved.savedAt }
}

const saveEdit = (id, edit, extra, signal) => api('/api/edit/' + encodeURIComponent(id), { method: 'PUT', body: { edit, extra }, signal })

/** The pieces as the export and captions routes want them. */
const segmentsOf = (pieces, mainId) => pieces.map((p) => {
  const t = p.transition ? { transition: p.transition } : {}
  if (isImage(p)) return { kind: 'image', image: p.image, length: p.end - p.start, ...t }
  return { ...(p.src && p.src !== mainId ? { src: p.src } : {}), start: p.start, end: p.end, ...speedFields(p), ...t }
})

const soundsOf = (sounds) => (sounds || []).map((x) => ({ id: x.media, at: x.at, from: x.from, len: x.len, volume: x.volume }))

// The same fingerprint the editor keeps, to know the captions match the cuts.
const speedMark = (p) => { const [a, b] = speedsOf(p); return a === 1 && b === 1 ? '' : '@' + a + '-' + b + (p.pitch === 'shift' ? 'p' : '') }
const cutsOf = (pieces) => pieces.map((p) => (isImage(p) ? 'i' + (p.end - p.start).toFixed(2) : (p.src || '') + p.start.toFixed(2) + '-' + p.end.toFixed(2) + speedMark(p))).join('|')

const isBlur = (x) => x && x.kind === 'blur'

function describeEdit (edit, extra) {
  const lines = []
  const len = total(edit.pieces)
  lines.push(`Pieces (${edit.pieces.length}, ${clock(len)} in all):`)
  edit.pieces.forEach((p, i) => {
    if (isImage(p)) { lines.push(`  ${i + 1}. picture ${p.image} for ${(p.end - p.start).toFixed(1)} s`); return }
    const [a, b] = speedsOf(p)
    const speed = a === 1 && b === 1 ? '' : a === b ? ` · ${a}× speed` : ` · ${a}→${b}× speed`
    const tr = p.transition ? ` · ${p.transition.type} transition in` : ''
    lines.push(`  ${i + 1}. ${clock(p.start)}–${clock(p.end)}${p.src ? ' of ' + nameOf(p.src) : ''}${speed}${tr} (id ${p.id})`)
  })
  const texts = (edit.texts || []).filter((x) => !isBlur(x) && !x.caption)
  const captions = (edit.texts || []).filter((x) => x.caption)
  const blurs = (edit.texts || []).filter(isBlur)
  if (texts.length) {
    lines.push(`Texts (${texts.length}):`)
    for (const t of texts.slice(0, 30)) lines.push(`  ${clock(t.start)}–${clock(t.end)} "${t.text}" (${t.font}/${t.style}, id ${t.id})`)
  }
  if (captions.length) {
    lines.push(`Captions (${captions.length}): ${clock(captions[0].start)}–${clock(captions[captions.length - 1].end)}` +
      (edit.captionsFor && edit.captionsFor !== cutsOf(edit.pieces) ? ' (made for other cuts; run videosplitter_add_captions again)' : ''))
    for (const c of captions.slice(0, 12)) lines.push(`  ${clock(c.start)} "${c.text}"`)
    if (captions.length > 12) lines.push(`  … ${captions.length - 12} more`)
  }
  if (blurs.length) lines.push(`Blurs: ${blurs.length}`)
  if ((edit.sounds || []).length) {
    lines.push(`Sounds (${edit.sounds.length}):`)
    for (const s of edit.sounds) lines.push(`  ${s.name || s.media} at ${clock(s.at)} for ${(s.len || 0).toFixed(1)} s, volume ${s.volume ?? 1}`)
  }
  const L = edit.look || PLAIN_LOOK
  const look = [L.crop ? 'cropped' : null, L.canvas && L.canvas !== 'original' ? `${L.canvas} canvas with ${L.background} fill` : null, L.fadeIn ? `fade in ${L.fadeIn}s` : null, L.fadeOut ? `fade out ${L.fadeOut}s` : null].filter(Boolean)
  if (look.length) lines.push('Look: ' + look.join(', '))
  if (extra?.soundOff) lines.push('Clip sound: off')
  return lines.join('\n')
}

/* -------------------------------------------------------------- schemas */

const ClipId = z.string().min(1).describe('A clip id, as videosplitter_list_clips or videosplitter_list_unsorted give it')

const PieceIn = z.object({
  start: z.number().min(0).describe('Seconds into the clip where this piece starts'),
  end: z.number().min(0).describe('Seconds into the clip where this piece ends'),
  speed: z.number().min(0.1).max(10).optional().describe('Playback speed: 1 is normal, 2 twice as fast, 0.5 half'),
  speedEnd: z.number().min(0.1).max(10).optional().describe('With speed, ramps from speed to speedEnd across the piece (slow then fast)'),
  pitch: z.enum(['keep', 'shift']).optional().describe("'shift' lets the voice go chipmunk or deep with the speed; default keeps it natural"),
  smooth: z.boolean().optional().describe('Smooth slow motion (made-up in-between frames) when slower than normal'),
  transition: z.object({
    type: z.enum(Object.keys(TRANSITIONS)).describe(Object.keys(TRANSITIONS).join(', ')),
    d: z.number().min(0.1).max(4).optional().describe('Seconds, default 0.5')
  }).nullable().optional().describe('A transition at the cut before this piece (ignored on the first piece)'),
  src: z.string().optional().describe('Take this piece from another clip (its id) instead of the clip being edited')
})

const TextIn = z.object({
  text: z.string().min(1).max(500).describe('What it says; a newline starts a new line'),
  start: z.number().min(0).describe('Seconds into the finished edit when it appears'),
  end: z.number().min(0).describe('Seconds into the finished edit when it goes'),
  x: z.number().min(0).max(1).optional().describe('Centre, as a fraction of the frame width; 0.5 is the middle'),
  y: z.number().min(0).max(1).optional().describe('Centre, as a fraction of the frame height; 0.5 middle, 0.78 lower third, 0.15 near the top'),
  size: z.number().min(0.01).max(0.5).optional().describe('Letter height as a fraction of the frame height; 0.06 default, 0.05 captions, 0.1 big'),
  font: z.string().optional().describe(`One of ${Object.keys(FONTS).join(', ')}, or an imported font's name`),
  style: z.enum(Object.keys(STYLES)).optional().describe(Object.keys(STYLES).join(', ')),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex colour, default #ffffff'),
  animIn: z.enum(Object.keys(IN_ANIMS)).optional().describe('How it arrives: ' + Object.keys(IN_ANIMS).join(', ')),
  animOut: z.enum(Object.keys(OUT_ANIMS)).optional().describe('How it leaves: ' + Object.keys(OUT_ANIMS).join(', ')),
  animLoop: z.enum(Object.keys(LOOP_ANIMS)).optional().describe('While on screen: ' + Object.keys(LOOP_ANIMS).join(', ') + ' (karaoke needs words)'),
  caption: z.boolean().optional().describe('true for a caption of speech; it takes the caption style'),
  words: z.array(z.object({ w: z.string(), a: z.number(), b: z.number() })).optional().describe('Word timings (edit seconds) for word-by-word captions'),
  hl: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Highlight colour for word-by-word captions')
})

const SoundIn = z.object({
  media: z.string().describe("The sound file's id, from the bucket's audio folder"),
  name: z.string().optional(),
  at: z.number().min(0).describe('Seconds into the edit where it starts'),
  from: z.number().min(0).default(0).describe('Seconds into the sound file to start from'),
  len: z.number().min(0.1).describe('How long it plays, in seconds'),
  volume: z.number().min(0).max(2).default(1)
})

const LookIn = z.object({
  canvas: z.enum(['original', '9:16', '1:1', '4:5', '16:9']).optional().describe('The frame shape; the picture is fitted inside it'),
  background: z.enum(['blur', 'black']).optional().describe('What fills the frame round a picture that does not cover it'),
  crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional().describe('Crop as fractions of the picture, or null for none'),
  fadeIn: z.number().min(0).max(5).optional().describe('Seconds of fade from black at the start, 0 for none'),
  fadeOut: z.number().min(0).max(5).optional().describe('Seconds of fade to black at the end, 0 for none')
})

const Model = z.enum(['base', 'small']).default('base').describe("Speech model: 'base' (Quick) or 'small' (Better, slower, more accurate)")
const Format = z.enum(['markdown', 'json']).default('markdown').describe("'markdown' to read, 'json' for the full data")

/** Pieces from the caller, checked against the clip and given ids. */
function cleanPieces (list, duration) {
  if (!list.length) throw new Error('Keep at least one piece')
  return list.map((p, i) => {
    const own = !p.src
    const end = own ? Math.min(p.end, duration) : p.end
    if (!(end > p.start)) throw new Error(`Piece ${i + 1} ends (${p.end}) before it starts (${p.start})${own && p.end > duration ? `; the clip is ${duration.toFixed(2)} s long` : ''}`)
    if (end - p.start < 0.05) throw new Error(`Piece ${i + 1} is shorter than 0.05 s`)
    const out = { id: newId(), start: p.start, end }
    if (p.src) out.src = p.src
    if (p.speed != null && (p.speed !== 1 || (p.speedEnd != null && p.speedEnd !== 1))) {
      out.speed = p.speed
      if (p.speedEnd != null && p.speedEnd !== p.speed) out.speedEnd = p.speedEnd
      if (p.pitch === 'shift') out.pitch = 'shift'
      if (p.smooth && Math.min(p.speed, p.speedEnd ?? p.speed) < 1) out.smooth = true
    }
    if (p.transition && i > 0) out.transition = { type: p.transition.type, d: p.transition.d ?? 0.5 }
    return out
  })
}

/** A text from the caller with the editor's defaults filled in. */
function cleanText (t, captionLook) {
  if (!(t.end > t.start)) throw new Error(`The text "${t.text}" ends before it starts`)
  const base = t.caption
    ? { ...CAPTION_LOOK, ...(captionLook || {}) }
    : { x: 0.5, y: 0.5, size: 0.06, font: 'clean', style: 'outline', color: '#ffffff', animIn: 'none', animOut: 'none', animLoop: 'none' }
  const out = { id: newId(), ...base }
  for (const k of ['text', 'start', 'end', 'x', 'y', 'size', 'font', 'style', 'color', 'animIn', 'animOut', 'animLoop', 'words', 'hl']) if (t[k] !== undefined) out[k] = t[k]
  if (t.caption) out.caption = true
  return out
}

/* -------------------------------------------------------- transcription */

/** Runs the app's speech recognition over segments and waits for the words. */
async function transcribe (body, signal) {
  for (let i = 0; ; i++) {
    let r
    try {
      r = await api('/api/captions/transcribe', { method: 'POST', body, signal })
    } catch (err) {
      if (/one-time download/.test(err.message)) throw new Error('Captions need the speech program first (a one-time download). Run videosplitter_install_captions, or in the app open any clip, press Captions and choose Quick or Better.')
      throw err
    }
    if (r.state === 'done') return r
    if (r.state === 'error') throw new Error(r.error || 'Captions failed')
    if (i > 1800) throw new Error('Captions are taking too long; try again later')
    await sleep(1000, signal)
  }
}

/* ---------------------------------------------------------------- tools */

function createServer () {
  const server = new McpServer({ name: 'video-splitter-mcp-server', version: VERSION })

  server.registerTool('videosplitter_status', {
    title: 'Video Splitter status',
    description: 'Whether Video Splitter is running, which folder it sorts, how many buckets and unsorted videos there are, whether FFmpeg and the captions (speech) program are ready. Call this first.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async (_args, ctx) => {
    const signal = signalOf(ctx)
    const state = await api('/api/state', { signal })
    let caps = null
    try { caps = await api('/api/captions/status', { signal }) } catch { caps = null }
    const lines = [
      `Video Splitter is running at ${BASE}.`,
      `Videos folder: ${state.sourceDir || '(none chosen yet)'}`,
      `FFmpeg: ${state.tools ? 'ready' : 'NOT FOUND (editing and export need it)'}`,
      `Buckets: ${state.buckets.length}. Waiting to be sorted: ${state.queue.length}.`
    ]
    if (caps) {
      const models = Object.entries(caps.models || {}).map(([k, m]) => `${k} (${m.label}, ${mb(m.size)}): ${m.ready ? 'ready' : 'not downloaded'}`)
      lines.push(`Captions program: ${caps.program ? 'ready' : 'not downloaded'}. Models: ${models.join('; ') || 'none'}.`)
      if (caps.install) lines.push(`A download is running: ${caps.install.phase} ${caps.install.total ? Math.round((caps.install.received / caps.install.total) * 100) + '%' : ''}${caps.install.error ? ' error: ' + caps.install.error : ''}`)
    }
    return text(lines.join('\n'))
  })

  server.registerTool('videosplitter_list_buckets', {
    title: 'List buckets',
    description: 'The buckets (folders) videos are sorted into, with how many videos each holds. Bucket ids are needed by videosplitter_file_clip and videosplitter_list_clips.',
    inputSchema: z.object({ response_format: Format }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ response_format }, ctx) => {
    const state = await api('/api/state', { signal: signalOf(ctx) })
    if (response_format === 'json') return json(state.buckets)
    if (!state.buckets.length) return text('No buckets yet. Make one with videosplitter_create_bucket.')
    return text(state.buckets.map((b) => `- ${b.name} (id ${b.id})${b.count != null ? ' · ' + b.count + ' videos' : ''}`).join('\n'))
  })

  server.registerTool('videosplitter_create_bucket', {
    title: 'Create a bucket',
    description: 'Makes a new bucket: a folder inside the videos folder that clips can be filed into.',
    inputSchema: z.object({ name: z.string().min(1).max(60).describe('The folder name, e.g. "dragons"') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ name }, ctx) => {
    const state = await api('/api/buckets', { method: 'POST', body: { name }, signal: signalOf(ctx) })
    const made = (state.buckets || []).find((b) => b.name.toLowerCase() === name.trim().toLowerCase())
    return text(made ? `Bucket "${made.name}" is ready (id ${made.id}).` : `Bucket "${name}" made.`)
  })

  server.registerTool('videosplitter_list_unsorted', {
    title: 'List unsorted videos',
    description: 'Videos still waiting in the videos folder to be filed into a bucket, oldest first as the app shows them. Use videosplitter_file_clip to sort one.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      response_format: Format
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ limit, offset, response_format }, ctx) => {
    const state = await api('/api/state', { signal: signalOf(ctx) })
    const items = state.queue.slice(offset, offset + limit)
    if (response_format === 'json') return json({ total: state.queue.length, offset, count: items.length, items, ...(state.queue.length > offset + items.length ? { next_offset: offset + items.length } : {}) })
    if (!state.queue.length) return text('Nothing is waiting to be sorted.')
    return text(page(items, offset, (xs) => `${state.queue.length} waiting to be sorted:\n` + xs.map((v) => `- ${v.name} (id ${v.id})${v.playable ? '' : ' · no preview in the browser'}`).join('\n'), state.queue.length))
  })

  server.registerTool('videosplitter_file_clip', {
    title: 'File a clip into a bucket',
    description: 'Moves an unsorted video into a bucket, exactly as pressing that bucket in the app does. The clip gets a new id in its bucket (videosplitter_list_clips shows it). The app can undo its last filing.',
    inputSchema: z.object({ clip_id: ClipId, bucket_id: z.string().min(1).describe('From videosplitter_list_buckets') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ clip_id, bucket_id }, ctx) => {
    const r = await api('/api/assign', { method: 'POST', body: { id: clip_id, bucketId: bucket_id }, signal: signalOf(ctx) })
    const count = r.bucket && r.bucket.count != null ? ` It holds ${r.bucket.count} videos now.` : ''
    return text(`Filed ${r.moved?.name || nameOf(clip_id)} into ${r.moved?.bucket || 'the bucket'}.${count}`)
  })

  server.registerTool('videosplitter_list_clips', {
    title: 'List clips in buckets',
    description: 'The sorted clips, in one bucket or all of them, with their ids. "edited" marks clips with a saved edit. Lengths are not listed here; videosplitter_clip_info gives them.',
    inputSchema: z.object({
      bucket_id: z.string().optional().describe('One bucket; leave out for every bucket'),
      query: z.string().optional().describe('Only clips whose name contains this (case does not matter)'),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      response_format: Format
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ bucket_id, query, limit, offset, response_format }, ctx) => {
    const signal = signalOf(ctx)
    const state = await api('/api/state', { signal })
    const buckets = bucket_id ? state.buckets.filter((b) => b.id === bucket_id) : state.buckets
    if (bucket_id && !buckets.length) throw new Error('No bucket has that id; videosplitter_list_buckets lists them')
    const all = []
    for (const b of buckets) {
      const r = await api('/api/bucket/' + encodeURIComponent(b.id), { signal })
      for (const v of r.videos) all.push({ ...v, bucket: b.name, bucketId: b.id })
    }
    const q = (query || '').trim().toLowerCase()
    const found = q ? all.filter((v) => v.name.toLowerCase().includes(q)) : all
    const items = found.slice(offset, offset + limit)
    if (response_format === 'json') return json({ total: found.length, offset, count: items.length, clips: items, ...(found.length > offset + items.length ? { next_offset: offset + items.length } : {}) })
    if (!found.length) return text(q ? `No clip's name contains "${query}".` : 'No clips in ' + (bucket_id ? 'that bucket' : 'any bucket') + ' yet.')
    return text(page(items, offset, (xs) => {
      const lines = [`${found.length} clip${found.length === 1 ? '' : 's'}${q ? ` matching "${query}"` : ''}:`]
      let last = null
      for (const v of xs) {
        if (v.bucket !== last) { lines.push(`${v.bucket}:`); last = v.bucket }
        lines.push(`  - ${v.name} · ${mb(v.size)}${v.edited ? ' · edited' : ''}${v.playable ? '' : ' · no preview'} (id ${v.id})`)
      }
      return lines.join('\n')
    }, found.length))
  })

  server.registerTool('videosplitter_clip_info', {
    title: 'About a clip',
    description: 'A clip\'s length, picture size, frame rate, whether it has sound, and a summary of its saved edit if there is one.',
    inputSchema: z.object({ clip_id: ClipId }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ clip_id }, ctx) => {
    const { info, fresh, edit, extra, savedAt } = await editOf(clip_id, signalOf(ctx))
    const lines = [
      `${nameOf(clip_id)}${bucketOf(clip_id) ? ' in ' + bucketOf(clip_id) : ' (unsorted)'}`,
      `Length ${clock(info.duration)} · ${info.width}×${info.height} · ${Math.round(info.fps)} fps · ${info.hasAudio ? 'has sound' : 'no sound'}`
    ]
    if (fresh) lines.push('No saved edit: the whole clip as filmed.')
    else lines.push(`Saved edit (${savedAt}):`, describeEdit(edit, extra))
    return text(lines.join('\n'))
  })

  server.registerTool('videosplitter_look_at', {
    title: 'Look at frames',
    description: 'Still frames from moments in a clip, as pictures, to see what is on screen: who is in it, what happens, where text or faces are, whether a moment is worth keeping. Up to 8 moments at a time.',
    inputSchema: z.object({
      clip_id: ClipId,
      times: z.array(z.number().min(0)).min(1).max(8).describe('Seconds into the clip, e.g. [0, 2.5, 10]'),
      width: z.number().int().min(160).max(1280).default(640).describe('Picture width in pixels; smaller is quicker')
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ clip_id, times, width }, ctx) => {
    const signal = signalOf(ctx)
    const content = []
    for (const t of times) {
      let res
      try {
        res = await fetch(`${BASE}/api/frame/${encodeURIComponent(clip_id)}?t=${t}&w=${width}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) })
      } catch (err) {
        throw new Error(`Video Splitter is not running at ${BASE}. Start it and try again. (${err.message})`)
      }
      const type = res.headers.get('content-type') || ''
      if (!res.ok) {
        let msg = `${res.status}`
        try { msg = (await res.json()).error || msg } catch { /* not json */ }
        throw new Error(msg)
      }
      if (!type.startsWith('image/')) throw new Error('The running Video Splitter is older than this tool. Close the app and start it again (Video Splitter.bat), then try once more.')
      const data = Buffer.from(await res.arrayBuffer()).toString('base64')
      content.push({ type: 'text', text: `At ${clock(t)}:` }, { type: 'image', data, mimeType: 'image/jpeg' })
    }
    return { content }
  })

  server.registerTool('videosplitter_install_captions', {
    title: 'Download the captions program',
    description: 'A one-time download of the speech recognition program (8 MB) and a language model (Quick 148 MB or Better 488 MB), which captions and transcripts need. Waits until it is done; takes minutes on a slow connection.',
    inputSchema: z.object({ model: Model }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ model }, ctx) => {
    const signal = signalOf(ctx)
    await api('/api/captions/install', { method: 'POST', body: { model }, signal })
    for (let i = 0; i < 3600; i++) {
      await sleep(1000, signal)
      const s = await api('/api/captions/status', { signal })
      const m = s.models?.[model]
      if (s.install?.error) throw new Error('The download failed: ' + s.install.error + '. Try again.')
      if (!s.install && m?.ready) return text(`Captions are ready: the ${m.label} model (${mb(m.size)}) is downloaded.`)
    }
    throw new Error('The download is taking too long; check videosplitter_status later')
  })

  server.registerTool('videosplitter_transcript', {
    title: 'Transcript of a clip',
    description: 'What is said in a clip, with times: every word timed, grouped into lines, plus the quiet stretches (no speech), which is what to cut for "trim the dead air". Times are seconds into the clip as filmed, ready for videosplitter_save_edit pieces. Needs the captions program (videosplitter_status says).',
    inputSchema: z.object({
      clip_id: ClipId,
      model: Model,
      names: z.string().max(400).optional().describe('Names and unusual words to spell right, comma separated'),
      translate: z.boolean().default(false).describe('Translate speech in another language into English'),
      response_format: Format
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ clip_id, model, names, translate, response_format }, ctx) => {
    const signal = signalOf(ctx)
    const info = await api('/api/probe/' + encodeURIComponent(clip_id), { signal })
    if (!info.hasAudio) throw new Error('That clip has no sound to transcribe')
    const r = await transcribe({ id: clip_id, segments: [{ start: 0, end: info.duration }], model, names: names || '', translate }, signal)
    const words = r.words || []
    const lines = captionChunks(words, { maxWords: 16, maxChars: 100, maxGap: 1.2 })
    const quiet = []
    let at = 0
    for (const w of words) { if (w.a - at >= 1) quiet.push([at, w.a]); at = Math.max(at, w.b) }
    if (info.duration - at >= 1) quiet.push([at, info.duration])
    if (response_format === 'json') return json({ language: r.language, duration: info.duration, lines: lines.map((l) => ({ start: l.start, end: l.end, text: l.text })), quiet: quiet.map(([a, b]) => ({ start: a, end: b })), words: words.slice(0, 3000) })
    if (!words.length) return text(`No speech was found in ${nameOf(clip_id)} (${clock(info.duration)} long).`)
    const out = [`${nameOf(clip_id)}: ${words.length} words${r.language ? ', ' + r.language : ''}, ${clock(info.duration)} long.`, '']
    for (const l of lines) out.push(`[${clock(l.start)}–${clock(l.end)}] ${l.text}`)
    out.push('', quiet.length ? 'Quiet (no speech): ' + quiet.map(([a, b]) => `${clock(a)}–${clock(b)}`).join(', ') : 'No quiet stretch of a second or more.')
    let t = out.join('\n')
    if (t.length > CHARACTER_LIMIT) t = t.slice(0, CHARACTER_LIMIT - 60) + '\n… (cut short; ask for json to get everything)'
    return text(t)
  })

  server.registerTool('videosplitter_get_edit', {
    title: 'Read a saved edit',
    description: 'The saved edit of a clip: its pieces (the cuts, with speeds and transitions), texts, captions, blurs, sounds and look. Ask for json to get the exact data that videosplitter_save_edit takes.',
    inputSchema: z.object({ clip_id: ClipId, response_format: Format }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ clip_id, response_format }, ctx) => {
    const { info, fresh, edit, extra, savedAt } = await editOf(clip_id, signalOf(ctx))
    if (response_format === 'json') return json({ clip: { id: clip_id, name: nameOf(clip_id), duration: info.duration }, saved: !fresh, savedAt: savedAt || null, edit, extra })
    if (fresh) return text(`${nameOf(clip_id)} has no saved edit; it would export as filmed (${clock(info.duration)}).`)
    return text(`${nameOf(clip_id)}, saved ${savedAt}:\n` + describeEdit(edit, extra))
  })

  server.registerTool('videosplitter_save_edit', {
    title: 'Save an edit',
    description: `Sets a clip's edit, the way the editor saves it, so it shows in the app and can be exported. Give only what changes: pieces replace the cuts, texts replace every text and caption, sounds replace the added sounds, look changes the frame. What is left out stays as saved.

Pieces are stretches of the clip in the order they play; leaving a stretch out cuts it. Examples: trim to 2.5–14 s: pieces [{start: 2.5, end: 14}]. Cut 8–9.5 s out: [{start: 0, end: 8}, {start: 9.5, end: 20}]. Double speed with a fade: [{start: 0, end: 20, speed: 2}, {start: 25, end: 40, transition: {type: "fade"}}].
Text times are seconds into the finished edit, after cuts.`,
    inputSchema: z.object({
      clip_id: ClipId,
      pieces: z.array(PieceIn).min(1).max(100).optional(),
      texts: z.array(TextIn).max(500).optional(),
      sounds: z.array(SoundIn).max(50).optional(),
      look: LookIn.optional(),
      sound_off: z.boolean().optional().describe("true mutes the clip's own sound in the export")
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ clip_id, pieces, texts, sounds, look, sound_off }, ctx) => {
    const signal = signalOf(ctx)
    const { info, edit, extra } = await editOf(clip_id, signal)
    const next = { ...edit }
    if (pieces) next.pieces = cleanPieces(pieces, info.duration)
    if (texts) next.texts = texts.map((t) => cleanText(t, edit.captionLook))
    if (sounds) next.sounds = sounds.map((s) => ({ id: newId(), ...s }))
    if (look) next.look = { ...(edit.look || PLAIN_LOOK), ...look }
    const nextExtra = { ...extra, ...(sound_off != null ? { soundOff: sound_off } : {}) }
    const len = total(next.pieces)
    const late = (next.texts || []).filter((t) => t.start >= len)
    await saveEdit(clip_id, next, nextExtra, signal)
    const notes = []
    if (late.length) notes.push(`${late.length} text${late.length === 1 ? ' starts' : 's start'} after the edit ends (${clock(len)}) and will not show.`)
    if (pieces && (next.texts || []).some((t) => t.caption) && next.captionsFor && next.captionsFor !== cutsOf(next.pieces)) notes.push('The captions were made for the old cuts; run videosplitter_add_captions to redo them.')
    return text(`Saved. ${nameOf(clip_id)} now plays ${clock(len)}.\n` + describeEdit(next, nextExtra) + (notes.length ? '\n\n' + notes.join('\n') : ''))
  })

  server.registerTool('videosplitter_add_text', {
    title: 'Add a text',
    description: 'Puts one text over the edit (a title, a label, a joke), keeping everything else as saved. Times are seconds into the finished edit. For captions of speech use videosplitter_add_captions.',
    inputSchema: z.object({ clip_id: ClipId, ...TextIn.shape }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ clip_id, ...t }, ctx) => {
    const signal = signalOf(ctx)
    const { edit, extra } = await editOf(clip_id, signal)
    const made = cleanText(t, edit.captionLook)
    await saveEdit(clip_id, { ...edit, texts: [...(edit.texts || []), made] }, extra, signal)
    return text(`Added "${made.text}" from ${clock(made.start)} to ${clock(made.end)} (id ${made.id}). The edit has ${(edit.texts || []).length + 1} texts now.`)
  })

  server.registerTool('videosplitter_add_captions', {
    title: 'Add captions from the speech',
    description: 'Listens to the edit (its pieces at their speeds, plus added sounds) and puts timed captions on it, a few words at a time, in the caption style the clip already uses. Replaces earlier captions, keeps other texts. Check them afterwards with videosplitter_get_edit; fix a word with videosplitter_save_edit texts.',
    inputSchema: z.object({
      clip_id: ClipId,
      model: Model,
      names: z.string().max(400).optional().describe('Names and unusual words to spell right, comma separated'),
      translate: z.boolean().default(false).describe('Caption speech in another language in English')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ clip_id, model, names, translate }, ctx) => {
    const signal = signalOf(ctx)
    const { edit, extra } = await editOf(clip_id, signal)
    const r = await transcribe({
      id: clip_id,
      segments: segmentsOf(edit.pieces, clip_id),
      sounds: soundsOf(edit.sounds),
      clipSound: !extra.soundOff,
      model,
      names: names || '',
      translate
    }, signal)
    const len = total(edit.pieces)
    const chunks = captionChunks(r.words || []).filter((c) => c.start < len)
    const was = (edit.texts || []).find((x) => x.caption)
    const style = edit.captionLook || (was ? Object.fromEntries(Object.keys(CAPTION_LOOK).map((k) => [k, was[k]])) : {})
    const made = chunks.map((c) => ({ id: newId(), caption: true, text: c.text, start: c.start, end: Math.min(c.end, len), words: c.words, ...CAPTION_LOOK, ...style }))
    const texts = [...(edit.texts || []).filter((x) => !x.caption), ...made]
    await saveEdit(clip_id, { ...edit, texts, captionsFor: cutsOf(edit.pieces) }, extra, signal)
    if (!made.length) return text('No speech was found in this edit, so no captions were added.')
    const lines = made.slice(0, 40).map((c) => `  ${clock(c.start)}–${clock(c.end)} ${c.text}`)
    return text(`Added ${made.length} captions${r.language ? ' (' + r.language + ')' : ''}:\n` + lines.join('\n') + (made.length > 40 ? `\n  … ${made.length - 40} more` : ''))
  })

  server.registerTool('videosplitter_export', {
    title: 'Export a clip',
    description: `Renders a clip's saved edit (or the clip as filmed) into the bucket's "edits" folder and waits for it. One video of every piece joined, or one file per piece. Can take a while for long clips.

Texts, captions and blurs are drawn by the editor, not by this tool, so an edit that has them is best exported from the app (open the clip, press Export); this tool leaves them out and says so. srt writes the captions as a subtitle file beside the video instead.`,
    inputSchema: z.object({
      clip_id: ClipId,
      mode: z.enum(['one', 'parts']).default('one').describe("'one' joins every piece into one video; 'parts' writes each piece as its own file"),
      quality: z.enum(['high', 'standard', 'small']).default('standard').describe("'small' is at most 1280 pixels tall, for sending on"),
      format: z.enum(['mp4', 'gif']).default('mp4'),
      srt: z.boolean().default(false).describe('Also write the captions as a .srt file')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ clip_id, mode, quality, format, srt }, ctx) => {
    const signal = signalOf(ctx)
    const { edit, extra } = await editOf(clip_id, signal)
    const gif = format === 'gif'
    const captions = (edit.texts || []).filter((x) => x.caption)
    const drawn = (edit.texts || []).filter((x) => !x.caption).length + captions.length
    const { job } = await api('/api/export', {
      method: 'POST',
      signal,
      body: {
        async: true,
        id: clip_id,
        segments: segmentsOf(edit.pieces, clip_id),
        join: mode === 'one' || gif,
        stripAudio: Boolean(extra.soundOff),
        mode: 'accurate',
        sounds: soundsOf(edit.sounds),
        look: edit.look || PLAIN_LOOK,
        quality,
        format,
        srt: srt && !gif && captions.length > 0,
        captions: captions.map((c) => ({ start: c.start, end: c.end, text: c.text })),
        overlays: [],
        blurs: []
      }
    })
    let r
    try {
      for (;;) {
        await sleep(700, signal)
        r = await api('/api/export/job/' + encodeURIComponent(job), { signal })
        if (r.state === 'done') break
        if (r.state !== 'running') throw new Error(r.error || 'The export did not finish')
      }
    } catch (err) {
      if (signal?.aborted) { try { await api('/api/export/job/' + encodeURIComponent(job) + '/stop', { method: 'POST' }) } catch { /* gone */ } }
      throw err
    }
    const res = r.result
    const lines = [`Exported ${nameOf(clip_id)} into ${res.dir}:`]
    for (const w of res.written) lines.push(`  - ${w.name} (${mb(w.size)})`)
    if (drawn) lines.push('', `${drawn} text${drawn === 1 ? '' : 's'} (captions included) and any blurs were left out: the editor draws those. To get them, open the clip in Video Splitter and press Export there${srt ? '' : ', or export again with srt: true for a subtitle file'}.`)
    return text(lines.join('\n'))
  })

  server.registerTool('videosplitter_forget_edit', {
    title: 'Forget a saved edit',
    description: "Throws away a clip's saved edit (its cuts, texts, captions, sounds and look), so it is the whole clip as filmed again. Exported files are not touched.",
    inputSchema: z.object({ clip_id: ClipId }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ clip_id }, ctx) => {
    await api('/api/edit/' + encodeURIComponent(clip_id), { method: 'DELETE', signal: signalOf(ctx) })
    return text(`${nameOf(clip_id)} has no saved edit now.`)
  })

  return server
}

serveStdio(createServer)
console.error(`video-splitter-mcp-server ${VERSION} on stdio, talking to ${BASE}`)
