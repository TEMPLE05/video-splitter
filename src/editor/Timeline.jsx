import { useEffect, useRef, useState } from 'react'
import { formatClock, lengthOf, offsets as offsetsOf, total as totalOf } from './model.js'

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
const HEIGHT = CLIP_TOP + CLIP_H + 12
const HANDLE = 12
const DRAG_SLOP = 4
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const FONT = "11px Roboto, 'Segoe UI', sans-serif"

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
      c.height = Math.round(HEIGHT * dpr)
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
    return { p, W, cx, X, rects, end: totalOf(p.pieces) }
  }

  function hitTest (x, y) {
    const { p, rects } = layout()
    if (y < CLIP_TOP - 2) return { zone: 'ruler' }
    if (y > CLIP_TOP + CLIP_H + 4) return { zone: 'none' }
    const sel = rects.find((r) => r.piece.id === p.selectedId)
    if (sel) {
      const mid = (sel.x0 + sel.x1) / 2
      if (x >= sel.x0 - 6 && x <= Math.min(sel.x0 + HANDLE + 2, mid)) return { zone: 'handle', edge: 'start', piece: sel.piece }
      if (x <= sel.x1 + 6 && x >= Math.max(sel.x1 - HANDLE - 2, mid)) return { zone: 'handle', edge: 'end', piece: sel.piece }
    }
    const under = rects.find((r) => x >= r.x0 && x < r.x1)
    return under ? { zone: 'clip', piece: under.piece } : { zone: 'none' }
  }

  function draw () {
    const c = canvasRef.current
    const { w: W, dpr } = size.current
    if (!c || !W) return
    const ctx = c.getContext('2d')
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
    const strip = p.strip && !p.strip.none ? p.strip : null
    const tileW = strip ? (strip.frameW * FRAMES_H) / strip.frameH : 0

    for (const { piece, x0, x1 } of rects) {
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

      if (strip && p.stripImg) {
        const from = Math.max(0, Math.floor((-a) / tileW))
        for (let k = from; a + k * tileW < Math.min(b, W); k++) {
          const tx = a + k * tileW
          const src = Math.min(piece.start + (k * tileW + tileW / 2) / p.pps, piece.end)
          const idx = lastAtOrBefore(strip.times, src)
          ctx.drawImage(
            p.stripImg,
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
      if (p.peaks && p.peaks.length) {
        ctx.fillStyle = p.soundOff ? 'rgba(232, 234, 237, 0.18)' : 'rgba(138, 180, 248, 0.8)'
        const mid = wy + WAVE_H / 2
        const rate = p.waveRate
        for (let px = Math.max(a, 0); px < Math.min(b, W); px += 2) {
          const s0 = piece.start + (px - a) / p.pps
          const i0 = Math.floor(s0 * rate)
          const i1 = Math.min(Math.max(i0 + 1, Math.ceil((s0 + 2 / p.pps) * rate)), i0 + 800, p.peaks.length)
          let peak = 0
          for (let i = i0; i < i1; i++) if (p.peaks[i] > peak) peak = p.peaks[i]
          const h = Math.max(1, (peak / 255) * (WAVE_H - 6))
          ctx.fillRect(px, mid - h / 2, 1.4, h)
        }
      } else if (p.peaks === null) {
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

    // The playhead, fixed in the middle.
    ctx.fillStyle = '#fff'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowBlur = 4
    ctx.fillRect(cx - 1, RULER - 2, 2, CLIP_H + (CLIP_TOP - RULER) + 8)
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
    drag.current = { mode: 'pending', hit, x0: e.clientX, y0: e.clientY, t0: p.t, x }
  }

  function onPointerMove (e) {
    const d = drag.current
    const p = live.current
    if (!d) {
      const { x, y } = pos(e)
      const hit = hitTest(x, y)
      e.currentTarget.style.cursor = hit.zone === 'handle' ? 'ew-resize' : hit.zone === 'ruler' ? 'pointer' : 'grab'
      return
    }
    const dx = e.clientX - d.x0
    if (d.mode === 'trim') {
      p.onTrim({ id: d.id, edge: d.edge, to: d.from + dx / p.pps, phase: 'move' })
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
    e.currentTarget.style.cursor = 'grab'
    if (d.mode !== 'pending' || cancelled) return
    if (d.hit.zone === 'ruler') {
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
        style={{ height: HEIGHT }}
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
