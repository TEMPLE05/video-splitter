import { useEffect, useRef, useState } from 'react'
import { continuesFrom, isImage, lengthOf, locate, offsets, total, transitionWindows } from './model.js'
import { videoUrl } from '../api.js'

/**
 * Plays the edit rather than the file: piece after piece, skipping whatever
 * was deleted, holding pictures for their length, blending through
 * transitions, with any added song running underneath in step.
 *
 * Two video elements take turns. While one plays a piece, the other is
 * already parked on the first frame of the next piece that needs a jump,
 * possibly in another clip, so the jump is a swap rather than a seek and there
 * is no stall at the cut. During a transition both play at once: the outgoing
 * piece runs on past its cut while the incoming one starts early, exactly as
 * the export overlaps them, and the stage blends the two.
 *
 * The engine sets each element's file itself, so the stage never passes a
 * src. Both stay in the layout (unseen ones are transparent), because
 * browsers stop decoding media that is display:none.
 *
 * Layers the stage draws: 'v0' and 'v1' (the videos), 'still' (the picture
 * on screen) and 'still2' (an incoming picture during a transition).
 */
export default function usePlayback (list, committed, fps, { videoMuted, musicMuted, sounds, mainId, durationOf }) {
  const aRef = useRef(null)
  const bRef = useRef(null)
  // One audio element per added sound, registered by the editor as it renders them.
  const audios = useRef(new Map())
  const registerAudio = (id, el) => {
    if (el) { audios.current.set(id, el); el.muted = mutedSongsRef.current } else audios.current.delete(id)
  }
  const el = (k) => (k === 0 ? aRef : bRef).current

  const listRef = useRef(list)
  listRef.current = list
  const durRef = useRef(durationOf)
  durRef.current = durationOf
  const mainRef = useRef(mainId)
  mainRef.current = mainId
  const mutedRef = useRef(videoMuted)
  mutedRef.current = videoMuted
  const soundsRef = useRef(sounds || [])
  soundsRef.current = sounds || []
  const mutedSongsRef = useRef(musicMuted)
  mutedSongsRef.current = musicMuted

  const curRef = useRef(0)
  const tRef = useRef(0)
  const playingRef = useRef(false)
  const rafRef = useRef(0)
  const showRef = useRef('v0')
  const lastVidRef = useRef(0)
  const srcIds = useRef([null, null])
  const pendingSeek = useRef([null, null])
  const imgClock = useRef({ t0: 0, at: 0 })
  const mixRef = useRef(null)
  const songOn = useRef(new Map())

  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [layer, setLayerState] = useState('v0')
  const [srcs, setSrcs] = useState([null, null])
  const [still, setStill] = useState(null)
  const [still2, setStill2] = useState(null)
  const [mix, setMix] = useState(null)

  const frame = 1 / (fps || 30)
  const srcOf = (p) => p.src || mainRef.current
  const windows = (L) => transitionWindows(L, (p) => durRef.current(p))

  function setTime (T) {
    tRef.current = T
    setT(T)
  }

  function setLayer (l) {
    showRef.current = l
    if (l[0] === 'v') lastVidRef.current = Number(l[1])
    setLayerState(l)
  }

  const showingVideo = () => (showRef.current[0] === 'v' ? Number(showRef.current[1]) : null)
  /** The element not on screen, free to be parked on what comes next. */
  const freeEl = () => {
    const s = showingVideo()
    return s === null ? 1 - lastVidRef.current : 1 - s
  }

  /** Puts element k on a moment of a clip, loading the clip first if needed. */
  function cue (k, srcId, time) {
    const v = el(k)
    if (!v || !srcId) return
    const at = Math.max(0, time)
    if (srcIds.current[k] !== srcId) {
      srcIds.current[k] = srcId
      setSrcs([...srcIds.current])
      pendingSeek.current[k] = at
      v.addEventListener('loadedmetadata', () => {
        if (srcIds.current[k] === srcId && pendingSeek.current[k] !== null) {
          v.currentTime = pendingSeek.current[k]
          pendingSeek.current[k] = null
        }
      }, { once: true })
      v.src = videoUrl(srcId)
      return
    }
    if (pendingSeek.current[k] !== null) { pendingSeek.current[k] = at; return }
    if (Math.abs(v.currentTime - at) > frame / 2) v.currentTime = at
  }

  const playEl = (k, volume = 1) => {
    const v = el(k)
    if (!v) return
    v.muted = mutedRef.current
    v.volume = volume
    v.play().catch(() => {})
  }
  const stopEl = (k) => {
    const v = el(k)
    if (!v) return
    v.pause()
    v.muted = true
    v.volume = 1
  }

  /** Timeline time of what is on screen right now. */
  function timeNow () {
    const L = listRef.current
    const offs = offsets(L)
    const mx = mixRef.current
    if (mx) {
      const B = L[mx.k]
      if (B && mx.inLayer[0] === 'v') return offs[mx.k] + (el(Number(mx.inLayer[1])).currentTime - B.start)
      return mx.from + (performance.now() - mx.clock) / 1000
    }
    const i = Math.min(curRef.current, L.length - 1)
    const p = L[i]
    if (!p) return tRef.current
    if (isImage(p)) return imgClock.current.at + (performance.now() - imgClock.current.t0) / 1000
    const s = showingVideo()
    const v = s === null ? null : el(s)
    if (!v) return tRef.current
    return offs[i] + (v.currentTime - p.start)
  }

  const now = () => (playingRef.current ? Math.min(Math.max(timeNow(), 0), total(listRef.current)) : tRef.current)

  /**
   * Keeps every added sound where the edit says it should be: playing from
   * the right moment while the playhead is over it, quiet otherwise.
   */
  function syncSong (T, force) {
    const live = new Set()
    for (const snd of soundsRef.current) {
      live.add(snd.id)
      const el = audios.current.get(snd.id)
      if (!el) continue
      const on = songOn.current.get(snd.id) === snd.url
      const inside = playingRef.current && T >= snd.at && T < snd.at + snd.len - 0.03
      if (!inside) {
        if (on) { el.pause(); songOn.current.delete(snd.id) }
        continue
      }
      const target = snd.from + (T - snd.at)
      el.volume = Math.min(1, Math.max(0, snd.volume))
      if (!on) {
        el.currentTime = target
        el.play().catch(() => {})
        songOn.current.set(snd.id, snd.url)
      } else if (force || Math.abs(el.currentTime - target) > 0.3) {
        el.currentTime = target
      }
    }
    // A removed sound stops.
    for (const id of [...songOn.current.keys()]) {
      if (!live.has(id)) { audios.current.get(id)?.pause(); songOn.current.delete(id) }
    }
  }

  /** Parks the free element on the next place playback will have to jump to. */
  function prepare (k) {
    const L = listRef.current
    const W = windows(L)
    let j = k
    while (j < L.length && (isImage(L[j]) || (continuesFrom(L, j, frame) && !W[j]))) j++
    if (j >= L.length) return
    cue(freeEl(), srcOf(L[j]), L[j].start - (W[j] ? W[j].eB : 0))
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
    el(0)?.pause()
    el(1)?.pause()
    syncSong(T)
    setTime(T)
  }

  /** A hard cut into piece j, which starts now. */
  function enter (j) {
    const L = listRef.current
    const p = L[j]
    curRef.current = j
    const s = showingVideo()
    if (isImage(p)) {
      if (s !== null) stopEl(s)
      setStill(p.image)
      setLayer('still')
      imgClock.current = { t0: performance.now(), at: offsets(L)[j] }
      prepare(j + 1)
      return
    }
    if (s !== null && continuesFrom(L, j, frame)) return
    const e = freeEl()
    cue(e, srcOf(p), p.start)
    playEl(e)
    if (s !== null) stopEl(s)
    setLayer('v' + e)
    setStill(null)
    prepare(j + 1)
  }

  /** The two sides of transition k, set up at timeline time T. */
  function mixAt (L, k, w, T, live) {
    const offs = offsets(L)
    const A = L[k - 1]
    const B = L[k]
    let outLayer
    let inLayer
    const outEl = showingVideo() ?? lastVidRef.current
    if (isImage(A)) {
      setStill(A.image)
      outLayer = 'still'
    } else {
      // When live, the outgoing video is already playing where it should be.
      if (!live) cue(outEl, srcOf(A), A.start + (T - offs[k - 1]))
      outLayer = 'v' + outEl
    }
    if (isImage(B)) {
      setStill2(B.image)
      inLayer = 'still2'
    } else {
      const e = outLayer[0] === 'v' ? 1 - outEl : freeEl()
      cue(e, srcOf(B), B.start + (T - offs[k]))
      inLayer = 'v' + e
    }
    const m = Math.min(1, Math.max(0, (T - w.from) / (w.to - w.from)))
    mixRef.current = { k, from: w.from, to: w.to, type: w.type, outLayer, inLayer, clock: performance.now() - (T - w.from) * 1000 }
    setMix({ type: w.type, m, outLayer, inLayer })
    return mixRef.current
  }

  function startMix (k, w, T) {
    const mx = mixAt(listRef.current, k, w, T, true)
    if (mx.inLayer[0] === 'v') playEl(Number(mx.inLayer[1]), 0)
  }

  function updateMix (T) {
    const mx = mixRef.current
    const m = Math.min(1, Math.max(0, (T - mx.from) / (mx.to - mx.from)))
    if (!mutedRef.current) {
      if (mx.outLayer[0] === 'v') el(Number(mx.outLayer[1])).volume = 1 - m
      if (mx.inLayer[0] === 'v') el(Number(mx.inLayer[1])).volume = m
    }
    setMix((cur) => (cur ? { ...cur, m } : cur))
  }

  function endMix (T) {
    const mx = mixRef.current
    mixRef.current = null
    const L = listRef.current
    const B = L[mx.k]
    if (mx.outLayer[0] === 'v') stopEl(Number(mx.outLayer[1]))
    if (mx.inLayer === 'still2') {
      setStill(B.image)
      setStill2(null)
      setLayer('still')
      imgClock.current = { t0: performance.now(), at: T }
    } else {
      const e = Number(mx.inLayer[1])
      const v = el(e)
      if (v) v.volume = 1
      setLayer('v' + e)
      setStill(null)
      setStill2(null)
    }
    curRef.current = mx.k
    setMix(null)
    prepare(mx.k + 1)
  }

  function tick () {
    rafRef.current = 0
    if (!playingRef.current) return
    const L = listRef.current
    if (!L.length) { pause(); return }
    const W = windows(L)
    const offs = offsets(L)
    const end = total(L)
    let T = timeNow()

    if (mixRef.current) {
      if (T >= mixRef.current.to - 1e-3) endMix(T)
      else updateMix(T)
    } else {
      const i = curRef.current
      const p = L[i]
      const w = i + 1 < L.length ? W[i + 1] : null
      if (w && T >= w.from) {
        startMix(i + 1, w, T)
      } else if (!w) {
        const s = showingVideo()
        const v = s === null ? null : el(s)
        const done = isImage(p)
          ? T >= offs[i] + lengthOf(p) - 1e-3
          : !v || v.currentTime >= p.end - frame * 0.25 || v.ended
        if (done) {
          if (i >= L.length - 1) { pause(end); return }
          enter(i + 1)
        }
      }
    }

    T = Math.min(Math.max(timeNow(), 0), end)
    syncSong(T)
    setTime(T)
    rafRef.current = requestAnimationFrame(tick)
  }

  /** Shows the frame at timeline time T without playing, transitions included. */
  function show (L, T) {
    const W = windows(L)
    const k = W.findIndex((w) => w && T >= w.from && T < w.to)
    if (k > 0) {
      curRef.current = k - 1
      mixAt(L, k, W[k], T, false)
      return
    }
    mixRef.current = null
    setMix(null)
    setStill2(null)
    const { index, source } = locate(L, T)
    curRef.current = index
    const p = L[index]
    if (isImage(p)) {
      setStill(p.image)
      setLayer('still')
      return
    }
    const e = showingVideo() ?? lastVidRef.current
    cue(e, srcOf(p), source)
    setLayer('v' + e)
    setStill(null)
  }

  function play () {
    const L = listRef.current
    if (!L.length || !el(0)) return
    let T = tRef.current
    if (T >= total(L) - frame / 2) T = 0
    el(0).pause()
    el(1).pause()
    show(L, T)
    playingRef.current = true
    setPlaying(true)
    setTime(T)
    const mx = mixRef.current
    if (mx) {
      if (mx.outLayer[0] === 'v') playEl(Number(mx.outLayer[1]), 1)
      if (mx.inLayer[0] === 'v') playEl(Number(mx.inLayer[1]), 0)
      updateMix(T)
    } else if (isImage(L[curRef.current])) {
      imgClock.current = { t0: performance.now(), at: T }
      prepare(curRef.current + 1)
    } else {
      const s = showingVideo()
      const v = el(s)
      v.muted = mutedRef.current
      v.volume = 1
      v.play().catch(() => { if (playingRef.current) pause() })
      prepare(curRef.current + 1)
    }
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

  /** Shows a moment of a piece's clip without moving the playhead, for trimming. */
  function peek (piece, source) {
    if (playingRef.current) pause()
    mixRef.current = null
    setMix(null)
    setStill(null)
    setStill2(null)
    const e = showingVideo() ?? lastVidRef.current
    cue(e, srcOf(piece), source)
    setLayer('v' + e)
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
    const mx = mixRef.current
    const s = showingVideo()
    if (s !== null && el(s)) el(s).muted = videoMuted
    if (mx && mx.inLayer[0] === 'v') el(Number(mx.inLayer[1])).muted = videoMuted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoMuted])

  useEffect(() => {
    for (const el of audios.current.values()) el.muted = musicMuted
  }, [musicMuted])

  // A new sound, a moved one or a removed one takes effect at once if playing.
  const soundKey = (sounds || []).map((x) => [x.id, x.url, x.at, x.from, x.len, x.volume].join(':')).join('|')
  useEffect(() => {
    if (playingRef.current) syncSong(timeNow(), true)
    else syncSong(tRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundKey])

  useEffect(() => stopLoop, [])

  return {
    aRef,
    bRef,
    registerAudio,
    t,
    playing,
    layer,
    srcs,
    still,
    still2,
    mix,
    // The video on screen, for the blurred background to copy.
    front: layer[0] === 'v' ? Number(layer[1]) : (mix && mix.inLayer[0] === 'v' ? Number(mix.inLayer[1]) : lastVidRef.current),
    play,
    pause,
    toggle,
    seek,
    peek,
    now,
    setTime
  }
}
