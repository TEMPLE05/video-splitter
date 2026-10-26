/**
 * Speed, as the editor sets it on a piece: a steady speed, or a ramp from one
 * speed to another across the piece (slow then fast), with the voice kept or
 * let go high and low, and optional smooth slow motion. The maths matches
 * src/editor/model.js, which shows the same edit in the preview.
 *
 * With speed v(u) = a + (b - a)u over L seconds of footage, the time it takes
 * to play the footage up to u is the integral of L / v, which has a closed
 * form, so the picture is retimed exactly. Sound cannot follow a curve in one
 * filter, so a ramp's sound is played in short steps, each at its own steady
 * speed, which sounds the same.
 */
export const SPEED_MIN = 0.1
export const SPEED_MAX = 10

const clamp = (v) => Math.min(Math.max(Number(v) || 1, SPEED_MIN), SPEED_MAX)
const n6 = (v) => Number(v).toFixed(6)

/** The speed settings of a piece from a request, or null at normal speed. */
export function cleanSpeed (seg) {
  if (!seg || (seg.speed == null && seg.speedEnd == null)) return null
  const a = clamp(seg.speed ?? 1)
  const b = seg.speedEnd != null ? clamp(seg.speedEnd) : a
  if (a === 1 && b === 1) return null
  return { a, b, pitch: seg.pitch === 'shift' ? 'shift' : 'keep', smooth: Boolean(seg.smooth) && Math.min(a, b) < 1 }
}

/** Timeline seconds to play u of L seconds of footage ramping from a to b. */
export const spanOf = (L, a, b, u = 1) => (Math.abs(b - a) < 1e-6 ? (L * u) / a : (L / (b - a)) * Math.log((a + (b - a) * u) / a))

/** How long a video piece lasts in the edit. */
export const playedLength = (p) => (p.speed ? spanOf(p.end - p.start, p.speed.a, p.speed.b) : p.end - p.start)

/**
 * The setpts filter that retimes a piece's picture, given how much footage
 * the input has before the piece (borrowed for a transition, in source
 * seconds). Empty at normal speed.
 */
export function pictureSpeed (p, before) {
  const sp = p.speed
  if (!sp) return ''
  if (sp.a === sp.b) return `setpts=(PTS-STARTPTS)/${n6(sp.a)},`
  const L = p.end - p.start
  const X = '((PTS-STARTPTS)*TB)'
  const Bt = before / sp.a
  const T = spanOf(L, sp.a, sp.b)
  const K = L / (sp.b - sp.a)
  const R = (sp.b - sp.a) / L
  // Before the piece at its first speed, through it on the curve, after it at its last.
  const e = `if(lt(${X},${n6(before)}),${X}/${n6(sp.a)},` +
    `if(lt(${X},${n6(before + L)}),${n6(Bt)}+${n6(K)}*log((${n6(sp.a)}+${n6(R)}*(${X}-${n6(before)}))/${n6(sp.a)}),` +
    `${n6(Bt + T)}+(${X}-${n6(before + L)})/${n6(sp.b)}))`
  return `setpts='(${e})/TB',`
}

/** Made-up in-between frames for smooth slow motion; empty when not asked for. */
export const smoothFrames = (p, fps) => (p.speed && p.speed.smooth ? `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,` : '')

/** One steady change of speed for sound at `rate` samples a second. */
function tempo (k, pitch, rate) {
  if (Math.abs(k - 1) < 1e-4) return 'anull'
  if (pitch === 'shift') return `asetrate=${Math.max(1000, Math.round(rate * k))},aresample=${rate}`
  // atempo takes 0.5 to 2 at a time on older FFmpeg, so bigger changes chain.
  const parts = []
  let r = k
  while (r > 2) { parts.push(2); r /= 2 }
  while (r < 0.5) { parts.push(0.5); r /= 0.5 }
  parts.push(r)
  return parts.map((x) => `atempo=${n6(x)}`).join(',')
}

/**
 * Filter text that plays a piece's sound at its speed. `input` is the sound
 * already in the wanted format; `before` and `after` are footage beyond the
 * piece in source seconds. Returns the text, ending at `output`.
 */
export function soundSpeed (p, input, output, before, after, rate, tag) {
  const sp = p.speed
  if (!sp) return `${input}anull${output}`
  if (sp.a === sp.b) return `${input}${tempo(sp.a, sp.pitch, rate)}${output}`
  // Steps: the footage before at the first speed, the ramp in pieces of
  // about a quarter second each, the footage after at the last speed.
  const L = p.end - p.start
  const T = spanOf(L, sp.a, sp.b)
  const n = Math.min(60, Math.max(4, Math.ceil(T / 0.25)))
  const steps = []
  if (before > 0.001) steps.push({ s0: 0, s1: before, k: sp.a })
  // Equal timeline steps, so each one's footage follows from the curve.
  const srcAt = (t) => (Math.abs(sp.b - sp.a) < 1e-6 ? t * sp.a : (sp.a * (Math.exp((t * (sp.b - sp.a)) / L) - 1)) / (sp.b - sp.a)) * L
  for (let i = 0; i < n; i++) {
    const t0 = (T * i) / n
    const t1 = (T * (i + 1)) / n
    const s0 = srcAt(t0)
    const s1 = i === n - 1 ? L : srcAt(t1)
    steps.push({ s0: before + s0, s1: before + s1, k: (s1 - s0) / (t1 - t0) })
  }
  if (after > 0.001) steps.push({ s0: before + L, s1: before + L + after, k: sp.b })
  const labels = steps.map((_, j) => `[sp${tag}_${j}]`)
  const outs = steps.map((_, j) => `[sq${tag}_${j}]`)
  const parts = [`${input}asetpts=PTS-STARTPTS,asplit=${steps.length}${labels.join('')}`]
  steps.forEach((st, j) => {
    parts.push(`${labels[j]}atrim=start=${n6(st.s0)}:end=${n6(st.s1)},asetpts=PTS-STARTPTS,${tempo(st.k, sp.pitch, rate)}${outs[j]}`)
  })
  parts.push(`${outs.join('')}concat=n=${steps.length}:v=0:a=1${output}`)
  return parts.join(';')
}

/** How far into a piece, on the timeline, a moment of its footage plays. */
export function intoOf (p, source) {
  const sp = p.speed
  if (!sp) return source - p.start
  const L = p.end - p.start
  if (source <= p.start) return (source - p.start) / sp.a
  if (source >= p.end) return spanOf(L, sp.a, sp.b) + (source - p.end) / sp.b
  return spanOf(L, sp.a, sp.b, (source - p.start) / L)
}
