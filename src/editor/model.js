/**
 * The edit, as CapCut models it: an ordered list of pieces, each pointing at a
 * stretch of the source clip. The timeline plays them back to back, so
 * deleting one closes the gap and the finished video is simply the pieces in
 * order.
 *
 * Two clocks matter. Source time is a position in the original file. Timeline
 * time is a position in the edit, where only kept pieces exist. Everything the
 * user sees on the ruler is timeline time.
 *
 * Every function here returns a new list, never edits one in place, which is
 * what makes undo a matter of keeping old lists.
 */

// Random rather than counted: saved edits come back with their own ids, and a
// counter restarting at 1 would hand out ones already in use.
export const newId = () => 'p' + Math.random().toString(36).slice(2, 10)

export const lengthOf = (p) => p.end - p.start

/**
 * A picture piece holds a still for its length. It keeps start and end like a
 * video piece, so every operation here works on it unchanged, but only the
 * difference means anything: it has no place in the source clip.
 */
export const isImage = (p) => p && p.kind === 'image'
export const MAX_STILL = 600

export function imagePiece (media, length) {
  return { id: newId(), kind: 'image', image: media.id, name: media.name, start: 0, end: length }
}

/** Puts a piece after the one with id `afterId`, or at the end. */
export function insertAfter (pieces, piece, afterId) {
  const at = afterId ? pieces.findIndex((p) => p.id === afterId) : -1
  if (at < 0) return [...pieces, piece]
  return [...pieces.slice(0, at + 1), piece, ...pieces.slice(at + 1)]
}

export const total = (pieces) => pieces.reduce((sum, p) => sum + lengthOf(p), 0)

export function initial (duration) {
  return [{ id: newId(), start: 0, end: duration }]
}

/** Timeline time at which each piece begins. */
export function offsets (pieces) {
  const out = []
  let acc = 0
  for (const p of pieces) {
    out.push(acc)
    acc += lengthOf(p)
  }
  return out
}

/** The piece under timeline time `t`, where it begins, and the source time there. */
export function locate (pieces, t) {
  let acc = 0
  for (let i = 0; i < pieces.length; i++) {
    const len = lengthOf(pieces[i])
    if (t < acc + len || i === pieces.length - 1) {
      const into = Math.min(Math.max(t - acc, 0), len)
      return { index: i, offset: acc, source: pieces[i].start + into }
    }
    acc += len
  }
  return { index: 0, offset: 0, source: 0 }
}

/** Timeline time of a source moment inside a given piece. */
export function timelineAt (pieces, index, source) {
  const p = pieces[index]
  return offsets(pieces)[index] + Math.min(Math.max(source - p.start, 0), lengthOf(p))
}

/** Splits the piece under `t`. Null when the cut would leave a sliver. */
export function splitAt (pieces, t, min) {
  const { index, source } = locate(pieces, t)
  const p = pieces[index]
  if (source - p.start < min || p.end - source < min) return null
  return [
    ...pieces.slice(0, index),
    { id: newId(), start: p.start, end: source },
    { id: newId(), start: source, end: p.end },
    ...pieces.slice(index + 1)
  ]
}

/** Removes a piece; the rest close up behind it. The last piece cannot go. */
export function removePiece (pieces, id) {
  if (pieces.length <= 1) return null
  const next = pieces.filter((p) => p.id !== id)
  return next.length === pieces.length ? null : next
}

/**
 * Moves one edge of a piece to a new source time. Pieces are independent
 * stretches of the source, so an edge can move anywhere inside the original
 * clip, as in CapCut, as long as the piece stays at least `min` long.
 */
export function trimPiece (pieces, id, edge, to, duration, min) {
  // `duration` may be a function giving the length of each piece's own clip.
  const lenOf = (p) => (typeof duration === 'function' ? duration(p) : duration)
  return pieces.map((p) => {
    if (p.id !== id) return p
    // A still has no source to run out of, so either edge just sets its length.
    if (isImage(p)) {
      if (edge === 'start') return { ...p, start: Math.min(Math.max(to, p.end - MAX_STILL), p.end - min) }
      return { ...p, end: Math.max(Math.min(to, p.start + MAX_STILL), p.start + min) }
    }
    if (edge === 'start') return { ...p, start: Math.min(Math.max(to, 0), p.end - min) }
    return { ...p, end: Math.max(Math.min(to, lenOf(p)), p.start + min) }
  })
}

/**
 * Cuts the clip into `n` equal parts. Starts from the trimmed span if the edit
 * is still one piece, otherwise from the whole clip, so the result is always
 * exactly `n` parts each covering one unbroken stretch of the source.
 */
export function splitEvenly (pieces, n, duration, min) {
  const span = pieces.length === 1 ? pieces[0] : { start: 0, end: duration }
  const len = span.end - span.start
  if (!(n >= 2) || len / n < min) return null
  return Array.from({ length: n }, (_, k) => ({
    id: newId(),
    start: span.start + (len * k) / n,
    end: k === n - 1 ? span.end : span.start + (len * (k + 1)) / n
  }))
}

/**
 * True when piece `i` carries straight on from piece `i - 1` in the same clip,
 * with a plain cut, so playback can simply keep going.
 */
export function continuesFrom (pieces, i, frame) {
  return i > 0 && !isImage(pieces[i]) && !isImage(pieces[i - 1]) && !pieces[i].transition &&
    (pieces[i].src || null) === (pieces[i - 1].src || null) &&
    Math.abs(pieces[i].start - pieces[i - 1].end) < frame / 2
}

export const TRANSITIONS = {
  fade: 'Fade', black: 'Black', white: 'White', slide: 'Slide', wipe: 'Wipe', zoom: 'Zoom', circle: 'Circle', blur: 'Blur'
}

/**
 * Where each transition plays on the timeline. Must match the server, which
 * renders them: a transition borrows footage from beyond the cut, half from
 * each side, or all from one side when the other has none (a clip's very
 * first frame, say). The edit keeps its length either way.
 * `durationOf(piece)` is the length of the clip a piece comes from.
 */
export function transitionWindows (pieces, durationOf) {
  const offs = offsets(pieces)
  const room = (q, side) => (isImage(q) ? Infinity : side === 'after' ? Math.max(0, durationOf(q) - q.end) : Math.max(0, q.start))
  return pieces.map((p, k) => {
    const t = p.transition
    if (k === 0 || !t || !TRANSITIONS[t.type]) return null
    const A = pieces[k - 1]
    const lenA = lengthOf(A)
    const lenB = lengthOf(p)
    const d = Math.min(Number(t.d) || 0, 4, lenA / 2 + lenB / 2)
    const roomA = Math.min(room(A, 'after'), lenA / 2)
    const roomB = Math.min(room(p, 'before'), lenB / 2)
    let eB = Math.min(d / 2, roomB)
    const eA = Math.min(d - eB, roomA)
    eB = Math.min(d - eA, roomB)
    if (!(eA + eB >= 0.08)) return null
    return { type: t.type, eA, eB, from: offs[k] - eB, to: offs[k] + eA }
  })
}

export function formatClock (seconds, withFraction = false) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  // Whole hundredths first: 0.3 * 100 is 29.999…, which flooring turns into .29.
  const cs = withFraction ? Math.round(seconds * 100) : Math.floor(seconds) * 100
  const m = Math.floor(cs / 6000)
  const s = Math.floor(cs / 100) % 60
  const base = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
  if (!withFraction) return base
  return base + '.' + String(cs % 100).padStart(2, '0')
}

/** Accepts "1:15", "1:15.5", "75" or "75.5". Null if it makes no sense. */
export function parseClock (text) {
  const raw = String(text).trim()
  if (!raw) return null
  if (raw.includes(':')) {
    const bits = raw.split(':')
    if (bits.length !== 2) return null
    const m = Number(bits[0])
    const s = Number(bits[1])
    if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0 || s < 0 || s >= 60) return null
    return m * 60 + s
  }
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}
