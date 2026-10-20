import { useEffect, useRef, useState } from 'react'
import { continuesFrom, isImage, locate, offsets, total } from './model.js'

/**
 * Plays the edit rather than the file: piece after piece, skipping whatever
 * was deleted, holding pictures for their length, with any added song running
 * underneath in step.
 *
 * Two video elements take turns. While one plays a piece, the other is already
 * parked on the first frame of the next piece that does not simply carry on
 * from this one, so the jump is a swap rather than a seek and there is no
 * stall at the cut. Pieces that continue straight on in the source need no
 * swap at all. A picture piece pauses both and runs on the wall clock.
 *
 * Both elements stay in the layout (one is just transparent), because browsers
 * stop decoding media that is display:none.
 */
export default function usePlayback (list, committed, fps, { videoMuted, musicMuted, music }) {
  const aRef = useRef(null)
  const bRef = useRef(null)
  const audioRef = useRef(null)
  const vid = (k) => (k === 0 ? aRef : bRef).current

  const listRef = useRef(list)
  listRef.current = list
  const mutedRef = useRef(videoMuted)
  mutedRef.current = videoMuted
  const musicRef = useRef(music)
  musicRef.current = music

  const activeRef = useRef(0)
  const curRef = useRef(0)
  const tRef = useRef(0)
  const playingRef = useRef(false)
  const rafRef = useRef(0)
  const clockRef = useRef(0)
  const stillRef = useRef(null)
  const songOnRef = useRef(false)
  const songUrlRef = useRef(null)

  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [front, setFront] = useState(0)
  const [still, setStill] = useState(null)

  const frame = 1 / (fps || 30)

  function setTime (T) {
    tRef.current = T
    setT(T)
  }

  function showStill (p) {
    const v = isImage(p) ? p.image : null
    if (stillRef.current !== v) {
      stillRef.current = v
      setStill(v)
    }
  }

  /** Timeline time of what is on screen right now. */
  function liveTime () {
    const L = listRef.current
    const i = Math.min(curRef.current, L.length - 1)
    const p = L[i]
    if (!p) return tRef.current
    const len = p.end - p.start
    let into
    if (isImage(p)) {
      into = (performance.now() - clockRef.current) / 1000
    } else {
      const v = vid(activeRef.current)
      if (!v) return tRef.current
      into = v.currentTime - p.start
    }
    return offsets(L)[i] + Math.min(Math.max(into, 0), len)
  }

  const now = () => (playingRef.current ? liveTime() : tRef.current)

  /** Keeps the added song where the edit says it should be. */
  function syncSong (T, force) {
    const a = audioRef.current
    const m = musicRef.current
    if (!a) return
    // A different song has a fresh element state: it is not playing yet.
    if ((m?.url || null) !== songUrlRef.current) {
      songUrlRef.current = m?.url || null
      songOnRef.current = false
    }
    const target = m ? T + m.offset : -1
    const inside = m && playingRef.current && target >= 0 && target < (m.duration || Infinity) - 0.05
    if (!inside) {
      if (songOnRef.current) { a.pause(); songOnRef.current = false }
      return
    }
    a.volume = Math.min(1, Math.max(0, m.volume))
    if (!songOnRef.current) {
      a.currentTime = target
      a.play().catch(() => {})
      songOnRef.current = true
    } else if (force || Math.abs(a.currentTime - target) > 0.3) {
      a.currentTime = target
    }
  }

  /** Parks the idle element on the next place playback will have to jump to. */
  function prepare (k) {
    const L = listRef.current
    const standby = vid(1 - activeRef.current)
    if (!standby) return
    let j = k
    while (j < L.length && (isImage(L[j]) || continuesFrom(L, j, frame))) j++
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
    syncSong(T)
    setTime(T)
  }

  /** Moves playback into piece j, which starts now. */
  function enter (j) {
    const L = listRef.current
    const p = L[j]
    curRef.current = j
    if (isImage(p)) {
      vid(activeRef.current)?.pause()
      showStill(p)
      clockRef.current = performance.now()
      prepare(j + 1)
      return
    }
    showStill(null)
    if (continuesFrom(L, j, frame)) return
    const k = 1 - activeRef.current
    const w = vid(k)
    const v = vid(activeRef.current)
    if (Math.abs(w.currentTime - p.start) > frame / 2) w.currentTime = p.start
    w.muted = mutedRef.current
    w.play().catch(() => {})
    v.pause()
    v.muted = true
    activeRef.current = k
    setFront(k)
    prepare(j + 1)
  }

  function tick () {
    rafRef.current = 0
    if (!playingRef.current) return
    const L = listRef.current
    const i = curRef.current
    const p = L[i]
    const v = vid(activeRef.current)
    if (!p || !v) { pause(); return }

    const done = isImage(p)
      ? (performance.now() - clockRef.current) / 1000 >= p.end - p.start
      : v.currentTime >= p.end - frame * 0.25 || v.ended
    if (done) {
      if (i >= L.length - 1) {
        pause(total(L))
        return
      }
      enter(i + 1)
    }

    const T = liveTime()
    syncSong(T)
    setTime(T)
    rafRef.current = requestAnimationFrame(tick)
  }

  /** Shows the frame at timeline time T without playing. */
  function show (L, T) {
    const { index, offset, source } = locate(L, T)
    curRef.current = index
    const p = L[index]
    if (isImage(p)) {
      showStill(p)
      return { p, into: T - offset }
    }
    showStill(null)
    const v = vid(activeRef.current)
    if (v && Math.abs(v.currentTime - source) > 1e-3) v.currentTime = source
    return { p, into: T - offset }
  }

  function play () {
    const L = listRef.current
    const v = vid(activeRef.current)
    if (!L.length || !v) return
    let T = tRef.current
    if (T >= total(L) - frame / 2) T = 0
    const other = vid(1 - activeRef.current)
    if (other) { other.pause(); other.muted = true }
    const { p, into } = show(L, T)
    playingRef.current = true
    setPlaying(true)
    setTime(T)
    if (isImage(p)) {
      clockRef.current = performance.now() - into * 1000
    } else {
      v.muted = mutedRef.current
      v.play().catch(() => { if (playingRef.current) pause() })
    }
    prepare(curRef.current + 1)
    syncSong(T, true)
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick)
  }

  const toggle = () => (playingRef.current ? pause() : play())

  /** Moves the playhead to a timeline time and shows that frame. */
  function seek (T, L = listRef.current) {
    if (playingRef.current) pause()
    if (!L.length) return
    show(L, T)
    setTime(T)
  }

  /** Shows a source frame without moving the playhead, for trimming. */
  function peek (source) {
    if (playingRef.current) pause()
    showStill(null)
    const v = vid(activeRef.current)
    if (v) v.currentTime = source
  }

  // Any committed edit stops playback and re-shows the frame under the
  // playhead, since a delete or an undo can put different footage there.
  useEffect(() => {
    if (!committed || !committed.length) return
    if (playingRef.current) pause()
    const T = Math.min(Math.max(tRef.current, 0), total(committed))
    show(committed, T)
    setTime(T)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed])

  useEffect(() => {
    const v = vid(activeRef.current)
    if (v) v.muted = videoMuted
  }, [videoMuted])

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = musicMuted
  }, [musicMuted])

  // A new song, a slid one or a removed one takes effect at once if playing.
  useEffect(() => {
    if (playingRef.current) syncSong(liveTime(), true)
    else syncSong(tRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [music?.url, music?.offset, music?.volume])

  useEffect(() => stopLoop, [])

  return { aRef, bRef, audioRef, t, playing, front, still, play, pause, toggle, seek, peek, now, setTime }
}
