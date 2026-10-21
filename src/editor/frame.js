// The finished frame's shape and size. Must match ASPECTS and frameSize on
// the server, which renders the export, so text drawn here lands in place.
export const ASPECTS = { '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9, '3:4': 3 / 4 }

const even = (n) => Math.max(2, Math.round(n / 2) * 2)

export function frameSize (info, look) {
  const crop = look.crop
  const vw = info.width * (crop ? crop.w : 1)
  const vh = info.height * (crop ? crop.h : 1)
  const A = ASPECTS[look.canvas]
  let W = vw
  let H = vh
  if (A && vw / vh > A + 0.01) H = vw / A
  else if (A && vw / vh < A - 0.01) W = vh * A
  const scale = Math.min(1, 1920 / Math.max(W, H))
  return { W: even(W * scale), H: even(H * scale) }
}
