import { useEffect, useRef, useState } from 'react'
import { continuesFrom, locate, offsets, total } from './model.js'

/**
 * Plays the edit rather than the file: piece after piece, skipping whatever
 * was deleted.
 *
 * Two video elements take turns. While one plays a piece, the other is already
 * parked on the first frame of the next piece that does not simply carry on
 * from this one, so the jump is a swap rather than a seek and there is no
 * stall at the cut. Pieces that continue straight on in the source need no
 * swap at all.
 *
 * Both elements stay in the layout (one is just transparent), because browsers
 * stop decoding media that is display:none.
 */
export default function usePlayback (list, committed, fps, muted) {
  const aRef = useRef(null)
  const bRef = useRef(null)
  const vid = (k) => (k === 0 ? aRef : bRef).current

  const listRef = useRef(list)
  listRef.current = list
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  const activeRef = useRef(0)
  const curRef = useRef(0)
  const tRef = useRef(0)
  const playingRef = useRef(false)
  const rafRef = useRef(0)

  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [front, setFront] = useState(0)

  const frame = 1 / (fps || 30)

  function setTime (T) {
    tRef.current = T
    setT(T)
  }

  /** Timeline time of what the active element is showing right now. */
  function liveTime () {
    const L = listRef.current
    const i = Math.min(curRef.current, L.length - 1)
    const p = L[i]
    const v = vid(activeRef.current)
    if (!p || !v) return tRef.current
    const into = Math.min(Math.max(v.currentTime - p.start, 0), p.end - p.start)
    return offsets(L)[i] + into
  }

  const now = () => (playingRef.current ? liveTime() : tRef.current)

  /** Parks the idle element on the next place playback will have to jump to. */
  function prepare (k) {
    const L = listRef.current
    const standby = vid(1 - activeRef.current)
    if (!standby) return
    let j = k
    while (j < L.length && continuesFrom(L, j, frame)) j++
    if (j >= L.length) return
    if (Math.abs(standby.currentTime - L[j].start) > frame / 2) standby.currentTime = L[j].start
  }

  function stopLoop () {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
  }

  function pause (at) {
    const T = at ?? now()
    playingRef.current = false
    setPlaying(false)
    stopLoop()
    vid(0)?.pause()
    vid(1)?.pause()
    setTime(T)
  }

  function tick () {
    rafRef.current = 0
    if (!playingRef.current) return
    const L = listRef.current
    const v = vid(activeRef.current)
    const i = curRef.current
    const p = L[i]
    if (!v || !p) { pause(); return }

    if (v.currentTime >= p.end - frame * 0.25 || v.ended) {
      if (i >= L.length - 1) {
        pause(total(L))
        return
      }
      const j = i + 1
      curRef.current = j
      if (!continuesFrom(L, j, frame)) {
        const k = 1 - activeRef.current
        const w = vid(k)
        if (Math.abs(w.currentTime - L[j].start) > frame / 2) w.currentTime = L[j].start
        w.muted = mutedRef.current
        w.play().catch(() => {})
        v.pause()
        v.muted = true
        activeRef.current = k
        setFront(k)
        prepare(j + 1)
      }
    }

    setTime(liveTime())
    rafRef.current = requestAnimationFrame(tick)
  }

  function play () {
    const L = listRef.current
    const v = vid(activeRef.current)
    if (!L.length || !v) return
    let T = tRef.current
    if (T >= total(L) - frame / 2) T = 0
    const { index, source } = locate(L, T)
    curRef.current = index
    if (Math.abs(v.currentTime - source) > frame / 2) v.currentTime = source
    const other = vid(1 - activeRef.current)
    if (other) { other.pause(); other.muted = true }
    v.muted = mutedRef.current
    prepare(index + 1)
    playingRef.current = true
    setPlaying(true)
    setTime(T)
    v.play().catch(() => { if (playingRef.current) pause() })
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick)
  }

  const toggle = () => (playingRef.current ? pause() : play())

  /** Moves the playhead to a timeline time and shows that frame. */
  function seek (T, L = listRef.current) {
    if (playingRef.current) pause()
    if (!L.length) return
    const { index, source } = locate(L, T)
    curRef.current = index
    const v = vid(activeRef.current)
    if (v) v.currentTime = source
    setTime(T)
  }

  /** Shows a source frame without moving the playhead, for trimming. */
  function peek (source) {
    if (playingRef.current) pause()
    const v = vid(activeRef.current)
    if (v) v.currentTime = source
  }

  // Any committed edit stops playback and re-shows the frame under the
  // playhead, since a delete or an undo can put different footage there.
  useEffect(() => {
    if (!committed || !committed.length) return
    if (playingRef.current) pause()
    const T = Math.min(Math.max(tRef.current, 0), total(committed))
    const { index, source } = locate(committed, T)
    curRef.current = index
    const v = vid(activeRef.current)
    if (v && Math.abs(v.currentTime - source) > 1e-3) v.currentTime = source
    setTime(T)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed])

  useEffect(() => {
    const v = vid(activeRef.current)
    if (v) v.muted = muted
  }, [muted])

  useEffect(() => stopLoop, [])

  return { aRef, bRef, t, playing, front, play, pause, toggle, seek, peek, now, setTime }
}
