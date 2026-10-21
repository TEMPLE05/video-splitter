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
const FRAMES_H = 50
const WAVE_H = 26
const CLIP_H = FRAMES_H + WAVE_H
const MUSIC_TOP = CLIP_TOP + CLIP_H + 8
const MUSIC_H = 24
const TEXT_TOP = MUSIC_TOP + MUSIC_H + 6
const TEXT_H = 20
const TEXT_ROW = TEXT_H + 3
const MAX_ROWS = 3
const HANDLE = 12
const DRAG_SLOP = 4
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const FONT = "11px Roboto, 'Segoe UI', sans-serif"

/** Texts stacked into rows so overlapping ones sit one above the other. */
function textRows (texts) {
  const ends = []
  const rows = new Map()
  for (const t of [...(texts || [])].sort((a, b) => a.start - b.start)) {
    let r = ends.findIndex((e) => e <= t.start + 1e-6)
    if (r < 0) { r = ends.length; ends.push(0) }
    ends[r] = t.end
    rows.set(t.id, Math.min(r, MAX_ROWS - 1))
  }
  return { rows, count: Math.max(1, Math.min(MAX_ROWS, ends.length)) }
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
    // The song lane: the song's time at timeline time T is T + offset, so it
    // begins at -offset and runs for its own length, shown within the edit.
    let song = null
    if (p.music) {
      const from = Math.max(0, -p.music.offset)
      const to = Math.min(end, (p.music.duration || Infinity) - p.music.offset)
      if (to > from) song = { x0: X(from), x1: X(to), from, to }
    }
    const { rows } = textRows(p.texts)
    const bars = (p.texts || []).map((t) => ({
      t,
      x0: X(t.start),
      x1: X(t.end),
      y: TEXT_TOP + (rows.get(t.id) || 0) * TEXT_ROW
    }))
    return { p, W, cx, X, rects, end, song, bars }
  }

  function dropIndex (id, x) {
    const { rects } = layout()
    return rects.filter((r) => r.piece.id !== id && (r.x0 + r.x1) / 2 < x).length
  }

  function hitTest (x, y) {
    const { p, rects, song, bars } = layout()
    if (y < CLIP_TOP - 2) return { zone: 'ruler' }
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
    if (y >= MUSIC_TOP - 3 && y <= MUSIC_TOP + MUSIC_H + 3) {
      if (p.music && song && x >= song.x0 - 4 && x <= song.x1 + 4) return { zone: 'music' }
      return p.music ? { zone: 'none' } : { zone: 'addmusic' }
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

    // The song lane.
    const { song } = layout()
    if (p.music && song) {
      const a = Math.max(song.x0, -4)
      const b = Math.min(song.x1, W + 4)
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(a, MUSIC_TOP, b - a, MUSIC_H, 6)
      ctx.clip()
      ctx.fillStyle = p.musicDragging ? 'rgba(94, 200, 140, 0.42)' : 'rgba(94, 200, 140, 0.26)'
      ctx.fillRect(a, MUSIC_TOP, b - a, MUSIC_H)
      if (p.music.peaks && p.music.peaks.length) {
        ctx.fillStyle = 'rgba(160, 235, 190, 0.85)'
        const mid = MUSIC_TOP + MUSIC_H / 2
        const rate = p.music.rate || 50
        for (let px = Math.max(a, 0); px < Math.min(b, W); px += 2) {
          const s0 = p.t + (px - cx) / p.pps + p.music.offset
          const i0 = Math.floor(s0 * rate)
          const i1 = Math.min(Math.max(i0 + 1, Math.ceil((s0 + 2 / p.pps) * rate)), i0 + 800, p.music.peaks.length)
          let peak = 0
          for (let i = Math.max(i0, 0); i < i1; i++) if (p.music.peaks[i] > peak) peak = p.music.peaks[i]
          const h = Math.max(1, (peak / 255) * (MUSIC_H - 6))
          ctx.fillRect(px, mid - h / 2, 1.4, h)
        }
      }
      ctx.font = FONT
      ctx.textAlign = 'left'
      ctx.fillStyle = '#eafff2'
      ctx.fillText('♪ ' + p.music.name, Math.max(a, 0) + 8, MUSIC_TOP + MUSIC_H / 2 + 0.5)
      ctx.restore()
    } else if (!p.music) {
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
      drag.current = { mode: 'text', id: hit.item.id, edge: hit.edge, start: hit.item.start, end: hit.item.end, x0: e.clientX, moved: false }
      p.onText({ id: hit.item.id, phase: 'start' })
      return
    }
    if (hit.zone === 'music') {
      drag.current = { mode: 'music', from: p.music.offset, x0: e.clientX }
      p.onMusic({ offset: p.music.offset, phase: 'start' })
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
          : hit.zone === 'music' ? 'move'
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
      if (!d.moved && Math.abs(dx) < DRAG_SLOP) return
      d.moved = true
      p.onText({ id: d.id, ...textSpan(d, dx / p.pps), phase: 'move' })
      return
    }
    // Dragging the song right makes it start later, so less of it has played.
    if (d.mode === 'music') {
      p.onMusic({ offset: d.from - dx / p.pps, phase: 'move' })
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
    if (d.mode === 'music') {
      p.onMusic({ offset: d.from - (e.clientX - d.x0) / p.pps, phase: cancelled ? 'cancel' : 'end' })
      return
    }
    if (d.mode === 'text') {
      if (!d.moved) p.onText({ id: d.id, phase: 'click' })
      else p.onText({ id: d.id, ...textSpan(d, (e.clientX - d.x0) / p.pps), phase: cancelled ? 'cancel' : 'end' })
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
    <div className="timeline" ref={boxRef}>
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
