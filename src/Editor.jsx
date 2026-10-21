import { newId } from './editor/model.js'
import { useEffect, useRef, useState } from 'react'
import Timeline from './editor/Timeline.jsx'
import Stage, { ASPECTS } from './editor/Stage.jsx'
import { CAPTION_LOOK, captionChunks, newText, rescaleWords, retimeWords } from './editor/text.js'
import { Choice, PartsSplit, SoundPanel, TextPanel, Tool, TypedSplit } from './editor/panels.jsx'
import { AudioSheet, CaptionsSheet, ExportSheet, MediaSheet } from './editor/sheets.jsx'
import usePlayback from './editor/usePlayback.js'
import {
  formatClock, imagePiece, initial, insertAfter, isImage, offsets as offsetsOf, parseClock, removePiece, splitAt,
  splitEvenly, total as totalOf, trimPiece
} from './editor/model.js'
import {
  Aspect, Back, Captions, Crop, Download, Grid, Minus, Music, Pause, Photo, Play, Plus, Redo, Scissors,
  TextIcon, Timer, Trash, Undo, VolumeOff, VolumeOn
} from './icons.jsx'
import { getStrip, getWave, loadEdit, probeVideo, saveEdit, videoUrl } from './api.js'

const MIN_PIECE = 0.1
const MAX_PPS = 400
const HISTORY = 100
const PLAIN_LOOK = { crop: null, canvas: 'original', background: 'blur' }
const SHAPES = ['9:16', '1:1', '4:5', '16:9']

/** A fingerprint of the cuts, to tell when captions were made for other cuts. */
const cutsOf = (pieces) => pieces.map((p) => (isImage(p) ? 'i' + (p.end - p.start).toFixed(2) : (p.src || '') + p.start.toFixed(2) + '-' + p.end.toFixed(2))).join('|')

const freshEdit = (duration) => ({ pieces: initial(duration), music: null, look: PLAIN_LOOK, texts: [] })

/** True when an edit is still the untouched clip, so there is nothing to keep. */
function isPristine (e, duration) {
  const p = e.pieces
  return p.length === 1 && !isImage(p[0]) && !p[0].src && p[0].start < 1e-3 && Math.abs(p[0].end - duration) < 1e-3 &&
    !e.music && !(e.texts && e.texts.length) && !e.look.crop && e.look.canvas === 'original' &&
    !e.fadeIn && !e.fadeOut && !(e.pieces[0].transition)
}

/** A saved edit made safe to open: pieces kept inside the clip as it is now. */
function restoreEdit (saved, duration) {
  const e = saved && saved.edit
  if (!e || !Array.isArray(e.pieces)) return null
  const pieces = e.pieces
    .map((p) => (isImage(p) || p.src ? p : { ...p, start: Math.max(0, p.start), end: Math.min(duration, p.end) }))
    .filter((p) => p.end - p.start >= 0.05)
  if (!pieces.length) return null
  return { ...freshEdit(duration), ...e, pieces, look: { ...PLAIN_LOOK, ...(e.look || {}) }, texts: e.texts || [] }
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
export default function Editor ({ video, bucket, onBack }) {
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState(null)

  // Undo history over the whole edit. The drafts hold a drag in progress so
  // it becomes one undo step when it ends, not hundreds.
  const [hist, setHist] = useState(null)
  const [draft, setDraft] = useState(null)
  const [lookDraft, setLookDraft] = useState(null)
  const [musicDraft, setMusicDraft] = useState(null)
  const lookDraftRef = useRef(null)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedTextId, setSelectedTextId] = useState(null)
  const [textDraft, setTextDraft] = useState(null)
  // Only a text just added takes the keyboard; one brought back by redo must not.
  const [freshTextId, setFreshTextId] = useState(null)

  const [strip, setStrip] = useState(null)
  const [stripImg, setStripImg] = useState(null)
  const [wave, setWave] = useState(null)
  const [songWave, setSongWave] = useState(null)
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
  const noteTimer = useRef(0)
  const trimBase = useRef(null)

  const edit = hist?.present
  const pieces = draft ?? edit?.pieces ?? []
  const look = lookDraft ?? edit?.look ?? PLAIN_LOOK
  const music = edit?.music ? { ...edit.music, ...(musicDraft || {}) } : null
  const texts = textDraft ?? edit?.texts ?? []
  const selectedText = texts.find((x) => x.id === selectedTextId) || null
  const total = totalOf(pieces)
  const fps = info?.fps || 30
  const frame = 1 / fps
  const duration = info?.duration || 0

  const pb = usePlayback(pieces, edit?.pieces, fps, {
    videoMuted: previewMuted || soundOff,
    musicMuted: previewMuted,
    music: music ? { url: videoUrl(music.id), offset: music.offset, volume: music.volume, duration: music.duration } : null
  })

  useEffect(() => {
    let cancelled = false
    probeVideo(video.id)
      .then((d) => {
        if (cancelled) return
        if (!d.hasVideo) throw new Error('This file has no picture to edit.')
        if (!(d.duration > 0)) throw new Error('Could not read how long this clip is.')
        setInfo(d)
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

    // The strip and the waveform decode the whole file the first time, which
    // takes a second or two on an episode, so the editor opens without them.
    getStrip(video.id)
      .then((s) => {
        if (cancelled) return
        setStrip(s)
        if (s.none) return
        const img = new Image()
        img.onload = () => { if (!cancelled) setStripImg(img) }
        img.src = s.image
      })
      .catch(() => { if (!cancelled) setStrip({ none: true }) })
    getWave(video.id)
      .then((w) => {
        if (cancelled) return
        setWave({ rate: w.rate, peaks: w.hasAudio && w.peaks ? decodePeaks(w.peaks) : null })
      })
      .catch(() => { if (!cancelled) setWave({ rate: 50, peaks: null }) })

    return () => { cancelled = true; clearTimeout(noteTimer.current) }
  }, [video.id])

  // The song's waveform, for its lane on the timeline.
  const songId = edit?.music?.id
  useEffect(() => {
    if (!songId) { setSongWave(null); return }
    let cancelled = false
    getWave(songId)
      .then((w) => { if (!cancelled) setSongWave({ id: songId, rate: w.rate, peaks: w.peaks ? decodePeaks(w.peaks) : null }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [songId])

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
    const pristine = isPristine(hist.present, info.duration)
    if (pristine && !savedAt) return
    const job = { edit: hist.present, extra: { soundOff, outMode } }
    pendingSave.current = job
    const timer = setTimeout(() => {
      pendingSave.current = null
      saveEdit(video.id, job.edit, job.extra).then((r) => setSavedAt(r.savedAt)).catch(() => {})
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist?.present, soundOff, outMode, info])

  useEffect(() => () => {
    const job = pendingSave.current
    if (job) {
      // keepalive lets the save finish even as the editor closes.
      fetch('/api/edit/' + encodeURIComponent(video.id), {
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
  const fitPps = width && duration ? Math.min(MAX_PPS, (width * 0.45) / duration) : 1
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

  function onTrim ({ id, edge, to, phase }) {
    if (phase === 'start') {
      pb.pause()
      trimBase.current = { list: pieces, t: pb.now() }
      setSelectedId(id)
      return
    }
    const base = trimBase.current
    if (!base) return
    const next = trimPiece(base.list, id, edge, to, duration, MIN_PIECE)
    const before = base.list.find((p) => p.id === id)
    const after = next.find((p) => p.id === id)

    if (phase === 'move') {
      setDraft(next)
      // Pulling the left edge keeps the frames where they are and moves the
      // edge, so the handle stays under the pointer. Everything after a right
      // edge ripples along live.
      if (edge === 'start') pb.setTime(base.t - (after.start - before.start))
      if (!isImage(after)) pb.peek(edge === 'start' ? after.start : Math.max(after.start, after.end - frame))
      return
    }

    trimBase.current = null
    setDraft(null)
    if (phase === 'cancel' || (after.start === before.start && after.end === before.end)) {
      pb.seek(base.t, base.list)
      return
    }
    if (edge === 'start') pb.setTime(base.t - (after.start - before.start))
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

  async function addSong (media) {
    setSheet(null)
    let length = 0
    try {
      length = (await probeVideo(media.id)).duration || 0
    } catch { /* plays anyway; the lane just runs to the end of the edit */ }
    commitEdit({ music: { id: media.id, name: media.name, duration: length, offset: 0, volume: 1 } })
    if (info?.hasAudio && !soundOff) {
      setSoundOff(true)
      flash(`Added ${media.name}. The clip's own sound is now off; turn Clip sound back on to hear both.`)
    } else {
      flash(`Added ${media.name}. Drag the green bar to choose which part of it plays.`)
    }
    setPanel('sound')
  }

  function onMusic ({ offset, phase }) {
    if (!edit?.music) return
    if (phase === 'start') { pb.pause(); return }
    const len = edit.music.duration || total
    const o = Math.min(Math.max(offset, -(total - 0.2)), Math.max(0, len - 0.2))
    if (phase === 'move') { setMusicDraft({ offset: o }); return }
    setMusicDraft(null)
    if (phase === 'end' && Math.abs(o - edit.music.offset) > 0.001) commitEdit({ music: { ...edit.music, offset: o } })
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

  const selectPiece = (id) => { setSelectedId(id); if (id) { setSelectedTextId(null); setNote(null) } }
  const selectText = (id) => {
    setSelectedTextId(id)
    if (id) { setSelectedId(null); setNote(null); setPanel('text') } else if (panel === 'text') setPanel(null)
  }

  function addText () {
    if (!hist) return
    pb.pause()
    const T = pb.now()
    const len = Math.min(3, total)
    const start = Math.max(0, Math.min(T, total - len))
    const item = newText(start, start + len)
    commitEdit({ texts: [...texts, item] })
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
  function onText ({ id, start, end, phase }) {
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
    const next = base.map((x) => (x.id === id ? fit(x) : x))
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

  /** The style of one caption, copied to every caption. */
  function styleAllCaptions (from) {
    const look = { x: from.x, y: from.y, size: from.size, font: from.font, style: from.style, color: from.color, anim: from.anim || 'none', hl: from.hl }
    commitEdit({ texts: edit.texts.map((x) => (x.caption ? { ...x, ...look } : x)) })
    flash('Every caption now looks and moves like this one')
  }

  function setCaptions (words) {
    const chunks = captionChunks(words).filter((c) => c.start < total)
    const keep = (edit.texts || []).filter((x) => !x.caption)
    // A caption style already chosen carries over to the new captions.
    const was = (edit.texts || []).find((x) => x.caption)
    const style = was
      ? { x: was.x, y: was.y, size: was.size, font: was.font, style: was.style, color: was.color, anim: was.anim === 'karaoke' || was.anim ? was.anim : 'none', hl: was.hl }
      : CAPTION_LOOK
    const made = chunks.map((c) => ({ id: newId(), caption: true, text: c.text, start: c.start, end: Math.min(c.end, total), words: c.words, ...CAPTION_LOOK, ...style }))
    commitEdit({ texts: [...keep, ...made], captionsFor: cutsOf(pieces) })
    setSheet(null)
    selectText(null)
    flash(made.length
      ? `Added ${made.length} captions. Check them before you export: click any caption to fix a word.`
      : 'No speech was found in this edit')
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
      if (ctrl || e.altKey) return

      switch (e.code) {
        case 'Space': e.preventDefault(); pb.toggle(); break
        case 'KeyS': e.preventDefault(); split(); break
        case 'Delete':
        case 'Backspace': e.preventDefault(); selectedTextId ? deleteText(selectedTextId) : deleteSelected(); break
        case 'ArrowLeft': e.preventDefault(); pb.seek(clampT(pb.now() - (e.shiftKey ? 1 : frame))); break
        case 'ArrowRight': e.preventDefault(); pb.seek(clampT(pb.now() + (e.shiftKey ? 1 : frame))); break
        case 'Home': e.preventDefault(); pb.seek(0); break
        case 'End': e.preventDefault(); pb.seek(total); break
        case 'Equal':
        case 'NumpadAdd': zoomBy(1.5); break
        case 'Minus':
        case 'NumpadSubtract': zoomBy(1 / 1.5); break
        case 'KeyM': setPreviewMuted((m) => !m); break
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

  const outputs = outMode === 'join' ? 1 : pieces.length
  const outLabel = outMode === 'join' ? '1 video' : `${outputs} file${outputs === 1 ? '' : 's'}`
  const togglePanel = (name) => setPanel((p) => (p === name ? null : name))

  let status = ''
  if (note) status = note
  else if (selectedText) status = `${selectedText.caption ? 'Caption' : 'Text'} · ${formatClock(selectedText.start, true)} to ${formatClock(selectedText.end, true)} · drag it on the picture to move it`
  else if (selected && isImage(selected)) status = `Picture · shows for ${formatClock(selected.end - selected.start, true)} · drag the white handles to change`
  else if (selected) status = `Piece ${selectedIndex + 1} of ${pieces.length} · ${formatClock(selected.end - selected.start, true)} · drag the white handles to trim`
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
          {hist && info && !isPristine(hist.present, info.duration) ? (
            <button className="ed__ghost" onClick={startOver} title="Back to the whole clip, untouched">Start over</button>
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
        src={videoUrl(video.id)}
        stillUrl={pb.still ? videoUrl(pb.still) : undefined}
        onClick={() => hist && pb.toggle()}
        loading={!hist}
        texts={texts}
        selectedTextId={selectedTextId}
        onSelectText={selectText}
        onMoveText={onMoveText}
      />
      {/* The added song plays from here, kept in step by the playback engine. */}
      <audio ref={pb.audioRef} src={music ? videoUrl(music.id) : undefined} preload="auto" />

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
        strip={strip}
        stripImg={stripImg}
        images={imagesRef.current}
        peaks={wave ? wave.peaks : undefined}
        waveRate={wave?.rate || 50}
        soundOff={soundOff}
        music={music ? { ...music, peaks: songWave?.id === music.id ? songWave.peaks : null, rate: songWave?.rate } : null}
        musicDragging={Boolean(musicDraft)}
        selectedId={selectedId}
        onWidth={setWidth}
        onSeek={(T) => pb.seek(clampT(T))}
        onSelect={selectPiece}
        texts={texts}
        selectedTextId={selectedTextId}
        onText={onText}
        onAddText={addText}
        onTrim={onTrim}
        onZoom={zoomBy}
        onMusic={onMusic}
        onAddMusic={() => { pb.pause(); setSheet('audio-pick') }}
      />

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
          <Choice on={look.background !== 'black'} onClick={() => setLook({ background: 'blur' })}>Blur</Choice>
          <Choice on={look.background === 'black'} onClick={() => setLook({ background: 'black' })}>Black</Choice>
          <button className="ed__go" onClick={() => setPanel(null)}>Done</button>
        </div>
      ) : null}
      {panel === 'text' && selectedText ? (
        <TextPanel
          key={selectedText.id}
          item={selectedText}
          fresh={freshTextId === selectedText.id}
          onUndo={undo}
          onRedo={redo}
          captions={texts.filter((x) => x.caption).length}
          onChange={(patch, key) => updateText(selectedText.id, patch, key)}
          onStyleAll={() => styleAllCaptions(selectedText)}
          onDelete={() => deleteText(selectedText.id)}
          onClose={() => selectText(null)}
        />
      ) : null}
      {panel === 'sound' && music ? (
        <SoundPanel
          music={music}
          clipSound={!soundOff}
          canClipSound={Boolean(info?.hasAudio)}
          onClipSound={(on) => setSoundOff(!on)}
          onVolume={(v, done) => {
            if (!done) setMusicDraft({ volume: v })
            else { setMusicDraft(null); if (v !== edit.music.volume) commitEdit({ music: { ...edit.music, volume: v } }) }
          }}
          onReplace={() => setSheet('audio-pick')}
          onRemove={() => { commitEdit({ music: null }); setPanel(null); flash('Removed the added sound') }}
          onClose={() => setPanel(null)}
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

      <nav className="ed__tools" aria-label="Editing tools">
        <Tool icon={<Scissors />} label="Split" hint="S" onClick={split} disabled={!hist} />
        <Tool icon={<Trash />} label="Delete" hint="Del" onClick={deleteSelected} disabled={!selected || pieces.length < 2} />
        <Tool icon={<Timer />} label="Split at…" onClick={() => togglePanel('at')} on={panel === 'at'} disabled={!hist} />
        <Tool icon={<Grid />} label="Into parts" onClick={() => togglePanel('parts')} on={panel === 'parts'} disabled={!hist} />
        <span className="ed__tools-sep" />
        <Tool icon={<Crop />} label="Crop" onClick={() => { pb.pause(); togglePanel('crop') }} on={panel === 'crop' || Boolean(look.crop)} disabled={!hist} />
        <Tool icon={<Aspect />} label="Canvas" onClick={() => togglePanel('canvas')} on={panel === 'canvas' || look.canvas !== 'original'} disabled={!hist} />
        <Tool icon={<TextIcon />} label="Text" onClick={addText} disabled={!hist} />
        <Tool
          icon={<Captions />}
          label="Captions"
          onClick={() => { pb.pause(); setSheet('captions') }}
          on={texts.some((x) => x.caption)}
          disabled={!info || !info.hasAudio}
          title={info && !info.hasAudio ? 'This clip has no sound to caption' : 'Auto captions from the speech'}
        />
        <Tool icon={<Photo />} label="Add picture" onClick={() => { pb.pause(); setSheet('image-pick') }} disabled={!hist} />
        <span className="ed__tools-sep" />
        <Tool
          icon={<Music />}
          label={music ? 'Sound' : 'Add sound'}
          onClick={() => { pb.pause(); music ? togglePanel('sound') : setSheet('audio-pick') }}
          on={panel === 'sound' || Boolean(music)}
          disabled={!hist}
        />
        <Tool
          icon={soundOff ? <VolumeOff /> : <VolumeOn />}
          label={soundOff ? 'Clip sound off' : 'Clip sound'}
          onClick={() => setSoundOff((s) => !s)}
          on={soundOff}
          disabled={!info || !info.hasAudio}
          title={info && !info.hasAudio ? 'This clip has no sound' : 'Turn the clip\'s own sound off, for the preview and the export'}
        />
        <Tool icon={<Download />} label="Extract audio" onClick={() => { pb.pause(); setSheet('audio') }} disabled={!info || !info.hasAudio} />
      </nav>

      {sheet === 'export' ? (
        <ExportSheet
          video={video}
          bucket={bucket}
          pieces={pieces}
          total={total}
          hasAudio={info.hasAudio}
          soundOff={soundOff}
          onSoundOff={setSoundOff}
          music={edit.music}
          look={edit.look}
          texts={edit.texts}
          info={info}
          mode={outMode}
          onMode={setOutMode}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'captions' ? (
        <CaptionsSheet
          video={video}
          pieces={pieces}
          existing={texts.filter((x) => x.caption).length}
          onWords={setCaptions}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'audio' ? <AudioSheet video={video} bucket={bucket} onClose={() => setSheet(null)} /> : null}
      {sheet === 'audio-pick' ? <MediaSheet kind="audio" bucket={bucket} onPick={addSong} onClose={() => setSheet(null)} /> : null}
      {sheet === 'image-pick' ? <MediaSheet kind="image" bucket={bucket} onPick={addPicture} onClose={() => setSheet(null)} /> : null}
    </div>
  )
}
