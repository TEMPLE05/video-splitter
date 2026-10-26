import { newId } from './editor/model.js'
import { useEffect, useRef, useState } from 'react'
import Timeline from './editor/Timeline.jsx'
import Stage, { ASPECTS } from './editor/Stage.jsx'
import { CAPTION_LOOK, animsOf, captionChunks, layoutText, newText, rescaleWords, retimeWords } from './editor/text.js'
import { frameSize } from './editor/frame.js'
import { loadFonts } from './editor/fonts.js'

/** The look of one caption, to copy onto others or save in a look. */
const captionStyleOf = (c) => ({ x: c.x, y: c.y, size: c.size, font: c.font, style: c.style, color: c.color, ...animsOf(c), hl: c.hl })
import { BlurPanel, Choice, PartsSplit, SoundPanel, SpeedPanel, TextPanel, Tool, TransitionPanel, TypedSplit } from './editor/panels.jsx'
import { addStrokes, fitStrokes, isBlur, markSpot, newBlur, placeAt, removeSpot, spotAt } from './editor/blur.js'
import { AudioSheet, CaptionsSheet, ClipSheet, ExportSheet, LooksSheet, MediaSheet } from './editor/sheets.jsx'
import usePlayback from './editor/usePlayback.js'
import {
  formatClock, imagePiece, initial, insertAfter, isImage, lengthOf, offsets as offsetsOf, parseClock, removePiece, speedsOf, splitAt,
  splitEvenly, total as totalOf, transitionWindows, trimPiece
} from './editor/model.js'
import {
  Aspect, Back, Captions, Crop, Download, Grid, Minus, Music, Pause, Photo, Play, Plus, Redo, Scissors,
  Film, Pencil, Speed, Sparkle, TextIcon, Timer, Transition, Trash, Undo, VolumeOff, VolumeOn
} from './icons.jsx'
import { getStrip, getWave, loadEdit, probeVideo, saveEdit, saveProject, videoUrl } from './api.js'
import { lanesOf } from './editor/Timeline.jsx'

/** The first lane with room for something from a to b, as CapCut picks one. */
function freeLane (items, startOf, endOf, a, b, from = 0, except = null) {
  const rows = lanesOf(items, startOf, endOf).rows
  for (let lane = from; ; lane++) {
    const clash = items.some((x) => x.id !== except && rows.get(x.id) === lane && startOf(x) < b - 1e-6 && endOf(x) > a + 1e-6)
    if (!clash) return lane
  }
}
const textLane = (texts, a, b, from, except) => freeLane(texts, (t) => t.start, (t) => t.end, a, b, from, except)
const soundLane = (sounds, a, b, from, except) => freeLane(sounds, (x) => x.at, (x) => x.at + x.len, a, b, from, except)
/** Every item given its lane for good, so lanes stay put as things move. */
const withLanes = (items, startOf, endOf) => {
  const rows = lanesOf(items, startOf, endOf).rows
  return items.map((x) => (Number.isInteger(x.lane) ? x : { ...x, lane: rows.get(x.id) }))
}

const MIN_PIECE = 0.1
const MAX_PPS = 400
const HISTORY = 100
const PLAIN_LOOK = { crop: null, canvas: 'original', background: 'blur' }
const SHAPES = ['9:16', '1:1', '4:5', '16:9']

/** A fingerprint of the cuts, to tell when captions were made for other cuts. */
const cutsOf = (pieces) => pieces.map((p) => (isImage(p) ? 'i' + (p.end - p.start).toFixed(2) : (p.src || '') + p.start.toFixed(2) + '-' + p.end.toFixed(2) + speedMark(p))).join('|')
// Only a changed speed adds to the fingerprint, so older edits stay as they were.
const speedMark = (p) => {
  const [a, b] = speedsOf(p)
  return a === 1 && b === 1 ? '' : '@' + a + '-' + b + (p.pitch === 'shift' ? 'p' : '')
}

const freshEdit = (duration) => ({ pieces: initial(duration), sounds: [], look: PLAIN_LOOK, texts: [] })

/**
 * Edits saved when only one song could be added kept it as `music`, timed by
 * an offset; it becomes the first of the sounds, playing over the same part.
 */
function soundsOf (e, total) {
  if (Array.isArray(e.sounds)) return e.sounds
  const m = e.music
  if (!m) return []
  const at = Math.max(0, -m.offset)
  const from = Math.max(0, m.offset)
  const len = Math.max(0.2, Math.min((m.duration || Infinity) - from, total - at))
  return [{ id: newId(), media: m.id, name: m.name, duration: m.duration, at, from, len, volume: m.volume ?? 1 }]
}

/** True when an edit is still the untouched clip, so there is nothing to keep. */
function isPristine (e, duration) {
  const p = e.pieces
  return p.length === 1 && !isImage(p[0]) && !p[0].src && p[0].start < 1e-3 && Math.abs(p[0].end - duration) < 1e-3 && !speedMark(p[0]) &&
    !(e.sounds && e.sounds.length) && !e.music && !(e.texts && e.texts.length) && !e.look.crop && e.look.canvas === 'original' &&
    !e.look.fadeIn && !e.look.fadeOut
}

/** A saved edit made safe to open: pieces kept inside the clip as it is now. */
function restoreEdit (saved, duration) {
  const e = saved && saved.edit
  if (!e || !Array.isArray(e.pieces)) return null
  const pieces = e.pieces
    .map((p) => (isImage(p) || p.src ? p : { ...p, start: Math.max(0, p.start), end: Math.min(duration, p.end) }))
    .filter((p) => p.end - p.start >= 0.05)
  if (!pieces.length) return null
  const sounds = soundsOf(e, totalOf(pieces))
  return { ...freshEdit(duration), ...e, pieces, sounds, music: undefined, look: { ...PLAIN_LOOK, ...(e.look || {}) }, texts: e.texts || [] }
}

/**
 * A saved crop put on a clip of another shape: the same output shape and the
 * same centre, as tall as it was (or as wide, if that no longer fits).
 */
function adaptCrop (crop, fromAspect, toAspect) {
  if (!fromAspect || Math.abs(fromAspect - toAspect) < 0.02) return crop
  const ratio = (crop.w * fromAspect) / crop.h
  let h = crop.h
  let w = (h * ratio) / toAspect
  if (w > 1) { w = 1; h = toAspect / ratio }
  if (h > 1) { h = 1; w = ratio / toAspect }
  const cx = crop.x + crop.w / 2
  const cy = crop.y + crop.h / 2
  return { x: Math.min(Math.max(cx - w / 2, 0), 1 - w), y: Math.min(Math.max(cy - h / 2, 0), 1 - h), w, h }
}

function decodePeaks (b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The largest crop of a given width:height, centred in the frame. */
function centredCrop (ratio, W, H) {
  const rn = (ratio * H) / W
  let w = 1
  let h = 1 / rn
  if (h > 1) { h = 1; w = rn }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

/**
 * The editor, laid out like CapCut on a phone: the picture on top, the
 * timeline under it with the playhead fixed in the middle, the tools along the
 * bottom.
 *
 * The edit is a list of pieces (stretches of the clip, or pictures), an
 * optional song laid under them, and the look of the frame: a crop, a canvas
 * shape and what fills around the video. All of it is undoable.
 */
export default function Editor ({ video: clip, project, bucket, onBack }) {
  // A project has no clip of its own. Inside the editor it is treated as a
  // clip with nothing in it: every piece names its own picture or clip.
  const video = project ? { id: 'project:' + project.id, name: project.name, project } : clip
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState(null)

  // Undo history over the whole edit. The drafts hold a drag in progress so
  // it becomes one undo step when it ends, not hundreds.
  const [hist, setHist] = useState(null)
  const [draft, setDraft] = useState(null)
  const [lookDraft, setLookDraft] = useState(null)
  const [soundDraft, setSoundDraft] = useState(null)
  const [selectedSoundId, setSelectedSoundId] = useState(null)
  const lookDraftRef = useRef(null)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedTextId, setSelectedTextId] = useState(null)
  const [textDraft, setTextDraft] = useState(null)
  // Only a text just added takes the keyboard; one brought back by redo must not.
  const [freshTextId, setFreshTextId] = useState(null)
  // How the next blur is drawn, and whether the pencil adds to the chosen one.
  const [blurDraw, setBlurDraw] = useState({ shape: 'pencil', size: 0.04, more: false })

  // Every clip the edit uses: its details, and its frames and sound for the timeline.
  const [clips, setClips] = useState({})
  const [sources, setSources] = useState({})
  const sourcing = useRef(new Set())
  const [selectedJoin, setSelectedJoin] = useState(null)
  const [soundWaves, setSoundWaves] = useState({})
  const imagesRef = useRef({})
  const [, setImagesLoaded] = useState(0)

  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(null)
  const [previewMuted, setPreviewMuted] = useState(false)
  const [soundOff, setSoundOff] = useState(false)
  const [outMode, setOutMode] = useState('join')
  const [panel, setPanel] = useState(null)
  const [cropRatio, setCropRatio] = useState(null)
  const [sheet, setSheet] = useState(null)
  const [note, setNote] = useState(null)
  const [savedAt, setSavedAt] = useState(null)
  const [, setFontsReady] = useState(0)
  const noteTimer = useRef(0)
  const trimBase = useRef(null)

  const edit = hist?.present
  const pieces = draft ?? edit?.pieces ?? []
  const look = lookDraft ?? edit?.look ?? PLAIN_LOOK
  const sounds = soundDraft ?? edit?.sounds ?? []
  const selectedSound = sounds.find((x) => x.id === selectedSoundId) || null
  const texts = textDraft ?? edit?.texts ?? []
  const selectedText = texts.find((x) => x.id === selectedTextId) || null
  const total = totalOf(pieces)
  const fps = info?.fps || 30
  const frame = 1 / fps
  const duration = info?.duration || 0

  const durationOf = (p) => (isImage(p) ? Infinity : clips[p.src || video.id]?.duration ?? Infinity)

  const pb = usePlayback(pieces, edit?.pieces, fps, {
    videoMuted: previewMuted || soundOff,
    musicMuted: previewMuted,
    sounds: sounds.map((x) => ({ id: x.id, url: videoUrl(x.media), at: x.at, from: x.from, len: x.len, volume: x.volume })),
    mainId: video.id,
    durationOf
  })

  /** Fetches a clip's frame strip and waveform once, for its pieces on the timeline. */
  function loadSource (id) {
    if (sourcing.current.has(id)) return
    sourcing.current.add(id)
    const put = (patch) => setSources((m) => ({ ...m, [id]: { ...m[id], ...patch } }))
    // These decode the whole file the first time, which takes a second or
    // two on an episode, so the editor opens without them.
    getStrip(id)
      .then((st) => {
        put({ strip: st })
        if (st.none) return
        const img = new Image()
        img.onload = () => put({ img })
        img.src = st.image
      })
      .catch(() => put({ strip: { none: true } }))
    getWave(id)
      .then((w) => put({ rate: w.rate, peaks: w.hasAudio && w.peaks ? decodePeaks(w.peaks) : null }))
      .catch(() => put({ rate: 50, peaks: null }))
  }

  // Pieces from other clips need those clips' details and timeline media.
  useEffect(() => {
    for (const p of pieces) {
      if (!p.src || p.src === video.id) continue
      loadSource(p.src)
      if (clips[p.src] || sourcing.current.has('probe:' + p.src)) continue
      sourcing.current.add('probe:' + p.src)
      probeVideo(p.src).then((d) => setClips((m) => ({ ...m, [p.src]: d }))).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieces])

  useEffect(() => {
    let cancelled = false
    if (project) {
      const d = { width: project.width, height: project.height, fps: 30, duration: 0, hasVideo: true, hasAudio: false, project: true }
      setInfo(d)
      ;(async () => {
        let present = project.edit ? restoreEdit({ edit: project.edit }, 0) : null
        if (!present) {
          // A new project: the pictures and clips chosen for it, in order.
          const start = []
          for (const m of project.initial || []) {
            if (m.kind === 'image') start.push(imagePiece(m, m.seconds || 3))
            else {
              const pi = await probeVideo(m.id).catch(() => null)
              if (pi && pi.duration > 0) {
                setClips((x) => ({ ...x, [m.id]: pi }))
                start.push({ id: newId(), src: m.id, start: 0, end: pi.duration })
              }
            }
          }
          if (!start.length) throw new Error('Nothing to start the project with. Add a picture or a clip.')
          present = { ...freshEdit(0), pieces: start }
        } else if (project.extra?.soundOff) setSoundOff(true)
        if (cancelled) return
        setHist({ past: [], present, future: [] })
        if (project.edit) { setSavedAt(project.savedAt); flash('Picked up where you left off.') }
      })().catch((err) => { if (!cancelled) setLoadError(err.message) })
      loadFonts().then(() => { if (!cancelled) setFontsReady((n) => n + 1) })
      return () => { cancelled = true; clearTimeout(noteTimer.current) }
    }
    probeVideo(video.id)
      .then((d) => {
        if (cancelled) return
        if (!d.hasVideo) throw new Error('This file has no picture to edit.')
        if (!(d.duration > 0)) throw new Error('Could not read how long this clip is.')
        setInfo(d)
        setClips((m) => ({ ...m, [video.id]: d }))
        // Picks up where you left off, if this clip was edited before.
        return loadEdit(video.id).catch(() => null).then((saved) => {
          if (cancelled) return
          const back = restoreEdit(saved, d.duration)
          setHist({ past: [], present: back || freshEdit(d.duration), future: [] })
          if (back) {
            if (saved.extra?.soundOff) setSoundOff(true)
            if (saved.extra?.outMode) setOutMode(saved.extra.outMode)
            setSavedAt(saved.savedAt)
            flash(saved.sizeChanged
              ? 'Picked up your saved edit, but this file has changed since, so check the cuts.'
              : 'Picked up where you left off. Start over clears it, and Undo brings it back.')
          }
        })
      })
      .catch((err) => { if (!cancelled) setLoadError(err.message) })

    loadSource(video.id)
    // Imported fonts, so texts using them draw right away.
    loadFonts().then(() => { if (!cancelled) setFontsReady((n) => n + 1) })

    return () => { cancelled = true; clearTimeout(noteTimer.current) }
  }, [video.id])

  // Each sound file's waveform, once, for its bars on the timeline.
  const mediaIds = [...new Set(sounds.map((x) => x.media))].join('|')
  useEffect(() => {
    for (const id of mediaIds ? mediaIds.split('|') : []) {
      if (soundWaves[id] || sourcing.current.has('wave:' + id)) continue
      sourcing.current.add('wave:' + id)
      getWave(id)
        .then((w) => setSoundWaves((m) => ({ ...m, [id]: { rate: w.rate, peaks: w.peaks ? decodePeaks(w.peaks) : null } })))
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaIds])

  // Pictures in the edit, loaded once each for the timeline tiles.
  useEffect(() => {
    for (const p of pieces) {
      if (!isImage(p) || imagesRef.current[p.image]) continue
      const img = new Image()
      img.onload = () => setImagesLoaded((n) => n + 1)
      img.src = videoUrl(p.image)
      imagesRef.current[p.image] = img
    }
  }, [pieces])

  const pendingSave = useRef(null)
  useEffect(() => {
    if (!hist || !info) return
    const pristine = !project && isPristine(hist.present, info.duration)
    if (pristine && !savedAt) return
    const job = { edit: hist.present, extra: { soundOff, outMode } }
    pendingSave.current = job
    const timer = setTimeout(() => {
      pendingSave.current = null
      const save = project ? saveProject(project.id, job.edit, job.extra) : saveEdit(video.id, job.edit, job.extra)
      save.then((r) => setSavedAt(r.savedAt)).catch(() => {})
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist?.present, soundOff, outMode, info])

  useEffect(() => () => {
    const job = pendingSave.current
    if (job) {
      // keepalive lets the save finish even as the editor closes.
      fetch(project ? '/api/projects/' + encodeURIComponent(project.id) : '/api/edit/' + encodeURIComponent(video.id), {
        method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job)
      }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startOver () {
    pb.pause()
    commitEdit(freshEdit(duration))
    setSelectedId(null)
    setSelectedTextId(null)
    setPanel(null)
    flash('Started over with the whole clip. Undo brings your edit back.')
  }

  function flash (text) {
    setNote(text)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 4500)
  }

  /* ------------------------------------------------------------ history */

  // A key folds a run of small changes (typing, a slider) into one undo step.
  function commitEdit (patch, key) {
    setHist((h) => {
      const at = Date.now()
      if (key && h.key === key && at - h.at < 1500) return { ...h, present: { ...h.present, ...patch }, at }
      return { past: [...h.past, h.present].slice(-HISTORY), present: { ...h.present, ...patch }, future: [], key, at }
    })
  }

  function commit (next) {
    if (!next) return false
    commitEdit({ pieces: next })
    return true
  }

  function undo () {
    if (!hist?.past.length) return
    setHist((h) => ({ past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }))
  }

  function redo () {
    if (!hist?.future.length) return
    setHist((h) => ({ past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }))
  }

  /* -------------------------------------------------------------- zoom */

  // Fully zoomed out, the whole clip fits in the right half, starting at the
  // playhead, as it does when CapCut opens one. Measured against the clip, not
  // the edit, so trimming never rescales the timeline under the pointer.
  const span = duration || Math.max(total, 5)
  const fitPps = width && span ? Math.min(MAX_PPS, (width * 0.45) / span) : 1
  const pps = Math.min(Math.max(zoom ?? fitPps, fitPps), MAX_PPS)
  const zoomBy = (f) => setZoom(Math.min(Math.max(pps * f, fitPps), MAX_PPS))

  /* ----------------------------------------------------------- editing */

  const clampT = (T) => Math.min(Math.max(T, 0), total)
  const selected = pieces.find((p) => p.id === selectedId) || null
  const selectedIndex = selected ? pieces.indexOf(selected) : -1

  function split () {
    // The live position, not the last rendered one: while playing, the
    // rendered time trails the picture by up to a frame of the UI loop.
    const T = pb.now()
    pb.pause(T)
    const next = splitAt(pieces, T, MIN_PIECE)
    if (!next) {
      flash('Too close to a cut or an end to split here')
      return
    }
    commit(next)
    setSelectedId(null)
  }

  function deleteSelected () {
    if (!selected) {
      flash('Tap a piece on the timeline first, then delete it')
      return
    }
    const next = removePiece(pieces, selected.id)
    if (!next) {
      flash('The last piece cannot be deleted')
      return
    }
    commit(next)
    setSelectedId(null)
  }

  /** Moves a piece to another place in the edit; the playhead goes with it. */
  function reorder (id, to) {
    const from = pieces.findIndex((p) => p.id === id)
    if (from < 0) return
    const rest = pieces.filter((p) => p.id !== id)
    const at = Math.min(Math.max(to, 0), rest.length)
    if (at === from) return
    const next = [...rest.slice(0, at), pieces[from], ...rest.slice(at)]
    commit(next)
    setSelectedId(id)
    pb.seek(offsetsOf(next)[at], next)
    flash(`Moved to position ${at + 1} of ${next.length}`)
  }

  function onTrim ({ id, edge, to, phase }) {
    if (phase === 'start') {
      pb.pause()
      trimBase.current = { list: pieces, t: pb.now() }
      setSelectedId(id)
      return
    }
    const base = trimBase.current
    if (!base) return
    const next = trimPiece(base.list, id, edge, to, durationOf, MIN_PIECE)
    const before = base.list.find((p) => p.id === id)
    const after = next.find((p) => p.id === id)

    if (phase === 'move') {
      setDraft(next)
      // Pulling the left edge keeps the frames where they are and moves the
      // edge, so the handle stays under the pointer. Everything after a right
      // edge ripples along live.
      if (edge === 'start') pb.setTime(base.t - (lengthOf(before) - lengthOf(after)))
      if (!isImage(after)) pb.peek(after, edge === 'start' ? after.start : Math.max(after.start, after.end - frame))
      return
    }

    trimBase.current = null
    setDraft(null)
    if (phase === 'cancel' || (after.start === before.start && after.end === before.end)) {
      pb.seek(base.t, base.list)
      return
    }
    if (edge === 'start') pb.setTime(base.t - (lengthOf(before) - lengthOf(after)))
    commit(next)
  }

  function splitAtTyped (text) {
    const T = parseClock(text)
    if (T === null) return 'Type a time like 1:15, or just seconds'
    if (T <= 0 || T >= total) return 'Pick a time between 00:00 and ' + formatClock(total, true)
    const next = splitAt(pieces, T, MIN_PIECE)
    if (!next) return 'There is already a cut right there'
    pb.seek(T)
    commit(next)
    setSelectedId(null)
    flash('Split at ' + formatClock(T, true))
    return null
  }

  function splitIntoParts (n) {
    if (!Number.isInteger(n) || n < 2 || n > 100) return 'Choose between 2 and 100 parts'
    const next = splitEvenly(pieces, n, duration, MIN_PIECE)
    if (!next) return 'Those parts would be too short'
    commit(next)
    setSelectedId(null)
    setOutMode('parts')
    flash(`Cut into ${n} equal parts. Export will save ${n} separate files.`)
    return null
  }

  /* ------------------------------------------------------------- look */

  function setLook (patch) {
    commitEdit({ look: { ...look, ...patch } })
  }

  function onCrop (next, phase) {
    if (phase === 'move') {
      const d = { ...(edit?.look || PLAIN_LOOK), crop: next }
      lookDraftRef.current = d
      setLookDraft(d)
      return
    }
    const d = lookDraftRef.current
    lookDraftRef.current = null
    setLookDraft(null)
    if (d) commitEdit({ look: d })
  }

  function pickRatio (shape) {
    const ratio = shape ? ASPECTS[shape] : null
    setCropRatio(ratio)
    if (ratio) setLook({ crop: centredCrop(ratio, info.width, info.height) })
  }

  /* ------------------------------------------------------------ sound */

  /**
   * Adds a sound at the playhead, playing for as long as it lasts or until
   * the edit ends. The first sound over the whole edit is taken as a
   * soundtrack and turns the clip's own sound off; shorter ones (an effect,
   * a voice line) play alongside it.
   */
  async function addSong (media) {
    setSheet(null)
    pb.pause()
    let length = 0
    try {
      length = (await probeVideo(media.id)).duration || 0
    } catch { /* plays anyway; it just runs to the end of the edit */ }
    const after = afterSound.current ? (edit.sounds || []).find((x) => x.id === afterSound.current) : null
    afterSound.current = null
    let at = after ? after.at + after.len : pb.now()
    if (at > total - 0.5) at = after ? Math.max(0, total - 0.5) : 0
    const len = Math.max(0.2, Math.min(length || total, total - at))
    const fixed = withLanes(edit.sounds || [], (x) => x.at, (x) => x.at + x.len)
    const lane = soundLane(fixed, at, at + len, after ? (after.lane ?? 0) : 0)
    const snd = { id: newId(), media: media.id, name: media.name, duration: length, at, from: 0, len, volume: 1, lane }
    commitEdit({ sounds: [...fixed, snd] })
    selectSound(snd.id)
    const whole = at < 0.5 && len >= total * 0.9
    if (whole && !(edit.sounds || []).length && info?.hasAudio && !soundOff) {
      setSoundOff(true)
      flash(`Added ${media.name} under the whole edit. The clip's own sound is now off; turn Clip sound back on to hear both.`)
    } else {
      flash(`Added ${media.name} at ${formatClock(at, true)}. Drag its green bar to move it, or its ends to trim it.`)
    }
  }

  function selectSound (id) {
    setSelectedSoundId(id)
    if (id) { setSelectedId(null); setSelectedTextId(null); setPanel('sound') } else if (panel === 'sound') setPanel(null)
  }

  function updateSound (id, patch, key) {
    commitEdit({ sounds: (edit.sounds || []).map((x) => (x.id === id ? { ...x, ...patch } : x)) }, key)
  }

  // Set when "Sound after this one" opens the picker.
  const afterSound = useRef(null)

  /** A new line under this text, appearing a moment after it, in the same style. */
  function textBelow (item) {
    const ctx = document.createElement('canvas').getContext('2d')
    const { W, H } = frameSize(info, look)
    const box = layoutText(ctx, item, W, H).box
    const start = Math.min(item.start + 1, Math.max(item.start, item.end - 0.5))
    const end = Math.min(total, Math.max(item.end, start + 1.5))
    const next = { ...item, id: newId(), text: 'Next line', start, end, words: undefined, caption: undefined }
    const tall = (box.y1 - box.y0) / H
    next.y = Math.min(0.94, item.y + tall + 0.01)
    const fixed = withLanes(edit.texts || [], (t) => t.start, (t) => t.end)
    next.lane = textLane(fixed, start, end, 0)
    commitEdit({ texts: [...fixed, next] })
    setFreshTextId(next.id)
    selectText(next.id)
    flash('Added a line under it, appearing a second later. Change its words, and its times on the Animation tab.')
  }

  /** A copy of this text, in the same place and style, right after it. */
  function duplicateText (item) {
    const len = item.end - item.start
    let start = item.end
    if (start > total - 0.2) start = item.start
    const end = Math.min(total, start + len)
    const fixed = withLanes(edit.texts || [], (t) => t.start, (t) => t.end)
    const copy = { ...item, id: newId(), start, end, words: item.words ? rescaleWords(item.words, item, { start, end }) : undefined, lane: undefined }
    copy.lane = textLane(fixed, start, end, item.lane ?? 0)
    commitEdit({ texts: [...fixed, copy] })
    selectText(copy.id)
    pb.seek(start)
    flash('Copied it to play right after. Change the words to make it the next one.')
  }

  // Sound bars: moved or trimmed on the timeline.
  const soundBase = useRef(null)
  function onSound ({ id, at, from, len, lane, phase }) {
    if (phase === 'start') { pb.pause(); soundBase.current = edit.sounds || []; return }
    if (phase === 'click') { selectSound(id === selectedSoundId ? null : id); soundBase.current = null; return }
    const base = soundBase.current
    if (!base) return
    const fixedBase = withLanes(base, (x) => x.at, (x) => x.at + x.len)
    const next = fixedBase.map((x) => {
      if (x.id !== id) return x
      const a = Math.min(at, Math.max(0, total - 0.2))
      const moved = { ...x, at: a, from, len: Math.min(len, Math.max(0.2, total - a)) }
      if (lane !== undefined && lane !== x.lane && soundLane(fixedBase, moved.at, moved.at + moved.len, lane, id) === lane) moved.lane = lane
      return moved
    })
    if (phase === 'move') { setSoundDraft(next); return }
    soundBase.current = null
    setSoundDraft(null)
    if (phase === 'end') { commitEdit({ sounds: next }); selectSound(id) }
  }

  /* ---------------------------------------------------------- pictures */

  function addPicture (media, seconds) {
    setSheet(null)
    const piece = imagePiece(media, seconds)
    const next = insertAfter(pieces, piece, selectedId || pieces[pieces.length - 1]?.id)
    commit(next)
    setSelectedId(piece.id)
    const at = offsetsOf(next)[next.indexOf(piece)]
    pb.seek(at, next)
    flash(`Added ${media.name} for ${seconds} s. Drag its white handles to change how long it shows.`)
  }

  /* -------------------------------------------------------------- text */

  const selectPiece = (id) => { setSelectedId(id); if (id) { setSelectedTextId(null); setSelectedSoundId(null); if (panel === 'sound') setPanel(null); setNote(null) } }
  const selectText = (id) => {
    const item = id && (edit?.texts || []).find((x) => x.id === id)
    if (item && isBlur(item)) {
      const T = pb.now()
      if (T < item.start || T >= item.end) pb.seek(item.start)
    }
    setBlurDraw((d) => (d.more ? { ...d, more: false } : d))
    setSelectedTextId(id)
    if (id) { setSelectedId(null); setSelectedSoundId(null); setNote(null); setPanel('text') } else if (panel === 'text') setPanel(null)
  }

  function addText () {
    if (!hist) return
    pb.pause()
    const T = pb.now()
    const len = Math.min(3, total)
    const start = Math.max(0, Math.min(T, total - len))
    const item = newText(start, start + len)
    const showing = texts.filter((x) => !x.caption && !isBlur(x) && x.start < item.end && x.end > item.start)
    if (showing.length && info) {
      const { W, H } = frameSize(info, look)
      const ctx = document.createElement('canvas').getContext('2d')
      const bottom = Math.max(...showing.map((x) => layoutText(ctx, x, W, H).box.y1)) / H
      const tall = (layoutText(ctx, item, W, H).box.y1 - layoutText(ctx, item, W, H).box.y0) / H
      const below = bottom + 0.02 + tall / 2
      const top = Math.min(...showing.map((x) => layoutText(ctx, x, W, H).box.y0)) / H
      item.y = below + tall / 2 < 0.96 ? below : Math.max(0.05, top - 0.02 - tall / 2)
    }
    const fixed = withLanes(texts, (t) => t.start, (t) => t.end)
    item.lane = textLane(fixed, item.start, item.end)
    commitEdit({ texts: [...fixed, item] })
    setFreshTextId(item.id)
    if (T < start || T >= start + len) pb.seek(start)
    selectText(item.id)
  }

  function updateText (id, patch, key) {
    commitEdit({
      texts: (edit.texts || []).map((x) => {
        if (x.id !== id) return x
        const next = { ...x, ...patch }
        // Edited words keep their heard timings where they still line up.
        if (patch.text !== undefined && x.words) next.words = retimeWords(x.words, patch.text, x.start, x.end)
        if ((patch.start !== undefined || patch.end !== undefined) && x.words) next.words = rescaleWords(x.words, x, next)
        // Animations chosen the new way replace the old single setting.
        if (patch.animIn !== undefined || patch.animOut !== undefined || patch.animLoop !== undefined) {
          Object.assign(next, { ...animsOf(x), ...patch, anim: undefined })
        }
        return next
      })
    }, key)
  }

  function deleteText (id) {
    commitEdit({ texts: (edit.texts || []).filter((x) => x.id !== id) })
    selectText(null)
  }

  // Timeline bars: slide or stretch when it shows.
  const textBase = useRef(null)
  function onText ({ id, start, end, lane, phase }) {
    if (phase === 'start') { pb.pause(); textBase.current = edit.texts; return }
    if (phase === 'click') { selectText(id === selectedTextId ? null : id); textBase.current = null; return }
    const base = textBase.current
    if (!base) return
    const fit = (x) => {
      const len = x.end - x.start
      let a = Math.min(start, Math.max(0, total - Math.min(len, total)))
      let b = Math.min(end, total)
      if (b - a < 0.2) { a = Math.max(0, b - 0.2); b = a + 0.2 }
      return { ...x, start: a, end: b, words: rescaleWords(x.words, x, { start: a, end: b }) }
    }
    const fixedBase = withLanes(base, (t) => t.start, (t) => t.end)
    const next = fixedBase.map((x) => {
      if (x.id !== id) return x
      const moved = fit(x)
      if (lane !== undefined && lane !== x.lane) {
        const room = textLane(fixedBase, moved.start, moved.end, lane, id) === lane
        if (room) moved.lane = lane
      }
      return moved
    })
    if (phase === 'move') { setTextDraft(next); return }
    textBase.current = null
    setTextDraft(null)
    if (phase === 'end') { commitEdit({ texts: next }); selectText(id) }
  }

  // Dragging a text on the picture.
  const moveRef = useRef(null)
  function onMoveText (id, x, y, phase) {
    if (phase === 'move') {
      const next = (moveRef.current ?? edit.texts).map((t) => (t.id === id ? { ...t, x, y } : t))
      moveRef.current = next
      setTextDraft(next)
      return
    }
    const done = moveRef.current
    moveRef.current = null
    setTextDraft(null)
    if (done) commitEdit({ texts: done })
  }

  /* -------------------------------------------------------------- blur */

  const selectedBlur = selectedText && isBlur(selectedText) ? selectedText : null
  const frameAspect = () => {
    const { W, H } = frameSize(info, look)
    return W / H
  }

  function startBlur () {
    if (!hist) return
    pb.pause()
    selectText(null)
    setBlurDraw((d) => ({ ...d, more: false }))
    setPanel('blur')
  }

  /** A finished stroke or box on the picture: a new blur, or more of the chosen one. */
  function onDrawBlur ({ strokes, box }) {
    const T = pb.now()
    if (selectedBlur && blurDraw.more && strokes) {
      const next = addStrokes(selectedBlur, T, strokes, frameAspect())
      commitEdit({ texts: (edit.texts || []).map((x) => (x.id === next.id ? next : x)) })
      return
    }
    const start = Math.max(0, Math.min(T, total - 0.2))
    const end = total
    let item
    if (strokes) {
      const fit = fitStrokes(strokes, frameAspect())
      item = newBlur(start, end, 'pencil', fit.box, fit.strokes)
    } else {
      item = newBlur(start, end, blurDraw.shape, box)
    }
    const fixed = withLanes(edit.texts || [], (t) => t.start, (t) => t.end)
    item.lane = textLane(fixed, item.start, item.end)
    commitEdit({ texts: [...fixed, item] })
    selectText(item.id)
    flash('Blurred from here to the end. Drag its ends on the timeline to change when it shows.')
  }

  // Dragging a blur on the picture, at the playhead's moment.
  const blurMoveRef = useRef(null)
  function onMoveBlur (id, box, phase) {
    if (phase === 'move') {
      const T = pb.now()
      const next = (edit.texts || []).map((x) => (x.id === id ? placeAt(x, T, box) : x))
      blurMoveRef.current = next
      setTextDraft(next)
      return
    }
    const done = blurMoveRef.current
    blurMoveRef.current = null
    setTextDraft(null)
    if (done) commitEdit({ texts: done })
  }

  function markBlurSpot () {
    if (!selectedBlur) return
    const T = pb.now()
    const next = markSpot(selectedBlur, T - selectedBlur.start, spotAt(selectedBlur, T))
    commitEdit({ texts: (edit.texts || []).map((x) => (x.id === next.id ? next : x)) })
    flash('Spot marked. Play to where the thing has moved, pause, and drag the blur onto it: another spot is marked there.')
  }

  function unmarkBlurSpot (i) {
    if (!selectedBlur) return
    const next = removeSpot(selectedBlur, i)
    commitEdit({ texts: (edit.texts || []).map((x) => (x.id === next.id ? next : x)) })
  }

  // The stage's blur tool: drawing a new one, painting more, or moving the chosen one.
  const blurTool = panel === 'blur'
    ? { mode: 'draw', shape: blurDraw.shape, size: blurDraw.size }
    : selectedBlur && panel === 'text'
      ? (blurDraw.more ? { mode: 'draw', shape: 'pencil', size: blurDraw.size } : { mode: 'edit' })
      : null

  /** The style of one caption, copied to every caption. */
  function styleAllCaptions (from) {
    const look = captionStyleOf(from)
    commitEdit({ texts: edit.texts.map((x) => (x.caption ? { ...x, ...look } : x)), captionLook: look })
    flash('Every caption now looks and moves like this one')
  }

  function setCaptions (words) {
    const chunks = captionChunks(words).filter((c) => c.start < total)
    const keep = (edit.texts || []).filter((x) => !x.caption)
    // A caption style already chosen carries over to the new captions.
    const was = (edit.texts || []).find((x) => x.caption)
    const style = edit.captionLook ? edit.captionLook : was
      ? captionStyleOf(was)
      : CAPTION_LOOK
    const made = chunks.map((c) => ({ id: newId(), caption: true, text: c.text, start: c.start, end: Math.min(c.end, total), words: c.words, ...CAPTION_LOOK, ...style }))
    commitEdit({ texts: [...keep, ...made], captionsFor: cutsOf(pieces) })
    setSheet(null)
    selectText(null)
    flash(made.length
      ? `Added ${made.length} captions. Check them before you export: click any caption to fix a word.`
      : 'No speech was found in this edit')
  }

  /* ------------------------------------------------------- transitions */

  function setTransition (k, type, d, key) {
    const next = pieces.map((p, i) => (i === k ? { ...p, transition: type ? { type, d } : null } : p))
    commitEdit({ pieces: next }, key)
  }

  function transitionEverywhere (type, d) {
    commitEdit({ pieces: pieces.map((p, i) => (i === 0 ? p : { ...p, transition: { type, d } })) })
    flash(`Every cut now has a ${type} transition`)
  }

  /* ------------------------------------------------------------- speed */

  // The piece the speed panel works on: the selected one, or the only one.
  const speedPiece = selected || (pieces.length === 1 ? pieces[0] : null)
  const tidyPiece = (p) => {
    const q = { ...p }
    for (const k of ['speed', 'speedEnd', 'pitch', 'smooth']) if (q[k] === undefined) delete q[k]
    return q
  }

  function setSpeed (patch, key) {
    if (!speedPiece) return
    pb.pause()
    commitEdit({ pieces: pieces.map((p) => (p.id === speedPiece.id ? tidyPiece({ ...p, ...patch }) : p)) }, key)
  }

  function speedEverywhere () {
    if (!speedPiece) return
    const { speed, speedEnd, pitch, smooth } = speedPiece
    commitEdit({ pieces: pieces.map((p) => (isImage(p) ? p : tidyPiece({ ...p, speed, speedEnd, pitch, smooth }))) })
    flash('Every clip piece now plays at this speed')
  }

  /* ------------------------------------------------------------- clips */

  /** Adds another clip, whole, after the selected piece or at the end. */
  async function addClip (v) {
    const d = clips[v.id] || await probeVideo(v.id)
    if (!d.hasVideo || !(d.duration > 0)) throw new Error('That clip has no picture to add')
    setClips((m) => ({ ...m, [v.id]: d }))
    const piece = { id: newId(), ...(v.id === video.id ? {} : { src: v.id }), start: 0, end: d.duration }
    const next = insertAfter(pieces, piece, selectedId || pieces[pieces.length - 1]?.id)
    commit(next)
    setSheet(null)
    setSelectedId(piece.id)
    pb.seek(offsetsOf(next)[next.indexOf(piece)], next)
    flash(`Added ${v.name}. Trim it with its white handles, or drag it to move it.`)
  }

  /* ------------------------------------------------------------- looks */

  // What a new look would save from this edit.
  const firstCaption = texts.find((x) => x.caption)
  const lookNow = {
    ...look,
    cropAspect: info ? info.width / info.height : 1,
    caption: edit?.captionLook || (firstCaption
      ? captionStyleOf(firstCaption)
      : null)
  }

  function applyLook (L) {
    pb.pause()
    const next = { ...look }
    if (L.crop) next.crop = adaptCrop(L.crop, L.cropAspect, info.width / info.height)
    if (L.canvas !== undefined) {
      next.canvas = L.canvas
      next.background = L.background || 'blur'
      if (L.background === 'image') next.bgImage = L.bgImage
    }
    if (L.fadeIn !== undefined || L.fadeOut !== undefined) { next.fadeIn = L.fadeIn || 0; next.fadeOut = L.fadeOut || 0 }
    const patch = { look: next }
    if (L.caption) {
      const style = { ...L.caption, ...animsOf(L.caption) }
      delete style.anim
      patch.captionLook = style
      patch.texts = (edit.texts || []).map((x) => (x.caption ? { ...x, ...style, anim: undefined } : x))
    }
    commitEdit(patch)
    flash(`Used the template “${L.name}”. Undo takes it off.`)
    setSheet(L.autoCaptions && info.hasAudio ? 'captions-auto' : null)
  }

  /* -------------------------------------------------------------- keys */

  useEffect(() => {
    function onKey (e) {
      if (sheet) return
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      // Leaving works at any moment, including while the clip is still
      // opening or after it failed to.
      if (!hist) {
        if (e.code === 'Escape') onBack()
        return
      }
      const ctrl = e.ctrlKey || e.metaKey

      if (ctrl && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
      if (ctrl && e.code === 'KeyY') { e.preventDefault(); redo(); return }
      if (ctrl && e.code === 'KeyB') { e.preventDefault(); split(); return }
      // Alt + arrows move the selected piece one place earlier or later.
      if (e.altKey && selected && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault()
        reorder(selected.id, selectedIndex + (e.code === 'ArrowLeft' ? -1 : 1))
        return
      }
      if (ctrl || e.altKey) return

      switch (e.code) {
        case 'Space': e.preventDefault(); pb.toggle(); break
        case 'KeyS': e.preventDefault(); split(); break
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          if (selectedTextId) deleteText(selectedTextId)
          else if (selectedSoundId) { commitEdit({ sounds: (edit.sounds || []).filter((x) => x.id !== selectedSoundId) }); selectSound(null) }
          else deleteSelected()
          break
        case 'ArrowLeft': e.preventDefault(); pb.seek(clampT(pb.now() - (e.shiftKey ? 1 : frame))); break
        case 'ArrowRight': e.preventDefault(); pb.seek(clampT(pb.now() + (e.shiftKey ? 1 : frame))); break
        case 'Home': e.preventDefault(); pb.seek(0); break
        case 'End': e.preventDefault(); pb.seek(total); break
        case 'Equal':
        case 'NumpadAdd': zoomBy(1.5); break
        case 'Minus':
        case 'NumpadSubtract': zoomBy(1 / 1.5); break
        case 'KeyM': setPreviewMuted((m) => !m); break
        case 'KeyD':
          if (selectedText) { e.preventDefault(); duplicateText(selectedText) }
          break
        case 'Escape':
          if (panel === 'text') selectText(null)
          else if (panel) setPanel(null)
          else if (selectedTextId) selectText(null)
          else if (selectedId) setSelectedId(null)
          else onBack()
          break
        default: break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ------------------------------------------------------------ render */

  if (loadError) {
    return (
      <div className="editor">
        <header className="libbar">
          <div className="libbar__left">
            <button className="ctl" onClick={onBack} aria-label="Back"><Back size={18} /></button>
            <h1 className="libbar__title">{video.name}</h1>
          </div>
        </header>
        <p className="libnote libnote--error ed__error">{loadError}</p>
      </div>
    )
  }

  const captioned = texts.some((x) => x.caption)
  const staleCaptions = captioned && edit?.captionsFor && !draft && cutsOf(pieces) !== edit.captionsFor

  // What has sound: the clips in the edit, and anything added over them.
  const clipsHaveSound = Boolean(info && (info.hasAudio || pieces.some((p) => p.src && clips[p.src]?.hasAudio)))
  const anySound = clipsHaveSound || sounds.length > 0

  const outputs = outMode === 'join' ? 1 : pieces.length
  const outLabel = outMode === 'join' ? '1 video' : `${outputs} file${outputs === 1 ? '' : 's'}`
  const togglePanel = (name) => setPanel((p) => (p === name ? null : name))

  let status = ''
  if (note) status = note
  else if (selectedText) status = `${selectedText.caption ? 'Caption' : 'Text'} · ${formatClock(selectedText.start, true)} to ${formatClock(selectedText.end, true)} · drag it on the picture to move it`
  else if (selected && isImage(selected)) status = `Picture · shows for ${formatClock(selected.end - selected.start, true)} · drag the white handles to change`
  else if (selected) status = `Piece ${selectedIndex + 1} of ${pieces.length} · ${formatClock(lengthOf(selected), true)} · drag the white handles to trim${pieces.length > 1 ? ', or drag the piece to move it' : ''}`
  else if (pieces.length > 1) status = `${pieces.length} pieces`

  return (
    <div className="editor" data-pieces={pieces.length} data-texts={texts.length}>
      <header className="libbar">
        <div className="libbar__left">
          <button className="ctl" onClick={onBack} title="Back to library (Esc)" aria-label="Back">
            <Back size={18} />
          </button>
          <h1 className="libbar__title" title={video.name}>{video.name}</h1>
          <span className="libbar__crumb">{bucket.name}</span>
        </div>
        <div className="libbar__right">
          {savedAt ? <span className="ed__saved" title={'Saved ' + new Date(savedAt).toLocaleString()}>Saved</span> : null}
          {hist && info && !project && !isPristine(hist.present, info.duration) ? (
            <button className="ed__startover" onClick={startOver} title="Back to the whole clip, untouched (Undo brings your edit back)">Start over</button>
          ) : null}
          <button className="ctl" onClick={undo} disabled={!hist?.past.length} title="Undo (Ctrl+Z)" aria-label="Undo">
            <Undo size={18} />
          </button>
          <button className="ctl" onClick={redo} disabled={!hist?.future.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
            <Redo size={18} />
          </button>
          <button className="pill pill--solid ed__export" onClick={() => { pb.pause(); setSheet('export') }} disabled={!hist}>
            <Download size={16} /> Export <span className="ed__export-n">{outLabel}</span>
          </button>
        </div>
      </header>

      <Stage
        info={info}
        look={look}
        cropping={panel === 'crop'}
        cropRatio={cropRatio}
        onCrop={onCrop}
        pb={pb}
        clips={clips}
        mainId={video.id}
        onClick={() => hist && pb.toggle()}
        loading={!hist}
        texts={texts}
        selectedTextId={selectedTextId}
        onSelectText={selectText}
        onMoveText={onMoveText}
        blurTool={blurTool}
        onDrawBlur={onDrawBlur}
        onMoveBlur={onMoveBlur}
      />
      {/* The added song plays from here, kept in step by the playback engine. */}
      {sounds.map((x) => (
        <audio key={x.id} ref={(el) => pb.registerAudio(x.id, el)} src={videoUrl(x.media)} preload="auto" />
      ))}

      <div className="ed__transport">
        <button className="ctl" onClick={pb.toggle} disabled={!hist} aria-label={pb.playing ? 'Pause' : 'Play'} title="Play or pause (Space)">
          {pb.playing ? <Pause /> : <Play />}
        </button>
        <span className="clock ed__clock">
          {formatClock(pb.t, true)} <span className="clock__sep">/</span> {formatClock(total, true)}
        </span>
        <span className="ed__status" aria-live="polite">{status}</span>
        <div className="ed__transport-right">
          <button
            className="ctl"
            onClick={() => setPreviewMuted((m) => !m)}
            title="Mute the preview (M)"
            aria-label={previewMuted ? 'Unmute preview' : 'Mute preview'}
          >
            {previewMuted ? <VolumeOff size={18} /> : <VolumeOn size={18} />}
          </button>
          <button className="ctl" onClick={() => zoomBy(1 / 1.5)} disabled={pps <= fitPps + 1e-9} title="Zoom out (−)" aria-label="Zoom out">
            <Minus size={18} />
          </button>
          <button className="ctl" onClick={() => zoomBy(1.5)} disabled={pps >= MAX_PPS} title="Zoom in (+)" aria-label="Zoom in">
            <Plus size={18} />
          </button>
        </div>
      </div>

      <Timeline
        pieces={pieces}
        t={pb.t}
        pps={pps}
        media={(p) => (isImage(p) ? {} : sources[p.src || video.id] || {})}
        selectedJoin={panel === 'transition' ? selectedJoin : null}
        onJoin={(k) => { pb.pause(); setSelectedJoin(k); setSelectedId(null); setPanel('transition') }}
        images={imagesRef.current}
        soundOff={soundOff}
        sounds={sounds}
        soundWaves={soundWaves}
        selectedSoundId={selectedSoundId}
        selectedId={selectedId}
        onWidth={setWidth}
        onSeek={(T) => pb.seek(clampT(T))}
        onSelect={selectPiece}
        texts={texts}
        selectedTextId={selectedTextId}
        onText={onText}
        onAddText={addText}
        onTrim={onTrim}
        onReorder={reorder}
        onZoom={zoomBy}
        compact={['text', 'transition', 'sound', 'crop', 'canvas', 'speed', 'blur'].includes(panel)}
        onSound={onSound}
        onAddMusic={() => { pb.pause(); setSheet('audio-pick') }}
      />

      {/* Everything under the timeline. It gives way, scrolling if it must,
          before the picture does: the picture keeps about half the window. */}
      <div className="ed__dock">
      {panel === 'at' ? (
        <TypedSplit total={total} onSubmit={splitAtTyped} onClose={() => setPanel(null)} />
      ) : null}
      {panel === 'parts' ? (
        <PartsSplit
          replacing={pieces.length > 1}
          total={pieces.length > 1 ? duration : total}
          onSubmit={splitIntoParts}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel === 'crop' ? (
        <div className="ed__panel">
          <span className="ed__panel-label">Crop</span>
          <Choice on={!cropRatio} onClick={() => pickRatio(null)}>Free</Choice>
          {SHAPES.map((s) => (
            <Choice key={s} on={cropRatio === ASPECTS[s]} onClick={() => pickRatio(s)}>{s}</Choice>
          ))}
          <span className="ed__panel-hint">Drag the box or its edges. Pull the top and bottom in to crop the height.</span>
          <button className="ed__ghost" onClick={() => { setCropRatio(null); setLook({ crop: null }) }} disabled={!look.crop}>Reset</button>
          <button className="ed__go" onClick={() => setPanel(null)}>Done</button>
        </div>
      ) : null}
      {panel === 'canvas' ? (
        <div className="ed__panel">
          <span className="ed__panel-label">Shape</span>
          <Choice on={look.canvas === 'original'} onClick={() => setLook({ canvas: 'original' })}>Original</Choice>
          {SHAPES.map((s) => (
            <Choice key={s} on={look.canvas === s} onClick={() => setLook({ canvas: s })}>{s}</Choice>
          ))}
          <span className="ed__panel-sep" />
          <span className="ed__panel-label">Fill</span>
          <Choice on={look.background !== 'black' && look.background !== 'image'} onClick={() => setLook({ background: 'blur' })}>Blur</Choice>
          <Choice on={look.background === 'black'} onClick={() => setLook({ background: 'black' })}>Black</Choice>
          <Choice
            on={look.background === 'image'}
            onClick={() => (look.bgImage && look.background !== 'image' ? setLook({ background: 'image' }) : (pb.pause(), setSheet('fill-pick')))}
            title="A picture of your own behind the video"
          >
            {look.background === 'image' ? 'Picture ✓' : 'Picture…'}
          </Choice>
          {look.background === 'image' ? <button className="textbtn" onClick={() => setSheet('fill-pick')}>Change picture</button> : null}
          <button className="ed__go" onClick={() => setPanel(null)}>Done</button>
        </div>
      ) : null}
      {panel === 'blur' ? (
        <BlurPanel draw={blurDraw} onDraw={(p) => setBlurDraw((d) => ({ ...d, ...p }))} onClose={() => setPanel(null)} />
      ) : null}
      {panel === 'text' && selectedBlur ? (
        <BlurPanel
          key={selectedBlur.id}
          blur={selectedBlur}
          draw={blurDraw}
          onDraw={(p) => setBlurDraw((d) => ({ ...d, ...p }))}
          total={total}
          t={pb.t}
          onChange={(patch, key) => updateText(selectedBlur.id, patch, key)}
          onMark={markBlurSpot}
          onUnmark={unmarkBlurSpot}
          onGo={(T) => pb.seek(T)}
          onDuplicate={() => duplicateText(selectedBlur)}
          onDelete={() => deleteText(selectedBlur.id)}
          onClose={() => selectText(null)}
        />
      ) : null}
      {panel === 'text' && selectedText && !selectedBlur ? (
        <TextPanel
          key={selectedText.id}
          item={selectedText}
          fresh={freshTextId === selectedText.id}
          onUndo={undo}
          onRedo={redo}
          captions={texts.filter((x) => x.caption).length}
          onChange={(patch, key) => updateText(selectedText.id, patch, key)}
          total={total}
          onBelow={() => textBelow(selectedText)}
          onDuplicate={() => duplicateText(selectedText)}
          onStyleAll={() => styleAllCaptions(selectedText)}
          onDelete={() => deleteText(selectedText.id)}
          onClose={() => selectText(null)}
        />
      ) : null}
      {panel === 'transition' ? (
        <TransitionPanel
          join={selectedJoin && selectedJoin < pieces.length ? selectedJoin : null}
          piece={selectedJoin ? pieces[selectedJoin] : null}
          count={pieces.length}
          look={look}
          playable={Boolean(selectedJoin && transitionWindows(pieces, durationOf)[selectedJoin])}
          onSet={(type, d, key) => setTransition(selectedJoin, type, d, key)}
          onAll={transitionEverywhere}
          onFades={(patch) => setLook(patch)}
          onClose={() => { setPanel(null); setSelectedJoin(null) }}
        />
      ) : null}
      {panel === 'speed' ? (
        <SpeedPanel
          piece={speedPiece}
          count={pieces.filter((p) => !isImage(p)).length}
          onChange={setSpeed}
          onAll={speedEverywhere}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel === 'sound' && selectedSound ? (
        <SoundPanel
          key={selectedSound.id}
          sound={selectedSound}
          total={total}
          clipSound={!soundOff}
          canClipSound={Boolean(info?.hasAudio)}
          onClipSound={(on) => setSoundOff(!on)}
          onChange={(patch, key) => updateSound(selectedSound.id, patch, key)}
          onAnother={() => { afterSound.current = null; setSheet('audio-pick') }}
          onAfter={() => { afterSound.current = selectedSound.id; setSheet('audio-pick') }}
          onRemove={() => { commitEdit({ sounds: (edit.sounds || []).filter((x) => x.id !== selectedSound.id) }); selectSound(null); flash('Removed that sound') }}
          onClose={() => selectSound(null)}
        />
      ) : null}

      {staleCaptions ? (
        <div className="ed__notice" role="status">
          <span>
            Your cuts changed after the captions were made, so some captions may now show at the wrong moment.
          </span>
          <button className="ed__ghost" onClick={() => commitEdit({ captionsFor: cutsOf(pieces) })}>Keep them</button>
          <button className="ed__go" onClick={() => { pb.pause(); setSheet('captions') }}>Make captions again</button>
        </div>
      ) : null}

      <nav className={'ed__tools' + (['text', 'transition', 'sound', 'crop', 'canvas', 'speed', 'blur'].includes(panel) ? ' is-hidden' : '')} aria-label="Editing tools">
        <Tool icon={<Scissors />} label="Split" hint="S" onClick={split} disabled={!hist} />
        <Tool icon={<Trash />} label="Delete" hint="Del" onClick={deleteSelected} disabled={!selected || pieces.length < 2} />
        <Tool icon={<Timer />} label="Split at…" onClick={() => togglePanel('at')} on={panel === 'at'} disabled={!hist} />
        <Tool icon={<Grid />} label="Into parts" onClick={() => togglePanel('parts')} on={panel === 'parts'} disabled={!hist || Boolean(project)} title={project ? 'Cuts one clip into equal parts; not for projects' : 'Into parts'} />
        <Tool
          icon={<Speed />}
          label="Speed"
          onClick={() => { pb.pause(); togglePanel('speed') }}
          on={panel === 'speed' || pieces.some((p) => speedMark(p))}
          disabled={!hist}
          title="Slow motion, fast forward, or slow then fast"
        />
        <span className="ed__tools-sep" />
        <Tool icon={<Crop />} label="Crop" onClick={() => { pb.pause(); togglePanel('crop') }} on={panel === 'crop' || Boolean(look.crop)} disabled={!hist || Boolean(project)} title={project ? 'Crop is for a clip of your own; a project uses Canvas for its shape' : 'Crop'} />
        <Tool icon={<Aspect />} label="Canvas" onClick={() => togglePanel('canvas')} on={panel === 'canvas' || look.canvas !== 'original'} disabled={!hist} />
        <Tool
          icon={<Transition />}
          label="Transitions"
          onClick={() => { pb.pause(); setSelectedJoin(null); togglePanel('transition') }}
          on={panel === 'transition' || pieces.some((p) => p.transition) || Boolean(look.fadeIn || look.fadeOut)}
          disabled={!hist}
        />
        <Tool icon={<Film />} label="Add clip" onClick={() => { pb.pause(); setSheet('clip-pick') }} disabled={!hist} />
        <span className="ed__tools-sep" />
        <Tool icon={<Sparkle />} label="Templates" onClick={() => { pb.pause(); setSheet('looks') }} disabled={!hist} />
        <Tool icon={<TextIcon />} label="Text" onClick={addText} disabled={!hist} />
        <Tool
          icon={<Pencil />}
          label="Blur"
          onClick={startBlur}
          on={panel === 'blur' || Boolean(selectedBlur)}
          disabled={!hist}
          title="Blur out part of the picture: a face, a name, a number plate"
        />
        <Tool
          icon={<Captions />}
          label="Captions"
          onClick={() => { pb.pause(); setSheet('captions') }}
          on={texts.some((x) => x.caption)}
          disabled={!info || !(info.hasAudio || anySound)}
          title={info && !(info.hasAudio || anySound) ? 'Nothing in this edit has sound to caption yet' : 'Auto captions from the speech, voice-overs included'}
        />
        <Tool icon={<Photo />} label="Add picture" onClick={() => { pb.pause(); setSheet('image-pick') }} disabled={!hist} />
        <span className="ed__tools-sep" />
        <Tool
          icon={<Music />}
          label="Add sound"
          onClick={() => { pb.pause(); setSheet('audio-pick') }}
          on={panel === 'sound' || sounds.length > 0}
          disabled={!hist}
        />
        <Tool
          icon={soundOff ? <VolumeOff /> : <VolumeOn />}
          label={soundOff ? 'Clip sound off' : 'Clip sound'}
          onClick={() => setSoundOff((s) => !s)}
          on={soundOff}
          disabled={!info || !clipsHaveSound}
          title={info && !clipsHaveSound ? 'The clips here have no sound' : 'Turn the clips\' own sound off, for the preview and the export'}
        />
        {!project ? <Tool icon={<Download />} label="Extract audio" onClick={() => { pb.pause(); setSheet('audio') }} disabled={!info || !info.hasAudio} /> : null}
      </nav>
      </div>

      {sheet === 'export' ? (
        <ExportSheet
          video={video}
          bucket={bucket}
          pieces={pieces}
          total={total}
          hasAudio={clipsHaveSound}
          soundOff={soundOff}
          onSoundOff={setSoundOff}
          sounds={edit.sounds || []}
          look={edit.look}
          texts={edit.texts}
          info={info}
          mode={outMode}
          onMode={setOutMode}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'looks' ? <LooksSheet current={lookNow} onApply={applyLook} onClose={() => setSheet(null)} /> : null}
      {sheet === 'captions' || sheet === 'captions-auto' ? (
        <CaptionsSheet
          auto={sheet === 'captions-auto'}
          video={video}
          pieces={pieces}
          sounds={sounds}
          clipSound={!soundOff && clipsHaveSound}
          existing={texts.filter((x) => x.caption).length}
          onWords={setCaptions}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'clip-pick' ? <ClipSheet bucket={bucket} mainId={video.id} onPick={addClip} onClose={() => setSheet(null)} /> : null}
      {sheet === 'audio' ? <AudioSheet video={video} bucket={bucket} onClose={() => setSheet(null)} /> : null}
      {sheet === 'audio-pick' ? <MediaSheet kind="audio" bucket={bucket} onPick={addSong} onClose={() => setSheet(null)} /> : null}
      {sheet === 'fill-pick' ? (
        <MediaSheet
          kind="image"
          bucket={bucket}
          forFill
          onPick={(m) => { setSheet(null); setLook({ background: 'image', bgImage: m.id }); flash(`${m.name} now fills the space around the video`) }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'image-pick' ? <MediaSheet kind="image" bucket={bucket} onPick={addPicture} onClose={() => setSheet(null)} /> : null}
    </div>
  )
}
