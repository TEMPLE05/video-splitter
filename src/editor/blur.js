import { newId } from './model.js'

/**
 * Blurs: an area of the picture made unreadable for a stretch of the edit, a
 * number plate or a name, say. Each sits on the timeline beside the texts
 * (an item with `kind: 'blur'`), so it slides, stretches, changes lane and
 * copies exactly as a text does.
 *
 * Its shape is drawn once: a box, an oval, or pencil strokes painted over the
 * area. The strokes are kept relative to the area's own box, so the box can
 * move and change size and the shape follows. Where the area is comes from
 * its spots: one spot keeps it in place; with more, marked at different
 * moments, it glides from each to the next.
 *
 *   { kind: 'blur', shape: 'pencil' | 'box' | 'oval', strokes: [{ r, pts: [[x, y], ...] }],
 *     spots: [{ t, x, y, w, h }], strength: 0..1, start, end, lane }
 *
 * Spot times count from the blur's start, so moving it on the timeline takes
 * its spots along. Boxes are fractions of the finished frame. Once a spot is
 * marked (`moving`), moving the area marks another spot rather than moving
 * the whole blur.
 */
export const isBlur = (x) => Boolean(x && x.kind === 'blur')

export const BLUR_SHAPES = { pencil: 'Pencil', box: 'Box', oval: 'Oval' }

/** How strong a blur is, as a fraction of the frame's height (a CSS blur radius). */
export const blurRadius = (strength) => 0.004 + 0.036 * Math.min(Math.max(strength ?? 0.5, 0), 1)

export function newBlur (start, end, shape, box, strokes) {
  return { id: newId(), kind: 'blur', text: 'Blur', shape, strokes: strokes || [], spots: [{ t: 0, ...box }], strength: 0.5, start, end }
}

const lerp = (a, b, k) => a + (b - a) * k

/** Where the area is at timeline time t: at its spot, or part way between two. */
export function spotAt (b, t) {
  const s = b.spots
  const at = t - b.start
  if (s.length === 1 || at <= s[0].t) return s[0]
  for (let i = 1; i < s.length; i++) {
    if (at <= s[i].t) {
      const k = (at - s[i - 1].t) / Math.max(1e-6, s[i].t - s[i - 1].t)
      const p = s[i - 1]
      const q = s[i]
      return { t: at, x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k), w: lerp(p.w, q.w, k), h: lerp(p.h, q.h, k) }
    }
  }
  return s[s.length - 1]
}

/**
 * The blur with its area moved to `box` at timeline time t. With one spot the
 * whole blur moves; with marked spots, the spot at that moment changes, or a
 * new one is marked there, as CapCut does with keyframes.
 */
export function placeAt (b, t, box) {
  const at = Math.min(Math.max(t - b.start, 0), b.end - b.start)
  if (!b.moving) return { ...b, spots: [{ ...box, t: 0 }] }
  return markSpot(b, at, box)
}

/** Adds a spot at `at` seconds into the blur (or replaces the one there). */
export function markSpot (b, at, box) {
  const near = b.spots.findIndex((s) => Math.abs(s.t - at) < 0.05)
  // The box may be a spot itself; its own time must not win.
  const spot = { x: box.x, y: box.y, w: box.w, h: box.h, t: near >= 0 ? b.spots[near].t : at }
  const spots = near >= 0 ? b.spots.map((s, i) => (i === near ? spot : s)) : [...b.spots, spot].sort((p, q) => p.t - q.t)
  return { ...b, moving: true, spots }
}

export function removeSpot (b, index) {
  // The last spot going means it stays put again.
  if (b.spots.length <= 1) return { ...b, moving: undefined, spots: [{ ...b.spots[0], t: 0 }] }
  return { ...b, spots: b.spots.filter((_, i) => i !== index) }
}

/**
 * The bounding box of pencil strokes, in frame fractions, and the strokes
 * made relative to it. A stroke's thickness, `r`, is a fraction of the
 * frame's height.
 */
export function fitStrokes (strokes, aspect) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of strokes) {
    const rx = s.r / aspect
    for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x - rx); x1 = Math.max(x1, x + rx)
      y0 = Math.min(y0, y - s.r); y1 = Math.max(y1, y + s.r)
    }
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1)
  const w = Math.max(0.01, x1 - x0)
  const h = Math.max(0.01, y1 - y0)
  const local = strokes.map((s) => ({ rx: s.r / aspect / w, ry: s.r / h, pts: s.pts.map(([x, y]) => [(x - x0) / w, (y - y0) / h]) }))
  return { box: { x: x0, y: y0, w, h }, strokes: local }
}

/**
 * Pencil strokes added to a blur that already has some: everything is put
 * back into frame terms at the area as it is at time t, refitted, and every
 * spot keeps its own place and size relative to the new box.
 */
export function addStrokes (b, t, frameStrokes, aspect) {
  const at = spotAt(b, t)
  const old = (b.strokes || []).map((s) => ({
    r: s.ry * at.h,
    pts: s.pts.map(([x, y]) => [at.x + x * at.w, at.y + y * at.h])
  }))
  const fit = fitStrokes([...old, ...frameStrokes], aspect)
  // The new box, in the old box's own terms, applied to every spot.
  const lx = (fit.box.x - at.x) / at.w
  const ly = (fit.box.y - at.y) / at.h
  const lw = fit.box.w / at.w
  const lh = fit.box.h / at.h
  const spots = b.spots.map((s) => ({ t: s.t, x: s.x + lx * s.w, y: s.y + ly * s.h, w: lw * s.w, h: lh * s.h }))
  return { ...b, strokes: fit.strokes, spots }
}

// Mask pictures are drawn on a square of this size, with room round the
// shape for a soft edge, and stretched over the area wherever it is.
const MASK = 256
const PAD = 10
const masks = new Map()

/** Draws a blur's shape, white on transparent, into a MASK x MASK canvas. */
function drawShape (ctx, b) {
  const s = MASK - PAD * 2
  ctx.clearRect(0, 0, MASK, MASK)
  ctx.save()
  ctx.filter = 'blur(4px)'
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
  ctx.translate(PAD, PAD)
  if (b.shape === 'oval') {
    ctx.beginPath()
    ctx.ellipse(s / 2, s / 2, s / 2, s / 2, 0, 0, Math.PI * 2)
    ctx.fill()
  } else if (b.shape === 'pencil' && b.strokes && b.strokes.length) {
    ctx.scale(s, s)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const st of b.strokes) {
      // A round brush stretched with the box: drawn in a space squeezed to
      // make its width and height match the stroke's own.
      ctx.save()
      ctx.scale(1, st.ry / st.rx)
      ctx.lineWidth = st.rx * 2
      ctx.beginPath()
      st.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, (y * st.rx) / st.ry) : ctx.moveTo(x, (y * st.rx) / st.ry)))
      if (st.pts.length === 1) ctx.lineTo(st.pts[0][0] + 1e-4, (st.pts[0][1] * st.rx) / st.ry)
      ctx.stroke()
      ctx.restore()
    }
  } else {
    ctx.fillRect(0, 0, s, s)
  }
  ctx.restore()
}

const shapeKey = (b) => b.shape + (b.shape === 'pencil' ? JSON.stringify(b.strokes) : '')

/** The shape as a canvas, drawn once per shape and kept. */
export function maskCanvas (b) {
  const key = shapeKey(b)
  let m = masks.get(key)
  if (!m) {
    const c = document.createElement('canvas')
    c.width = MASK
    c.height = MASK
    drawShape(c.getContext('2d'), b)
    m = { canvas: c, url: null }
    if (masks.size > 60) masks.clear()
    masks.set(key, m)
  }
  return m
}

/** The shape as a picture for a CSS mask over the area. */
export function maskUrl (b) {
  const m = maskCanvas(b)
  if (!m.url) m.url = m.canvas.toDataURL('image/png')
  return m.url
}

/**
 * Where the shape lands in the frame for an area box: the mask canvas has a
 * margin, so its picture covers a little more than the box.
 */
export function maskRect (box) {
  const k = MASK / (MASK - PAD * 2)
  const w = box.w * k
  const h = box.h * k
  return { x: box.x - (w - box.w) / 2, y: box.y - (h - box.h) / 2, w, h }
}

/**
 * Mask pictures for the export, white where to blur on black, at a quarter of
 * the frame's size (FFmpeg stretches them, which only softens the edge). A
 * blur that stays put is one picture; a moving one is redrawn 15 times a
 * second. `at` and `len` are the part of the edit being exported.
 */
export function blurMasks (b, W, H) {
  const w = Math.max(16, Math.round(W / 4))
  const h = Math.max(16, Math.round(H / 4))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  const shape = maskCanvas(b).canvas
  const draw = (box) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    const r = maskRect(box)
    ctx.drawImage(shape, r.x * w, r.y * h, r.w * w, r.h * h)
    return c.toDataURL('image/png')
  }
  if (b.spots.length === 1) return [{ start: b.start, end: b.end, png: draw(b.spots[0]) }]
  const len = b.end - b.start
  const fps = Math.min(15, 900 / Math.max(len, 0.1))
  const n = Math.max(1, Math.ceil(len * fps))
  const out = []
  for (let i = 0; i < n; i++) {
    const a = b.start + (len * i) / n
    const e = b.start + (len * (i + 1)) / n
    out.push({ start: a, end: e, png: draw(spotAt(b, (a + e) / 2)) })
  }
  return out
}
