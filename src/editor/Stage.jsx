import { useEffect, useRef, useState } from 'react'

import { ASPECTS } from './frame.js'
import { drawText, layoutText } from './text.js'

export { ASPECTS }
const MIN_CROP = 0.06

const contain = (aspect, box) => {
  if (!box.w || !box.h) return { w: 0, h: 0 }
  return box.w / box.h > aspect ? { w: box.h * aspect, h: box.h } : { w: box.w, h: box.w / aspect }
}

/**
 * The picture as the export will frame it.
 *
 * The frame has the canvas shape. Inside it, a window the shape of the
 * cropped video shows just the cropped part, by sizing the videos up and
 * sliding them so the crop sits in the window. Around the window is either
 * black or a blurred copy of the picture, drawn into a tiny canvas that the
 * browser stretches and blurs, which costs next to nothing per frame.
 *
 * In crop mode the whole uncropped frame shows, with the crop box over it.
 */
export default function Stage ({ info, look, cropping, cropRatio, onCrop, pb, src, stillUrl, onClick, loading, texts, selectedTextId, onSelectText, onMoveText }) {
  const boxRef = useRef(null)
  const bgRef = useRef(null)
  const dragRef = useRef(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = boxRef.current
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const W0 = info?.width || 16
  const H0 = info?.height || 9
  const crop = cropping ? null : look.crop
  const vw = W0 * (crop ? crop.w : 1)
  const vh = H0 * (crop ? crop.h : 1)
  const canvasAspect = !cropping && ASPECTS[look.canvas]
  const aspect = canvasAspect || vw / vh
  const frame = contain(aspect, box)
  const win = contain(vw / vh, frame)
  const s = vw ? win.w / vw : 0
  const padded = Boolean(canvasAspect) && Math.abs(vw / vh - canvasAspect) > 0.01
  const blur = look.background !== 'black'
  const videoStyle = {
    width: W0 * s,
    height: H0 * s,
    left: -(crop ? crop.x : 0) * W0 * s,
    top: -(crop ? crop.y : 0) * H0 * s
  }

  // The blurred fill behind a video that does not reach the frame's edges.
  const drawBlur = padded && blur && !pb.still
  useEffect(() => {
    if (!drawBlur) return
    const c = bgRef.current
    const ctx = c.getContext('2d')
    c.width = 48
    c.height = Math.max(8, Math.round(48 / aspect))
    let raf = 0
    function draw () {
      const v = (pb.front === 0 ? pb.aRef : pb.bRef).current
      if (v && v.readyState >= 2 && v.videoWidth) {
        const sx = (crop ? crop.x : 0) * v.videoWidth
        const sy = (crop ? crop.y : 0) * v.videoHeight
        const sw = (crop ? crop.w : 1) * v.videoWidth
        const sh = (crop ? crop.h : 1) * v.videoHeight
        const k = Math.max(c.width / sw, c.height / sh)
        ctx.drawImage(v, sx, sy, sw, sh, (c.width - sw * k) / 2, (c.height - sh * k) / 2, sw * k, sh * k)
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [drawBlur, aspect, crop?.x, crop?.y, crop?.w, crop?.h, pb.front, pb.aRef, pb.bRef])

  /* ------------------------------------------------------ the crop box */

  const c = look.crop || { x: 0, y: 0, w: 1, h: 1 }
  // Width over height of the box in frame fractions, for a locked shape.
  const rn = cropRatio ? (cropRatio * H0) / W0 : null

  function startDrag (e, mode) {
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { mode, x0: e.clientX, y0: e.clientY, c0: c }
  }

  function moveDrag (e) {
    const d = dragRef.current
    if (!d || !frame.w) return
    const dx = (e.clientX - d.x0) / frame.w
    const dy = (e.clientY - d.y0) / frame.h
    const c0 = d.c0
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
    let next
    if (d.mode === 'move') {
      next = { ...c0, x: clamp(c0.x + dx, 0, 1 - c0.w), y: clamp(c0.y + dy, 0, 1 - c0.h) }
    } else if (d.mode.length === 2) {
      // A corner: the opposite corner stays put.
      const sx = d.mode.includes('e') ? 1 : -1
      const sy = d.mode.includes('s') ? 1 : -1
      const ax = sx > 0 ? c0.x : c0.x + c0.w
      const ay = sy > 0 ? c0.y : c0.y + c0.h
      const maxW = sx > 0 ? 1 - ax : ax
      const maxH = sy > 0 ? 1 - ay : ay
      let w = clamp(c0.w + sx * dx, MIN_CROP, maxW)
      let h = rn ? w / rn : clamp(c0.h + sy * dy, MIN_CROP, maxH)
      if (rn && h > maxH) { h = maxH; w = h * rn }
      if (rn && h < MIN_CROP) { h = MIN_CROP; w = h * rn }
      next = { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h }
    } else {
      next = { ...c0 }
      if (d.mode === 'n') { next.y = clamp(c0.y + dy, 0, c0.y + c0.h - MIN_CROP); next.h = c0.y + c0.h - next.y }
      if (d.mode === 's') next.h = clamp(c0.h + dy, MIN_CROP, 1 - c0.y)
      if (d.mode === 'w') { next.x = clamp(c0.x + dx, 0, c0.x + c0.w - MIN_CROP); next.w = c0.x + c0.w - next.x }
      if (d.mode === 'e') next.w = clamp(c0.w + dx, MIN_CROP, 1 - c0.x)
    }
    onCrop(next, 'move')
  }

  function endDrag () {
    if (!dragRef.current) return
    dragRef.current = null
    onCrop(null, 'end')
  }

  const handles = rn ? ['nw', 'ne', 'sw', 'se'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

  return (
    <div className="ed__stage" ref={boxRef} onClick={cropping ? undefined : onClick}>
      <div className="ed__frame" style={{ width: frame.w, height: frame.h }}>
        {drawBlur ? <canvas ref={bgRef} className="ed__bg" /> : null}
        {pb.still && blur ? <img className="ed__bg ed__bg--img" src={stillUrl} alt="" /> : null}
        <div className="ed__window" style={{ width: win.w, height: win.h }}>
          {[pb.aRef, pb.bRef].map((ref, k) => (
            <video
              key={k}
              ref={ref}
              className={'ed__video' + (pb.front === k && !pb.still ? ' is-front' : '')}
              style={videoStyle}
              src={src}
              preload="auto"
              playsInline
              muted
            />
          ))}
        </div>
        {pb.still ? <img className="ed__still" src={stillUrl} alt="" /> : null}
        {!cropping && texts && texts.length ? (
          <TextLayer
            texts={texts}
            t={pb.t}
            width={frame.w}
            height={frame.h}
            selectedId={selectedTextId}
            onSelect={onSelectText}
            onMove={onMoveText}
          />
        ) : null}

        {cropping ? (
          <div className="crop" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <div
              className="crop__box"
              style={{ left: c.x * 100 + '%', top: c.y * 100 + '%', width: c.w * 100 + '%', height: c.h * 100 + '%' }}
              onPointerDown={(e) => startDrag(e, 'move')}
            >
              <span className="crop__grid" />
              {handles.map((h) => (
                <span key={h} className={'crop__h crop__h--' + h} onPointerDown={(e) => startDrag(e, h)} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {loading ? <span className="ed__loading">Opening…</span> : null}
    </div>
  )
}

/**
 * The texts showing at the playhead, drawn with the same code the export uses.
 * Click a text to select it and drag it to move it; a click anywhere else
 * falls through to the picture, which plays and pauses.
 */
export function TextLayer ({ texts, t, width, height, selectedId, onSelect, onMove }) {
  const ref = useRef(null)
  const dragRef = useRef(null)
  const clickedRef = useRef(false)
  const shown = texts.filter((x) => t >= x.start - 1e-6 && t < x.end)

  useEffect(() => {
    const c = ref.current
    if (!c || !width || !height) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== Math.round(width * dpr)) c.width = Math.round(width * dpr)
    if (c.height !== Math.round(height * dpr)) c.height = Math.round(height * dpr)
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    for (const x of shown) {
      const L = drawText(ctx, x, width, height)
      if (x.id === selectedId) {
        ctx.save()
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
        ctx.setLineDash([5, 4])
        ctx.lineWidth = 1.5
        ctx.strokeRect(L.box.x0, L.box.y0, L.box.x1 - L.box.x0, L.box.y1 - L.box.y0)
        ctx.restore()
      }
    }
  })

  function hit (e) {
    const r = ref.current.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const ctx = ref.current.getContext('2d')
    // Topmost first, the one drawn last.
    for (let i = shown.length - 1; i >= 0; i--) {
      const { box } = layoutText(ctx, shown[i], width, height)
      if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return { item: shown[i], x, y }
    }
    return null
  }

  return (
    <canvas
      ref={ref}
      className="ed__texts"
      style={{ width, height }}
      onPointerDown={(e) => {
        const h = hit(e)
        clickedRef.current = Boolean(h)
        if (!h) return
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        onSelect(h.item.id)
        dragRef.current = { id: h.item.id, x0: e.clientX, y0: e.clientY, fx: h.item.x, fy: h.item.y, moved: false }
      }}
      onPointerMove={(e) => {
        const d = dragRef.current
        if (!d) {
          e.currentTarget.style.cursor = hit(e) ? 'move' : 'pointer'
          return
        }
        const dx = (e.clientX - d.x0) / width
        const dy = (e.clientY - d.y0) / height
        if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return
        d.moved = true
        let x = Math.min(Math.max(d.fx + dx, 0), 1)
        const y = Math.min(Math.max(d.fy + dy, 0), 1)
        // Snaps to the middle, where most text belongs.
        if (Math.abs(x - 0.5) < 0.015) x = 0.5
        onMove(d.id, x, y, 'move')
      }}
      onPointerUp={() => {
        const d = dragRef.current
        dragRef.current = null
        if (d && d.moved) onMove(d.id, null, null, 'end')
      }}
      onClick={(e) => { if (clickedRef.current) e.stopPropagation() }}
    />
  )
}
