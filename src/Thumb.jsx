import { useEffect, useRef, useState } from 'react'

/**
 * Library thumbnails, loaded under a strict cap.
 *
 * Browsers open at most six connections to one server. A thumbnail that has
 * not been rendered yet holds its connection while FFmpeg works, so letting the
 * browser lazy-load images natively meant a fresh folder could tie up all six
 * and every click waited behind them: measured at 1.5 s for a tiny request.
 *
 * Here no more than three thumbnails are ever in flight, which always leaves
 * three connections free for everything else. Cards that scroll away before
 * their turn are dropped from the queue rather than fetched for nothing.
 */
const MAX_IN_FLIGHT = 3
let active = 0
const waiting = []

function pump () {
  while (active < MAX_IN_FLIGHT && waiting.length) {
    const job = waiting.shift()
    if (job.cancelled) continue
    active++
    let settled = false
    const img = new Image()
    img.decoding = 'async'
    const finish = (ok) => {
      if (settled) return
      settled = true
      active--
      job.done(ok)
      pump()
    }
    img.onload = () => finish(true)
    img.onerror = () => finish(false)
    img.src = job.src
  }
}

function enqueue (src, done) {
  const job = { src, done, cancelled: false }
  waiting.push(job)
  pump()
  return () => { job.cancelled = true }
}

/**
 * Shows `src` once its turn comes and it is near the screen. Until then, and if
 * it fails, renders `fallback` instead.
 */
export default function Thumb ({ src, className, fallback = null }) {
  const holder = useRef(null)
  const [state, setState] = useState('idle')

  useEffect(() => {
    setState('idle')
    const el = holder.current
    if (!el || !src) return
    let cancel = null
    let started = false

    const io = new IntersectionObserver((entries) => {
      const near = entries.some((e) => e.isIntersecting)
      if (near && !started) {
        started = true
        cancel = enqueue(src, (ok) => setState(ok ? 'ready' : 'failed'))
      } else if (!near && started && cancel) {
        // Scrolled away before its turn: give the slot to something visible.
        cancel()
        started = false
        cancel = null
      }
    }, { rootMargin: '240px 0px' })

    io.observe(el)
    return () => {
      io.disconnect()
      if (cancel) cancel()
    }
  }, [src])

  if (state === 'failed') return fallback
  return (
    <span ref={holder} className="thumbhold">
      {state === 'ready' ? <img className={className} src={src} alt="" decoding="async" /> : null}
    </span>
  )
}
