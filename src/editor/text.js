/**
 * Text on the picture, drawn the same way for the preview and the export.
 *
 * Everything is measured against the finished frame: position as a fraction
 * of its width and height, size as a fraction of its height. The preview
 * draws at screen size, the export at full size, and they come out identical.
 */

import { newId } from './model.js'

export const FONTS = {
  clean: { label: 'Clean', css: (px) => `600 ${px}px 'Segoe UI', Roboto, Arial, sans-serif` },
  heavy: { label: 'Heavy', css: (px) => `${px}px Impact, 'Arial Black', 'Segoe UI Black', sans-serif` },
  serif: { label: 'Serif', css: (px) => `700 ${px}px Georgia, 'Times New Roman', serif` },
  type: { label: 'Type', css: (px) => `700 ${px}px Consolas, 'Courier New', monospace` },
  hand: { label: 'Hand', css: (px) => `700 ${px}px 'Segoe Print', 'Comic Sans MS', cursive` }
}

export const STYLES = {
  outline: 'Outline',
  box: 'Box',
  shadow: 'Shadow',
  plain: 'Plain'
}

export const COLORS = ['#ffffff', '#ffe14d', '#ff5a5a', '#ff8ad8', '#8ab4f8', '#5ec88c', '#000000']

export const SIZE_MIN = 0.025
export const SIZE_MAX = 0.14

export function newText (start, end) {
  return { id: newId(), text: 'Your text', start, end, x: 0.5, y: 0.5, size: 0.06, font: 'clean', style: 'outline', color: '#ffffff' }
}

export const CAPTION_LOOK = { x: 0.5, y: 0.78, size: 0.05, font: 'heavy', style: 'outline', color: '#ffffff' }

const isDark = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.4
}

/** Breaks the text into lines that fit, keeping the user's own line breaks. */
function wrap (ctx, text, maxW) {
  const lines = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + word : word
      if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word } else line = next
    }
    lines.push(line)
  }
  return lines
}

/** Where a text sits on a W x H frame, and the box it covers. */
export function layoutText (ctx, t, W, H) {
  const px = Math.max(4, t.size * H)
  ctx.font = (FONTS[t.font] || FONTS.clean).css(px)
  const lines = wrap(ctx, t.text, W * 0.88)
  const widths = lines.map((l) => ctx.measureText(l).width)
  const lineH = px * 1.2
  const cx = t.x * W
  const cy = t.y * H
  const half = (Math.max(1, ...widths) / 2) + px * 0.35
  const tall = (lines.length * lineH) / 2 + px * 0.15
  return { px, lines, widths, lineH, cx, cy, box: { x0: cx - half, y0: cy - tall, x1: cx + half, y1: cy + tall } }
}

export function drawText (ctx, t, W, H) {
  const L = layoutText(ctx, t, W, H)
  const { px, lines, widths, lineH, cx, cy } = L
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  const top = cy - ((lines.length - 1) * lineH) / 2
  const dark = isDark(t.color)

  if (t.style === 'box') {
    // One rounded band per line, the way TikTok draws its text boxes.
    ctx.fillStyle = dark ? 'rgba(255, 255, 255, 0.92)' : 'rgba(0, 0, 0, 0.62)'
    lines.forEach((line, i) => {
      if (!line) return
      const w = widths[i] + px * 0.56
      ctx.beginPath()
      ctx.roundRect(cx - w / 2, top + i * lineH - lineH / 2, w, lineH, px * 0.22)
      ctx.fill()
    })
  }
  if (t.style === 'shadow') {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowBlur = px * 0.22
    ctx.shadowOffsetY = px * 0.05
  }
  lines.forEach((line, i) => {
    const y = top + i * lineH
    if (t.style === 'outline') {
      ctx.strokeStyle = dark ? '#ffffff' : '#000000'
      ctx.lineWidth = px * 0.17
      ctx.strokeText(line, cx, y)
    }
    ctx.fillStyle = t.color
    ctx.fillText(line, cx, y)
  })
  ctx.restore()
  return L
}

/**
 * Groups words into short captions, a few at a time, the way phone apps show
 * them: a new caption at a full stop, after a pause, or when the line gets
 * long. Gaps under a third of a second are closed so captions do not flicker.
 */
export function captionChunks (words, { maxWords = 4, maxChars = 22, maxGap = 0.6 } = {}) {
  const out = []
  let cur = null
  for (const w of words) {
    if (cur) {
      const longer = cur.text + ' ' + w.w
      if (cur.n >= maxWords || longer.length > maxChars || w.a - cur.end > maxGap || /[.!?]$/.test(cur.text)) {
        out.push(cur)
        cur = null
      }
    }
    if (!cur) cur = { text: w.w, start: w.a, end: w.b, n: 1 }
    else { cur.text += ' ' + w.w; cur.end = w.b; cur.n++ }
  }
  if (cur) out.push(cur)
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]
    if (next && next.start - out[i].end < 0.35) out[i].end = next.start
    if (out[i].end - out[i].start < 0.3) out[i].end = Math.min(out[i].start + 0.3, next ? next.start : Infinity)
    if (next && out[i].end > next.start) out[i].end = next.start
  }
  return out.filter((c) => c.end > c.start).map((c) => ({ text: c.text, start: c.start, end: c.end }))
}
