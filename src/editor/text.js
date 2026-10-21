/**
 * Text on the picture, drawn the same way for the preview and the export.
 *
 * Everything is measured against the finished frame: position as a fraction
 * of its width and height, size as a fraction of its height. The preview
 * draws at screen size, the export at full size, and they come out identical.
 *
 * Animations are a function of the time since the text appeared, so the
 * preview draws them live and the export draws the same moments as a short
 * run of pictures (see textFrames).
 */

import { newId } from './model.js'

export const FONTS = {
  clean: { label: 'Clean', css: (px) => `600 ${px}px 'Segoe UI', Roboto, Arial, sans-serif` },
  heavy: { label: 'Heavy', css: (px) => `${px}px Impact, 'Arial Black', 'Segoe UI Black', sans-serif` },
  black: { label: 'Black', css: (px) => `900 ${px}px 'Segoe UI Black', 'Arial Black', sans-serif` },
  narrow: { label: 'Narrow', css: (px) => `700 ${px}px 'Bahnschrift Condensed', 'Arial Narrow', sans-serif-condensed, sans-serif` },
  serif: { label: 'Serif', css: (px) => `700 ${px}px Georgia, 'Times New Roman', serif` },
  type: { label: 'Type', css: (px) => `700 ${px}px Consolas, 'Courier New', monospace` },
  hand: { label: 'Hand', css: (px) => `700 ${px}px 'Segoe Print', 'Comic Sans MS', cursive` },
  script: { label: 'Script', css: (px) => `700 ${px}px 'Segoe Script', 'Brush Script MT', cursive` }
}

export const STYLES = {
  outline: 'Outline',
  box: 'Box',
  pill: 'Pill',
  marker: 'Marker',
  shadow: 'Shadow',
  lifted: 'Lifted',
  neon: 'Neon',
  hollow: 'Hollow',
  plain: 'Plain'
}

export const ANIMS = {
  none: 'None',
  pop: 'Pop',
  fade: 'Fade',
  rise: 'Rise',
  type: 'Typewriter',
  wobble: 'Wobble',
  bounce: 'Bounce',
  pulse: 'Pulse',
  karaoke: 'Word by word'
}

export const COLORS = ['#ffffff', '#ffe14d', '#ff9f43', '#ff5a5a', '#ff8ad8', '#b18cff', '#8ab4f8', '#5ec88c', '#000000']

export const SIZE_MIN = 0.025
export const SIZE_MAX = 0.14

export function newText (start, end) {
  return { id: newId(), text: 'Your text', start, end, x: 0.5, y: 0.5, size: 0.06, font: 'clean', style: 'outline', color: '#ffffff', anim: 'none' }
}

export const CAPTION_LOOK = { x: 0.5, y: 0.78, size: 0.05, font: 'heavy', style: 'outline', color: '#ffffff', anim: 'none', hl: '#ffe14d' }

const isDark = (hex) => {
  const n = parseInt(String(hex).slice(1), 16)
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.4
}
const contrast = (hex) => (isDark(hex) ? '#ffffff' : '#111111')

/* ---------------------------------------------------------------- layout */

/** Lines of words that fit the frame, keeping the user's own line breaks. */
function wrap (ctx, text, maxW) {
  const lines = []
  let index = 0
  for (const para of String(text).split('\n')) {
    let line = []
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = [...line, word].join(' ')
      if (line.length && ctx.measureText(next).width > maxW) { lines.push(line); line = [word] } else line.push(word)
    }
    lines.push(line)
  }
  // Each word knows its place in the whole text, for word-by-word highlights.
  return lines.map((ws) => ws.map((w) => ({ w, i: index++ })))
}

/** Where a text sits on a W x H frame, and the box it covers, before animation. */
export function layoutText (ctx, t, W, H) {
  const px = Math.max(4, t.size * H)
  ctx.font = (FONTS[t.font] || FONTS.clean).css(px)
  const lines = wrap(ctx, t.text, W * 0.88)
  const space = ctx.measureText(' ').width
  const widths = lines.map((ws) => ctx.measureText(ws.map((x) => x.w).join(' ')).width)
  const lineH = px * 1.2
  const cx = t.x * W
  const cy = t.y * H
  const pad = t.style === 'pill' ? px * 0.6 : px * 0.35
  const half = (Math.max(1, ...widths) / 2) + pad
  const tall = (lines.length * lineH) / 2 + px * (t.style === 'pill' ? 0.3 : 0.15)
  return { px, lines, widths, space, lineH, cx, cy, box: { x0: cx - half, y0: cy - tall, x1: cx + half, y1: cy + tall } }
}

/* -------------------------------------------------------------- animation */

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3)
const easeOutBack = (p) => 1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2)
// Repeatable noise, so a wobble looks the same every time it plays.
const noise = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }
const inLength = (t) => Math.min(0.35, (t.end - t.start) / 2)
const typeLength = (t) => Math.min(1.2, (t.end - t.start) * 0.6)
const WOBBLE_RATE = 8

/** How a text looks `time` seconds after it appears. */
export function animState (t, time) {
  const s = { alpha: 1, scale: 1, dx: 0, dy: 0, rot: 0, chars: Infinity, word: -1 }
  const len = t.end - t.start
  const p = clamp01(time / Math.max(inLength(t), 1e-3))
  switch (t.anim) {
    case 'pop': s.scale = 0.55 + 0.45 * easeOutBack(p); s.alpha = clamp01(p * 2.5); break
    case 'fade': s.alpha = Math.min(p, clamp01((len - time) / Math.max(inLength(t), 1e-3))); break
    case 'rise': s.dy = (1 - easeOutCubic(p)) * 0.05; s.alpha = p; break
    case 'type': s.chars = Math.floor(t.text.length * clamp01(time / typeLength(t))); break
    case 'wobble': {
      // Hand-drawn "boil": a new tiny tilt and nudge eight times a second.
      const k = Math.floor(time * WOBBLE_RATE)
      s.rot = (noise(k) - 0.5) * 0.06
      s.dx = (noise(k + 0.37) - 0.5) * 0.006
      s.dy = (noise(k + 0.71) - 0.5) * 0.006
      break
    }
    case 'bounce': s.dy = -Math.abs(Math.sin(time * Math.PI * 1.5)) * 0.012; break
    case 'pulse': s.scale = 1 + 0.045 * Math.sin(time * Math.PI * 2 * 1.1); break
    case 'karaoke': {
      const at = t.start + time
      const words = t.words || []
      for (let i = 0; i < words.length; i++) if (words[i].a <= at + 1e-6) s.word = i
      break
    }
    default: break
  }
  return s
}

/* ---------------------------------------------------------------- drawing */

/**
 * Draws a text onto a W x H frame. `time` is seconds since it appeared; left
 * out, the text is drawn as it settles.
 */
export function drawText (ctx, t, W, H, time = 1e6) {
  const L = layoutText(ctx, t, W, H)
  const { px, lines, widths, space, lineH, cx, cy } = L
  const a = animState(t, time)
  if (a.alpha <= 0.001) return L

  ctx.save()
  ctx.translate(cx + a.dx * W, cy + a.dy * H)
  if (a.rot) ctx.rotate(a.rot)
  if (a.scale !== 1) ctx.scale(a.scale, a.scale)
  ctx.globalAlpha = a.alpha
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  const top = -((lines.length - 1) * lineH) / 2
  const color = t.color || '#ffffff'
  const ink = t.style === 'pill' || t.style === 'marker' ? contrast(color) : color

  // Backgrounds first, one per line or one for the block.
  if (t.style === 'box') {
    ctx.fillStyle = isDark(color) ? 'rgba(255, 255, 255, 0.92)' : 'rgba(0, 0, 0, 0.62)'
    lines.forEach((ws, i) => {
      if (!ws.length) return
      const w = widths[i] + px * 0.56
      ctx.beginPath()
      ctx.roundRect(-w / 2, top + i * lineH - lineH / 2, w, lineH, px * 0.22)
      ctx.fill()
    })
  } else if (t.style === 'pill') {
    const w = Math.max(...widths) + px * 1.2
    const h = lines.length * lineH + px * 0.6
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(h / 2, px * 0.9))
    ctx.fill()
  } else if (t.style === 'marker') {
    // A highlighter stroke across the lower part of each line, slightly tilted.
    ctx.fillStyle = color
    lines.forEach((ws, i) => {
      if (!ws.length) return
      const w = widths[i] + px * 0.3
      const y = top + i * lineH
      ctx.beginPath()
      ctx.moveTo(-w / 2, y - px * 0.12)
      ctx.lineTo(w / 2, y - px * 0.2)
      ctx.lineTo(w / 2, y + px * 0.42)
      ctx.lineTo(-w / 2, y + px * 0.46)
      ctx.closePath()
      ctx.fill()
    })
  }

  // Then the words, one at a time, so a typewriter can stop mid-word and a
  // caption can light up the word being spoken.
  let chars = 0
  const hl = t.hl || (color.toLowerCase() === '#ffe14d' ? '#5ec88c' : '#ffe14d')
  lines.forEach((ws, i) => {
    let x = -widths[i] / 2
    const y = top + i * lineH
    for (const { w, i: wi } of ws) {
      const room = a.chars - chars
      chars += w.length + 1
      if (room <= 0) return
      const part = room < w.length ? w.slice(0, room) : w
      const lit = a.word === wi
      paint(ctx, part, x, y, px, t.style, lit ? hl : ink, color)
      x += ctx.measureText(w).width + space
    }
  })
  ctx.restore()
  return L
}

function paint (ctx, s, x, y, px, style, fill, color) {
  ctx.save()
  if (style === 'outline') {
    ctx.strokeStyle = isDark(fill) ? '#ffffff' : '#000000'
    ctx.lineWidth = px * 0.17
    ctx.strokeText(s, x, y)
  } else if (style === 'shadow') {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowBlur = px * 0.22
    ctx.shadowOffsetY = px * 0.05
  } else if (style === 'lifted') {
    ctx.fillStyle = isDark(fill) ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.85)'
    ctx.fillText(s, x + px * 0.07, y + px * 0.07)
  } else if (style === 'neon') {
    // A coloured glow around a nearly white tube.
    ctx.shadowColor = color
    ctx.shadowBlur = px * 0.6
    ctx.fillStyle = color
    ctx.fillText(s, x, y)
    ctx.shadowBlur = px * 0.25
    ctx.fillStyle = '#ffffff'
    ctx.fillText(s, x, y)
    ctx.restore()
    return
  } else if (style === 'hollow') {
    ctx.strokeStyle = fill
    ctx.lineWidth = Math.max(1, px * 0.07)
    ctx.strokeText(s, x, y)
    ctx.restore()
    return
  }
  ctx.fillStyle = fill
  ctx.fillText(s, x, y)
  ctx.restore()
}

/* ------------------------------------------------------------------ export */

/**
 * The moments of a text worth drawing for the export, each with the stretch
 * of time it covers. A still text is one picture; a moving one is a short run
 * of them, as many as the movement needs: thirty a second while popping in,
 * eight a second for a hand-drawn wobble, one per letter for a typewriter,
 * one per word for a word-by-word caption.
 */
export function textFrames (t) {
  const len = t.end - t.start
  const out = []
  const push = (a, b, time) => { if (b - a > 1e-4) out.push({ start: t.start + a, end: t.start + Math.min(b, len), time }) }
  const steps = (from, to, step) => { for (let a = from; a < to - 1e-6; a += step) push(a, Math.min(a + step, to), a) }
  const IN = inLength(t)
  switch (t.anim) {
    case 'pop':
    case 'rise':
      steps(0, IN, 1 / 30)
      push(IN, len, IN)
      break
    case 'fade':
      steps(0, IN, 1 / 30)
      push(IN, len - IN, IN)
      steps(len - IN, len, 1 / 30)
      break
    case 'type': {
      const n = t.text.length
      const d = typeLength(t)
      for (let k = 0; k < n; k++) push((d * k) / n, (d * (k + 1)) / n, (d * k) / n + 1e-6)
      push(d, len, d)
      break
    }
    case 'wobble': steps(0, len, 1 / WOBBLE_RATE); break
    case 'bounce':
    case 'pulse': steps(0, len, 1 / 20); break
    case 'karaoke': {
      const cuts = [0, ...(t.words || []).map((w) => w.a - t.start).filter((v) => v > 1e-3 && v < len), len]
      for (let k = 0; k < cuts.length - 1; k++) push(cuts[k], cuts[k + 1], cuts[k] + 1e-6)
      break
    }
    default: push(0, len, len)
  }
  return out
}

/* ---------------------------------------------------------------- captions */

/**
 * Groups words into short captions, a few at a time, the way phone apps show
 * them: a new caption at a full stop, after a pause, or when the line gets
 * long. Gaps under a third of a second are closed so captions do not flicker.
 * Each caption keeps its words' timings, for the word-by-word highlight.
 */
export function captionChunks (words, { maxWords = 4, maxChars = 22, maxGap = 0.6 } = {}) {
  const out = []
  let cur = null
  for (const w of words) {
    if (cur) {
      const longer = cur.text + ' ' + w.w
      if (cur.words.length >= maxWords || longer.length > maxChars || w.a - cur.end > maxGap || /[.!?]$/.test(cur.text)) {
        out.push(cur)
        cur = null
      }
    }
    if (!cur) cur = { text: w.w, start: w.a, end: w.b, words: [{ w: w.w, a: w.a, b: w.b }] }
    else { cur.text += ' ' + w.w; cur.end = w.b; cur.words.push({ w: w.w, a: w.a, b: w.b }) }
  }
  if (cur) out.push(cur)
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]
    if (next && next.start - out[i].end < 0.35) out[i].end = next.start
    if (out[i].end - out[i].start < 0.3) out[i].end = Math.min(out[i].start + 0.3, next ? next.start : Infinity)
    if (next && out[i].end > next.start) out[i].end = next.start
  }
  return out.filter((c) => c.end > c.start)
}

/**
 * Keeps word timings sensible after the words are edited: the same number of
 * words keeps the heard timings; otherwise the caption's time is shared out
 * by word length.
 */
export function retimeWords (old, text, start, end) {
  const ws = String(text).split(/\s+/).filter(Boolean)
  if (old && old.length === ws.length) return ws.map((w, i) => ({ ...old[i], w }))
  const weights = ws.map((w) => w.length + 1)
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  let a = start
  return ws.map((w, i) => {
    const b = a + ((end - start) * weights[i]) / sum
    const out = { w, a, b }
    a = b
    return out
  })
}

/** Moves and stretches word timings along with their caption. */
export function rescaleWords (words, from, to) {
  if (!words) return words
  const k = (to.end - to.start) / Math.max(1e-6, from.end - from.start)
  const map = (v) => to.start + (v - from.start) * k
  return words.map((w) => ({ ...w, a: map(w.a), b: map(w.b) }))
}
