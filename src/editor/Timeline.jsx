import { useEffect, useRef, useState } from 'react'
import { formatClock, isImage, lengthOf, offsets as offsetsOf, total as totalOf } from './model.js'

/**
 * The CapCut timeline: the playhead stays in the middle and the edit slides
 * underneath it. Drawn on a canvas because a long clip zoomed in is thousands
 * of frames and waveform bars, which as DOM nodes would crawl.
 *
 * Drag the empty area or the clips to scrub. Click a clip to select it, then
 * drag its white handles to trim. Click the ruler to jump. Wheel scrolls,
 * Ctrl + wheel zooms.
 */

const RULER = 24
const CLIP_TOP = 30
// Lane sizes. A compact set is used while a panel is open under the
// timeline, so the picture keeps its room. One timeline exists at a time, so
// these are simply switched before each render.
let FRAMES_H, WAVE_H, CLIP_H, MUSIC_TOP, MUSIC_H, MUSIC_ROW, SOUND_ROWS, TEXT_TOP, TEXT_H, TEXT_ROW, MAX_ROWS
function setDims (compact) {
  FRAMES_H = compact ? 30 : 50
  WAVE_H = compact ? 12 : 26
  CLIP_H = FRAMES_H + WAVE_H
  MUSIC_TOP = CLIP_TOP + CLIP_H + (compact ? 5 : 8)
  MUSIC_H = compact ? 16 : 22
  MUSIC_ROW = MUSIC_H + 3
  SOUND_ROWS = 1
  TEXT_TOP = MUSIC_TOP + MUSIC_H + (compact ? 4 : 6)
  TEXT_H = compact ? 15 : 20
  TEXT_ROW = TEXT_H + 3
  MAX_ROWS = compact ? 2 : 3
}
setDims(false)
const HANDLE = 12
const DRAG_SLOP = 4
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const FONT = "11px Roboto, 'Segoe UI', sans-serif"

/**
 * Lanes, as CapCut has them: every text and every sound sits in a lane, one
 * under another. An item keeps the lane it was put in; one from an older edit
 * without a lane takes the first lane free at its time.
 */
export function lanesOf (items, startOf, endOf) {
  const rows = new Map()
  const placed = []
  const free = (lane, a, b) => !placed.some((p) => p.lane === lane && p.a < b - 1e-6 && p.b > a + 1e-6)
  for (const t of items || []) {
    if (Number.isInteger(t.lane) && t.lane >= 0) { rows.set(t.id, t.lane); placed.push({ lane: t.lane, a: startOf(t), b: endOf(t) }) }
  }
  for (const t of [...(items || [])].filter((x) => !rows.has(x.id)).sort((a, b) => startOf(a) - startOf(b))) {
    let lane = 0
    while (!free(lane, startOf(t), endOf(t))) lane++
    rows.set(t.id, lane)
    placed.push({ lane, a: startOf(t), b: endOf(t) })
  }
  return { rows, count: Math.max(1, ...[...rows.values()].map((r) => r + 1)) }
}
const textRows = (texts) => lanesOf(texts, (t) => t.start, (t) => t.end)
const soundRows = (sounds) => lanesOf(sounds, (x) => x.at, (x) => x.at + x.len)
const GUTTER = 66

/** Sound rows decide where the text rows start. */
function setLanes (sounds) {
  SOUND_ROWS = soundRows(sounds).count
  TEXT_TOP = MUSIC_TOP + SOUND_ROWS * MUSIC_ROW - 3 + (FRAMES_H < 50 ? 4 : 6)
}

const heightFor = (texts) => TEXT_TOP + textRows(texts).count * TEXT_ROW + 8

function lastAtOrBefore (times, s) {
  let lo = 0
  let hi = times.length - 1
  if (s <= times[0]) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= s) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * A sound being dragged: moved whole, or trimmed from either end. Trimming
 * the start moves where it starts on the timeline and how far into the sound
 * it begins together, so what you hear stays lined up with what you see.
 */
function soundSpan (d, dt) {
  if (d.edge === 'move') return { at: Math.max(0, d.at + dt), from: d.from, len: d.len }
  if (d.edge === 'start') {
    const k = Math.min(Math.max(dt, -d.from, -d.at), d.len - 0.2)
    return { at: d.at + k, from: d.from + k, len: d.len - k }
  }
  const room = (d.dur || Infinity) - d.from
  return { at: d.at, from: d.from, len: Math.min(Math.max(d.len + dt, 0.2), room) }
}

function textSpan (d, dt) {
  const len = d.end - d.start
  if (d.edge === 'move') {
    const start = Math.max(0, d.start + dt)
    return { start, end: start + len }
  }
  if (d.edge === 'start') return { start: Math.min(Math.max(0, d.start + dt), d.end - 0.2), end: d.end }
  return { start: d.start, end: Math.max(d.end + dt, d.start + 0.2) }
}

export default function Timeline (props) {
  setDims(Boolean(props.compact))
  setLanes(props.sounds)
  const boxRef = useRef(null)
  const canvasRef = useRef(null)
  const live = useRef(props)
  live.current = props
  const size = useRef({ w: 0, dpr: 1 })
  const drag = useRef(null)
  const [, redraw] = useState(0)

  useEffect(() => {
    const box = boxRef.current
    const ro = new ResizeObserver(() => {
      const w = box.clientWidth
      const dpr = window.devicePixelRatio || 1
      const c = canvasRef.current
      c.width = Math.round(w * dpr)
      c.height = Math.round(heightFor(live.current.texts) * dpr)
      size.current = { w, dpr }
      live.current.onWidth?.(w)
      redraw((n) => n + 1)
    })
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  // Geometry shared by drawing and hit testing.
  function layout () {
    const p = live.current
    const W = size.current.w
    const cx = Math.round(W / 2)
    const X = (T) => cx + (T - p.t) * p.pps
    const offs = offsetsOf(p.pieces)
    const rects = p.pieces.map((piece, i) => ({
      piece,
      i,
      x0: X(offs[i]),
      x1: X(offs[i] + lengthOf(piece))
    }))
    const end = totalOf(p.pieces)
    // Sounds: each plays from `at` on the timeline for `len` seconds.
    const sRows = soundRows(p.sounds).rows
    const sbars = (p.sounds || []).map((snd) => ({
      snd,
      x0: X(snd.at),
      x1: X(snd.at + snd.len),
      y: MUSIC_TOP + (sRows.get(snd.id) || 0) * MUSIC_ROW
    }))
    const { rows } = textRows(p.texts)
    const bars = (p.texts || []).map((t) => ({
      t,
      x0: X(t.start),
      x1: X(t.end),
      y: TEXT_TOP + (rows.get(t.id) || 0) * TEXT_ROW
    }))
    return { p, W, cx, X, rects, end, sbars, bars }
  }

  function dropIndex (id, x) {
    const { rects } = layout()
    return rects.filter((r) => r.piece.id !== id && (r.x0 + r.x1) / 2 < x).length
  }

  function hitTest (x, y) {
    setDims(Boolean(live.current.compact))
    setLanes(live.current.sounds)
    const { p, rects, sbars, bars } = layout()
    if (y < CLIP_TOP - 2) return { zone: 'ruler' }
    if (x <= GUTTER && y >= MUSIC_TOP - 3) return { zone: y >= TEXT_TOP - 2 ? 'addtext' : 'addmusic' }
    if (y >= TEXT_TOP - 2) {
      // Selected first, so its edges win over a neighbour's.
      const order = [...bars].sort((a, b) => (b.t.id === p.selectedTextId) - (a.t.id === p.selectedTextId))
      for (const b of order) {
        if (y < b.y - 1 || y > b.y + TEXT_H + 1 || x < b.x0 - 5 || x > b.x1 + 5) continue
        const edges = b.x1 - b.x0 > 22
        if (edges && x <= b.x0 + 6) return { zone: 'text', edge: 'start', item: b.t }
        if (edges && x >= b.x1 - 6) return { zone: 'text', edge: 'end', item: b.t }
        return { zone: 'text', edge: 'move', item: b.t }
      }
      return bars.length ? { zone: 'none' } : { zone: 'addtext' }
    }
    if (y >= MUSIC_TOP - 3 && y <= MUSIC_TOP + SOUND_ROWS * MUSIC_ROW) {
      const order = [...sbars].sort((a, b) => (b.snd.id === p.selectedSoundId) - (a.snd.id === p.selectedSoundId))
      for (const b of order) {
        if (y < b.y - 1 || y > b.y + MUSIC_H + 1 || x < b.x0 - 5 || x > b.x1 + 5) continue
        const edges = b.x1 - b.x0 > 22
        if (edges && x <= b.x0 + 6) return { zone: 'sound', edge: 'start', snd: b.snd }
        if (edges && x >= b.x1 - 6) return { zone: 'sound', edge: 'end', snd: b.snd }
        return { zone: 'sound', edge: 'move', snd: b.snd }
      }
      return sbars.length ? { zone: 'none' } : { zone: 'addmusic' }
    }
    if (y > CLIP_TOP + CLIP_H + 4) return { zone: 'none' }
    const cy = CLIP_TOP + CLIP_H / 2
    if (Math.abs(y - cy) <= 11) {
      for (let k = 1; k < rects.length; k++) {
        if (rects[k].piece.id === p.selectedId || rects[k - 1].piece.id === p.selectedId) continue
        if (Math.abs(x - rects[k].x0) <= 10) return { zone: 'join', k }
      }
    }
    const sel = rects.find((r) => r.piece.id === p.selectedId)
    if (sel) {
      const mid = (sel.x0 + sel.x1) / 2
      if (x >= sel.x0 - 6 && x <= Math.min(sel.x0 + HANDLE + 2, mid)) return { zone: 'handle', edge: 'start', piece: sel.piece }
      if (x <= sel.x1 + 6 && x >= Math.max(sel.x1 - HANDLE - 2, mid)) return { zone: 'handle', edge: 'end', piece: sel.piece }
      if (x > sel.x0 && x < sel.x1 && p.pieces.length > 1) return { zone: 'move', piece: sel.piece }
    }
    const under = rects.find((r) => x >= r.x0 && x < r.x1)
    return under ? { zone: 'clip', piece: under.piece } : { zone: 'none' }
  }

  function draw () {
    setDims(Boolean(live.current.compact))
    setLanes(live.current.sounds)
    const c = canvasRef.current
    const { w: W, dpr } = size.current
    if (!c || !W) return
    const ctx = c.getContext('2d')
    const HEIGHT = heightFor(live.current.texts)
    if (c.height !== Math.round(HEIGHT * dpr)) c.height = Math.round(HEIGHT * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, HEIGHT)

    const { p, cx, X, rects, end } = layout()
    if (!(p.pps > 0)) return

    // Ruler: labels far enough apart to read, a dot halfway between.
    const step = STEPS.find((s) => s * p.pps >= 72) ?? 3600
    const first = Math.max(0, Math.floor((p.t - cx / p.pps) / step))
    const last = Math.ceil((p.t + cx / p.pps) / step)
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let k = first; k <= last; k++) {
      const T = k * step
      if (T > end + 1e-6) break
      const x = X(T)
      ctx.fillStyle = 'rgba(232, 234, 237, 0.5)'
      ctx.fillText(step < 1 ? formatClock(T, true).slice(0, -1) : formatClock(T), x, 11)
      const half = X(T + step / 2)
      if (T + step / 2 < end) {
        ctx.fillStyle = 'rgba(232, 234, 237, 0.28)'
        ctx.beginPath()
        ctx.arc(half, 11, 1.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const top = CLIP_TOP

    for (const { piece, x0, x1 } of rects) {
      const media = (p.media && p.media(piece)) || {}
      const strip = media.strip && !media.strip.none ? media.strip : null
      const stripImg = media.img
      const peaks = media.peaks
      const tileW = strip ? (strip.frameW * FRAMES_H) / strip.frameH : 0
      if (x1 < -2 || x0 > W + 2) continue
      // A hairline gap between pieces, so every cut is visible.
      const a = x0 + 1
      const b = Math.max(x1 - 1, a + 1)
      const w = b - a

      ctx.save()
      ctx.beginPath()
      ctx.roundRect(a, top, w, CLIP_H, 6)
      ctx.clip()

      ctx.fillStyle = '#1d2128'
      ctx.fillRect(a, top, w, FRAMES_H)

      const still = isImage(piece) ? p.images?.[piece.image] : null
      if (still && still.naturalWidth) {
        // A picture repeats along its piece, each tile cropped to fill.
        const ratio = Math.min(Math.max(still.naturalWidth / still.naturalHeight, 0.5), 2)
        const tw = FRAMES_H * ratio
        const sw = Math.min(still.naturalWidth, still.naturalHeight * ratio)
        const sh = sw / ratio
        const sx = (still.naturalWidth - sw) / 2
        const sy = (still.naturalHeight - sh) / 2
        for (let k = Math.max(0, Math.floor((-a) / tw)); a + k * tw < Math.min(b, W); k++) {
          ctx.drawImage(still, sx, sy, sw, sh, a + k * tw, top, tw + 0.5, FRAMES_H)
        }
      } else if (strip && stripImg && !isImage(piece)) {
        const from = Math.max(0, Math.floor((-a) / tileW))
        for (let k = from; a + k * tileW < Math.min(b, W); k++) {
          const tx = a + k * tileW
          const src = Math.min(piece.start + (k * tileW + tileW / 2) / p.pps, piece.end)
          const idx = lastAtOrBefore(strip.times, src)
          ctx.drawImage(
            stripImg,
            (idx % strip.cols) * strip.frameW, Math.floor(idx / strip.cols) * strip.frameH,
            strip.frameW, strip.frameH,
            tx, top, tileW + 0.5, FRAMES_H
          )
        }
      }

      // Waveform lane, peaks per two pixels, centred like CapCut's.
      const wy = top + FRAMES_H
      ctx.fillStyle = '#10161f'
      ctx.fillRect(a, wy, w, WAVE_H)
      if (isImage(piece)) {
        ctx.fillStyle = 'rgba(232, 234, 237, 0.14)'
        ctx.fillRect(a, wy + WAVE_H / 2, w, 1)
      } else if (peaks && peaks.length) {
        ctx.fillStyle = p.soundOff ? 'rgba(232, 234, 237, 0.18)' : 'rgba(138, 180, 248, 0.8)'
        const mid = wy + WAVE_H / 2
        const rate = media.rate || 50
        for (let px = Math.max(a, 0); px < Math.min(b, W); px += 2) {
          const s0 = piece.start + (px - a) / p.pps
          const i0 = Math.floor(s0 * rate)
          const i1 = Math.min(Math.max(i0 + 1, Math.ceil((s0 + 2 / p.pps) * rate)), i0 + 800, peaks.length)
          let peak = 0
          for (let i = i0; i < i1; i++) if (peaks[i] > peak) peak = peaks[i]
          const h = Math.max(1, (peak / 255) * (WAVE_H - 6))
          ctx.fillRect(px, mid - h / 2, 1.4, h)
        }
      } else if (peaks === null) {
        ctx.fillStyle = 'rgba(232, 234, 237, 0.14)'
        ctx.fillRect(a, wy + WAVE_H / 2, w, 1)
      }
      ctx.restore()

      const selected = piece.id === p.selectedId
      if (w > 58) {
        const label = lengthOf(piece).toFixed(1) + 's'
        const lx = a + (selected ? HANDLE + 5 : 5)
        ctx.font = FONT
        const tw = ctx.measureText(label).width + 10
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
        ctx.beginPath()
        ctx.roundRect(lx, top + 4, tw, 16, 5)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.textAlign = 'left'
        ctx.fillText(label, lx + 5, top + 12.5)
      }

      if (selected) {
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.roundRect(a + 1, top + 1, w - 2, CLIP_H - 2, 6)
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.roundRect(a, top, HANDLE, CLIP_H, [6, 0, 0, 6])
        ctx.roundRect(b - HANDLE, top, HANDLE, CLIP_H, [0, 6, 6, 0])
        ctx.fill()
        ctx.fillStyle = '#17171a'
        ctx.fillRect(a + HANDLE / 2 - 1, top + CLIP_H / 2 - 9, 2, 18)
        ctx.fillRect(b - HANDLE / 2 - 1, top + CLIP_H / 2 - 9, 2, 18)
      }
    }

    for (let k = 1; k < rects.length; k++) {
      const x = rects[k].x0
      if (x < -10 || x > W + 10) continue
      if (rects[k].piece.id === p.selectedId || rects[k - 1].piece.id === p.selectedId) continue
      const has = Boolean(rects[k].piece.transition)
      const sel = p.selectedJoin === k
      const y = top + CLIP_H / 2
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(x - 8, y - 8, 16, 16, 4)
      ctx.fillStyle = sel ? '#8ab4f8' : has ? '#ffffff' : 'rgba(20, 22, 26, 0.92)'
      ctx.fill()
      ctx.strokeStyle = sel || has ? '#ffffff' : 'rgba(255, 255, 255, 0.55)'
      ctx.lineWidth = 1.2
      ctx.stroke()
      // A bow-tie mark: two triangles meeting, the usual sign for a transition.
      ctx.fillStyle = sel || has ? '#16181c' : 'rgba(255, 255, 255, 0.8)'
      ctx.beginPath()
      ctx.moveTo(x - 4, y - 4); ctx.lineTo(x, y); ctx.lineTo(x - 4, y + 4); ctx.closePath()
      ctx.moveTo(x + 4, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + 4, y + 4); ctx.closePath()
      ctx.fill()
      ctx.restore()
    }

    const d = drag.current
    if (d && d.mode === 'reorder') {
      const others = rects.filter((r) => r.piece.id !== d.id)
      const lineX = d.to >= others.length ? (others.length ? others[others.length - 1].x1 : cx) : others[d.to].x0
      ctx.fillStyle = '#8ab4f8'
      ctx.fillRect(lineX - 1.5, top - 4, 3, CLIP_H + 8)
      const me = rects.find((r) => r.piece.id === d.id)
      const w = Math.min(140, Math.max(40, me ? me.x1 - me.x0 : 60))
      ctx.save()
      ctx.globalAlpha = 0.85
      ctx.fillStyle = '#2b3442'
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.roundRect(d.x - w / 2, top - 6, w, CLIP_H, 6)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = FONT
      ctx.textAlign = 'center'
      ctx.fillText(me ? lengthOf(me.piece).toFixed(1) + 's' : '', d.x, top - 6 + CLIP_H / 2)
      ctx.restore()
    }

    // The sound lane: a green bar for each sound, its waveform inside.
    const { sbars } = layout()
    for (const b of sbars) {
      if (b.x1 < -2 || b.x0 > W + 2) continue
      const snd = b.snd
      const a = Math.max(b.x0 + 0.5, -4)
      const e = Math.min(b.x1 - 0.5, W + 4)
      const sel = snd.id === p.selectedSoundId
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(a, b.y, Math.max(2, e - a), MUSIC_H, 5)
      ctx.fillStyle = sel ? 'rgba(94, 200, 140, 0.5)' : 'rgba(94, 200, 140, 0.26)'
      ctx.fill()
      if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke() }
      ctx.clip()
      const wave = p.soundWaves && p.soundWaves[snd.media]
      if (wave && wave.peaks && wave.peaks.length) {
        ctx.fillStyle = 'rgba(160, 235, 190, 0.85)'
        const mid = b.y + MUSIC_H / 2
        const rate = wave.rate || 50
        for (let px = Math.max(a, 0); px < Math.min(e, W); px += 2) {
          const s0 = snd.from + (px - b.x0) / p.pps
          const i0 = Math.floor(s0 * rate)
          const i1 = Math.min(Math.max(i0 + 1, Math.ceil((s0 + 2 / p.pps) * rate)), i0 + 800, wave.peaks.length)
          let peak = 0
          for (let i = Math.max(i0, 0); i < i1; i++) if (wave.peaks[i] > peak) peak = wave.peaks[i]
          const h = Math.max(1, (peak / 255) * (MUSIC_H - 6))
          ctx.fillRect(px, mid - h / 2, 1.4, h)
        }
      }
      ctx.font = FONT
      ctx.textAlign = 'left'
      ctx.fillStyle = '#eafff2'
      ctx.fillText('♪ ' + snd.name, Math.max(a, 0) + 6, b.y + MUSIC_H / 2 + 0.5)
      ctx.restore()
    }
    if (!sbars.length) {
      ctx.font = FONT
      ctx.textAlign = 'left'
      ctx.fillStyle = 'rgba(232, 234, 237, 0.34)'
      ctx.fillText('♪  Add sound', cx + 10, MUSIC_TOP + MUSIC_H / 2 + 0.5)
    }

    // The text lane: amber for text, violet for captions.
    const { bars } = layout()
    for (const b of bars) {
      if (b.x1 < -2 || b.x0 > W + 2) continue
      const a = Math.max(b.x0 + 0.5, -4)
      const e = Math.min(b.x1 - 0.5, W + 4)
      const sel = b.t.id === p.selectedTextId
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(a, b.y, Math.max(2, e - a), TEXT_H, 5)
      ctx.fillStyle = b.t.caption
        ? (sel ? 'rgba(186, 150, 255, 0.6)' : 'rgba(186, 150, 255, 0.3)')
        : (sel ? 'rgba(255, 193, 77, 0.62)' : 'rgba(255, 193, 77, 0.3)')
      ctx.fill()
      if (sel) {
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      ctx.clip()
      ctx.font = FONT
      ctx.textAlign = 'left'
      ctx.fillStyle = '#fff'
      ctx.fillText((b.t.caption ? '' : 'T  ') + b.t.text.replace(/\s+/g, ' '), Math.max(a, 0) + 6, b.y + TEXT_H / 2 + 0.5)
      ctx.restore()
    }
    if (!bars.length) {
      ctx.font = FONT
      ctx.textAlign = 'left'
      ctx.fillStyle = 'rgba(232, 234, 237, 0.34)'
      ctx.fillText('T  Add text', cx + 10, TEXT_TOP + TEXT_H / 2 + 0.5)
    }

    // Lane heads at the left edge: a + to add a sound, and one to add text.
    const head = (top, rows, rowH, label, rgb) => {
      ctx.fillStyle = '#050506'
      ctx.fillRect(0, top - 3, GUTTER, rows * rowH + 3)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
      ctx.beginPath(); ctx.moveTo(GUTTER + 0.5, top - 3); ctx.lineTo(GUTTER + 0.5, top + rows * rowH); ctx.stroke()
      // A filled pill in the lane's own colour, so it reads as a button.
      const h = Math.min(rowH - 3, 20)
      ctx.beginPath()
      ctx.roundRect(5, top, GUTTER - 11, h, h / 2)
      ctx.fillStyle = `rgba(${rgb}, 0.9)`
      ctx.fill()
      ctx.fillStyle = '#101114'
      ctx.font = `600 ${h < 18 ? 10 : 11}px Roboto, 'Segoe UI', sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText('+ ' + label, 5 + (GUTTER - 11) / 2, top + h / 2 + 0.5)
      ctx.font = FONT
    }
    head(MUSIC_TOP, SOUND_ROWS, MUSIC_ROW, 'Sound', '94, 200, 140')
    head(TEXT_TOP, textRows(p.texts).count, TEXT_ROW, 'Text', '255, 193, 77')

    // The playhead, fixed in the middle.
    ctx.fillStyle = '#fff'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowBlur = 4
    ctx.fillRect(cx - 1, RULER - 2, 2, HEIGHT - 6 - (RULER - 2))
    ctx.beginPath()
    ctx.arc(cx, RULER - 2, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  }

  useEffect(draw)

  useEffect(() => {
    const c = canvasRef.current
    function onWheel (e) {
      e.preventDefault()
      const p = live.current
      if (e.ctrlKey || e.metaKey) {
        p.onZoom(Math.exp(-e.deltaY * 0.0015))
        return
      }
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      p.onSeek(p.t + (d * 0.6) / p.pps)
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [])

  /** The lane under the pointer while dragging a bar; one past the last starts a new lane. */
  function laneAt (kind, d, e) {
    if (d.edge !== 'move') return undefined
    const p = live.current
    setDims(Boolean(p.compact))
    setLanes(p.sounds)
    const { y } = pos(e)
    const top = kind === 'text' ? TEXT_TOP : MUSIC_TOP
    const row = kind === 'text' ? TEXT_ROW : MUSIC_ROW
    // Counted without the bar being dragged, so the lanes on offer do not
    // grow as it moves down: one past the last is as far as it can go.
    const others = (kind === 'text' ? p.texts : p.sounds || []).filter((x) => x.id !== d.id)
    const count = others.length ? (kind === 'text' ? textRows(others).count : soundRows(others).count) : 0
    return Math.min(Math.max(Math.floor((y - top) / row), 0), count)
  }

  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function onPointerDown (e) {
    if (e.button !== 0) return
    const { x, y } = pos(e)
    const p = live.current
    const hit = hitTest(x, y)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (hit.zone === 'handle') {
      drag.current = { mode: 'trim', id: hit.piece.id, edge: hit.edge, from: hit.piece[hit.edge], x0: e.clientX }
      p.onTrim({ id: hit.piece.id, edge: hit.edge, to: hit.piece[hit.edge], phase: 'start' })
      return
    }
    if (hit.zone === 'move') {
      drag.current = { mode: 'pendingmove', id: hit.piece.id, x0: e.clientX, x, hit: { zone: 'clip', piece: hit.piece } }
      return
    }
    if (hit.zone === 'text') {
      drag.current = { mode: 'text', id: hit.item.id, edge: hit.edge, start: hit.item.start, end: hit.item.end, x0: e.clientX, y0: e.clientY, moved: false }
      p.onText({ id: hit.item.id, phase: 'start' })
      return
    }
    if (hit.zone === 'sound') {
      const sd = hit.snd
      drag.current = { mode: 'sound', id: sd.id, edge: hit.edge, at: sd.at, from: sd.from, len: sd.len, dur: sd.duration, x0: e.clientX, y0: e.clientY, moved: false }
      p.onSound({ id: sd.id, phase: 'start' })
      return
    }
    drag.current = { mode: 'pending', hit, x0: e.clientX, y0: e.clientY, t0: p.t, x }
  }

  function onPointerMove (e) {
    const d = drag.current
    const p = live.current
    if (!d) {
      const { x, y } = pos(e)
      const hit = hitTest(x, y)
      e.currentTarget.style.cursor = hit.zone === 'handle' ? 'ew-resize'
        : hit.zone === 'ruler' || hit.zone === 'addmusic' || hit.zone === 'addtext' || hit.zone === 'join' ? 'pointer'
          : hit.zone === 'sound' ? (hit.edge === 'move' ? 'move' : 'ew-resize')
            : hit.zone === 'text' ? (hit.edge === 'move' ? 'move' : 'ew-resize')
              : hit.zone === 'move' ? 'grab' : 'grab'
      return
    }
    const dx = e.clientX - d.x0
    if (d.mode === 'trim') {
      p.onTrim({ id: d.id, edge: d.edge, to: d.from + dx / p.pps, phase: 'move' })
      return
    }
    if (d.mode === 'text') {
      if (!d.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(e.clientY - d.y0) < DRAG_SLOP) return
      d.moved = true
      p.onText({ id: d.id, ...textSpan(d, dx / p.pps), lane: laneAt('text', d, e), phase: 'move' })
      return
    }
    if (d.mode === 'sound') {
      if (!d.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(e.clientY - d.y0) < DRAG_SLOP) return
      d.moved = true
      p.onSound({ id: d.id, ...soundSpan(d, dx / p.pps), lane: laneAt('sound', d, e), phase: 'move' })
      return
    }
    if (d.mode === 'pendingmove' && Math.abs(dx) > DRAG_SLOP) d.mode = 'reorder'
    if (d.mode === 'reorder') {
      d.x = pos(e).x
      d.to = dropIndex(d.id, d.x)
      e.currentTarget.style.cursor = 'grabbing'
      redraw((n) => n + 1)
      return
    }
    if (d.mode === 'pending' && Math.abs(dx) > DRAG_SLOP) {
      d.mode = 'scrub'
      e.currentTarget.style.cursor = 'grabbing'
    }
    if (d.mode === 'scrub') p.onSeek(d.t0 - dx / p.pps)
  }

  function finish (e, cancelled) {
    const d = drag.current
    drag.current = null
    if (!d) return
    const p = live.current
    if (d.mode === 'trim') {
      p.onTrim({ id: d.id, edge: d.edge, to: d.from + (e.clientX - d.x0) / p.pps, phase: cancelled ? 'cancel' : 'end' })
      return
    }
    if (d.mode === 'sound') {
      if (!d.moved) p.onSound({ id: d.id, phase: 'click' })
      else p.onSound({ id: d.id, ...soundSpan(d, (e.clientX - d.x0) / p.pps), lane: laneAt('sound', d, e), phase: cancelled ? 'cancel' : 'end' })
      return
    }
    if (d.mode === 'text') {
      if (!d.moved) p.onText({ id: d.id, phase: 'click' })
      else p.onText({ id: d.id, ...textSpan(d, (e.clientX - d.x0) / p.pps), lane: laneAt('text', d, e), phase: cancelled ? 'cancel' : 'end' })
      return
    }
    e.currentTarget.style.cursor = 'grab'
    if (d.mode === 'reorder') {
      redraw((n) => n + 1)
      if (!cancelled) p.onReorder?.(d.id, d.to)
      return
    }
    if (d.mode === 'pendingmove') d.mode = 'pending'
    if (d.mode !== 'pending' || cancelled) return
    if (d.hit.zone === 'join') {
      p.onJoin?.(d.hit.k)
    } else if (d.hit.zone === 'addtext') {
      p.onAddText?.()
    } else if (d.hit.zone === 'addmusic') {
      p.onAddMusic?.()
    } else if (d.hit.zone === 'ruler') {
      p.onSeek(p.t + (d.x - size.current.w / 2) / p.pps)
    } else if (d.hit.zone === 'clip') {
      p.onSelect(d.hit.piece.id === p.selectedId ? null : d.hit.piece.id)
    } else {
      p.onSelect(null)
    }
  }

  return (
    <div className={'timeline' + (props.compact ? ' is-compact' : '')} ref={boxRef}>
      <canvas
        ref={canvasRef}
        className="timeline__canvas"
        style={{ height: heightFor(props.texts) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        aria-label="Timeline"
        role="application"
      />
    </div>
  )
}
