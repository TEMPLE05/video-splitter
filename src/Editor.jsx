import { newId } from './editor/model.js'
import { useEffect, useRef, useState } from 'react'
import Timeline from './editor/Timeline.jsx'
import Stage, { ASPECTS } from './editor/Stage.jsx'
import { frameSize } from './editor/frame.js'
import {
  CAPTION_LOOK, COLORS, FONTS, SIZE_MAX, SIZE_MIN, STYLES, captionChunks, drawText, newText
} from './editor/text.js'
import usePlayback from './editor/usePlayback.js'
import {
  formatClock, imagePiece, initial, insertAfter, isImage, offsets as offsetsOf, parseClock, removePiece, splitAt,
  splitEvenly, total as totalOf, trimPiece
} from './editor/model.js'
import {
  Aspect, Back, Captions, Check, Crop, Download, Grid, Minus, Music, Pause, Photo, Play, Plus, Redo, Scissors,
  TextIcon, Timer, Trash, Undo, VolumeOff, VolumeOn
} from './icons.jsx'
import {
  captionsStatus, exportCuts, getStrip, getWave, installCaptions, listMedia, probeVideo, pullAudio, transcribe,
  uploadMedia, videoUrl
} from './api.js'

const MIN_PIECE = 0.1
const MAX_PPS = 400
const HISTORY = 100
const PLAIN_LOOK = { crop: null, canvas: 'original', background: 'blur' }
const SHAPES = ['9:16', '1:1', '4:5', '16:9']

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
        setHist({ past: [], present: { pieces: initial(d.duration), music: null, look: PLAIN_LOOK, texts: [] }, future: [] })
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
    commitEdit({ texts: (edit.texts || []).map((x) => (x.id === id ? { ...x, ...patch } : x)) }, key)
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
      return { ...x, start: a, end: b }
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
    const look = { x: from.x, y: from.y, size: from.size, font: from.font, style: from.style, color: from.color }
    commitEdit({ texts: edit.texts.map((x) => (x.caption ? { ...x, ...look } : x)) })
    flash('Every caption now looks like this one')
  }

  function setCaptions (words) {
    const chunks = captionChunks(words).filter((c) => c.start < total)
    const keep = (edit.texts || []).filter((x) => !x.caption)
    const made = chunks.map((c) => ({ id: newId(), caption: true, text: c.text, start: c.start, end: Math.min(c.end, total), ...CAPTION_LOOK }))
    commitEdit({ texts: [...keep, ...made] })
    setSheet(null)
    selectText(null)
    flash(made.length
      ? `Added ${made.length} captions. Click one to fix a word or change the style.`
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

function Tool ({ icon, label, hint, on, title, ...rest }) {
  return (
    <button className={'tool' + (on ? ' is-on' : '')} title={title || (hint ? `${label} (${hint})` : label)} {...rest}>
      <span className="tool__icon">{icon}</span>
      <span className="tool__label">{label}</span>
    </button>
  )
}

function Choice ({ on, children, ...rest }) {
  return <button className={'chip' + (on ? ' is-on' : '')} aria-pressed={Boolean(on)} {...rest}>{children}</button>
}

function TypedSplit ({ total, onSubmit, onClose }) {
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  return (
    <form
      className="ed__panel"
      onSubmit={(e) => {
        e.preventDefault()
        const problem = onSubmit(text)
        setError(problem)
        if (!problem) setText('')
      }}
    >
      <label className="ed__panel-label" htmlFor="split-at">Split at</label>
      <input
        id="split-at"
        className="ed__field"
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null) }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        placeholder="1:15"
        autoFocus
        spellCheck={false}
      />
      <span className="ed__panel-hint">on the timeline, 00:00 to {formatClock(total, true)}</span>
      <button className="ed__go" type="submit" disabled={!text.trim()}>Split</button>
      {error ? <span className="ed__panel-error">{error}</span> : null}
    </form>
  )
}

function PartsSplit ({ replacing, total, onSubmit, onClose }) {
  const [n, setN] = useState('5')
  const [error, setError] = useState(null)
  const count = Math.round(Number(n))
  const each = count >= 2 ? total / count : 0
  return (
    <form
      className="ed__panel"
      onSubmit={(e) => {
        e.preventDefault()
        const problem = onSubmit(count)
        setError(problem)
        if (!problem) onClose()
      }}
    >
      <label className="ed__panel-label" htmlFor="split-n">Cut into</label>
      <input
        id="split-n"
        className="ed__field ed__field--n"
        type="number"
        min="2"
        max="100"
        value={n}
        onChange={(e) => { setN(e.target.value); setError(null) }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        autoFocus
      />
      <span className="ed__panel-label">equal parts</span>
      <span className="ed__panel-hint">
        {each ? `about ${formatClock(each, true)} each, saved as separate files` : ''}
        {replacing ? '. Replaces your current cuts; Undo brings them back' : ''}
      </span>
      <button className="ed__go" type="submit" disabled={!(count >= 2)}>Cut</button>
      {error ? <span className="ed__panel-error">{error}</span> : null}
    </form>
  )
}

function SoundPanel ({ music, clipSound, canClipSound, onClipSound, onVolume, onReplace, onRemove, onClose }) {
  const pct = Math.round(music.volume * 100)
  const from = music.offset >= 0
    ? `from ${formatClock(music.offset, true)} into the song`
    : `${formatClock(-music.offset, true)} into the video`
  return (
    <div className="ed__panel">
      <span className="ed__panel-label ed__song" title={music.name}>♪ {music.name}</span>
      <label className="ed__panel-hint ed__vol">
        Volume
        <input
          type="range"
          min="0"
          max="100"
          value={pct}
          onChange={(e) => onVolume(Number(e.target.value) / 100, false)}
          onPointerUp={(e) => onVolume(Number(e.target.value) / 100, true)}
          onKeyUp={(e) => onVolume(Number(e.target.value) / 100, true)}
          aria-label="Song volume"
        />
        <span className="ed__vol-n">{pct}%</span>
      </label>
      <span className="ed__panel-hint">Starts {from}. Drag the green bar to slide it.</span>
      {canClipSound ? (
        <Choice on={clipSound} onClick={() => onClipSound(!clipSound)}>{clipSound ? 'Clip sound on' : 'Clip sound off'}</Choice>
      ) : null}
      <button className="ed__ghost" onClick={onReplace}>Replace</button>
      <button className="ed__ghost ed__ghost--bad" onClick={onRemove}>Remove</button>
      <button className="ed__go" onClick={onClose}>Done</button>
    </div>
  )
}

function useEscape (onClose, busy) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])
}

/**
 * Picks a sound or a picture: one already in this bucket, or one from
 * anywhere on the computer, which is copied into the bucket so the edit (and
 * you) can find it again.
 */
function MediaSheet ({ kind, bucket, onPick, onClose }) {
  const [files, setFiles] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [seconds, setSeconds] = useState('3')
  const inputRef = useRef(null)
  useEscape(onClose, busy)
  const audio = kind === 'audio'
  const secs = Number(seconds)
  const secsOk = audio || (secs >= 0.5 && secs <= 600)

  useEffect(() => {
    let cancelled = false
    listMedia(bucket.id, kind)
      .then((d) => { if (!cancelled) setFiles(d.files) })
      .catch((err) => { if (!cancelled) { setFiles([]); setError(err.message) } })
    return () => { cancelled = true }
  }, [bucket.id, kind])

  const pick = (m) => { if (secsOk) onPick(m, secs) }

  async function upload (file) {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      pick(await uploadMedia(bucket.id, kind, file))
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheetwrap" onClick={() => !busy && onClose()}>
      <div className="sheet sheet--wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">{audio ? 'Add sound' : 'Add a picture'}</h2>
        <p className="sheet__body">
          {audio
            ? 'It plays under the whole edit. The clip\'s own sound is turned off, so it replaces it; you can turn it back on to mix the two.'
            : 'It goes after the selected piece, or at the end, and shows for as long as you choose.'}
        </p>
        {!audio ? (
          <label className="ed__secs">
            Show for
            <input className="ed__field ed__field--n" type="number" min="0.5" max="600" step="0.5" value={seconds} onChange={(e) => setSeconds(e.target.value)} />
            seconds
          </label>
        ) : null}

        <div className="medialist">
          {files === null ? <p className="sheet__body">Looking in “{bucket.name}”…</p> : null}
          {files && !files.length ? (
            <p className="sheet__body">
              No {audio ? 'sound files' : 'pictures'} in “{bucket.name}” yet.
              {audio ? ' Audio you pull out of a clip lands here too.' : ''}
            </p>
          ) : null}
          {(files || []).map((m) => (
            <button key={m.id} className="mediaitem" onClick={() => pick(m)} disabled={busy || !secsOk}>
              {audio ? <Music size={16} /> : <img className="mediaitem__thumb" src={videoUrl(m.id)} alt="" loading="lazy" />}
              <span className="mediaitem__name">{m.name}</span>
              <span className="mediaitem__where">{m.folder ? m.folder + ' folder' : bucket.name}</span>
            </button>
          ))}
        </div>

        {error ? <p className="sheet__error">{error}</p> : null}
        <input
          ref={inputRef}
          type="file"
          accept={audio ? 'audio/*,.mp3,.m4a,.wav,.ogg,.opus,.flac,.aac' : 'image/*'}
          hidden
          onChange={(e) => upload(e.target.files?.[0])}
        />
        <div className="sheet__actions">
          <button className="pill" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="pill pill--solid" onClick={() => inputRef.current?.click()} disabled={busy || !secsOk}>
            {busy ? 'Copying it in…' : 'Choose from this computer…'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Written ({ result }) {
  const list = Array.isArray(result.written) ? result.written : [result.written]
  return (
    <div className="written">
      <p className="written__head">
        <Check size={14} /> {list.length} file{list.length === 1 ? '' : 's'} saved
      </p>
      {/* The full path, because "it went somewhere" is not an answer. */}
      <p className="written__where" title={result.dir}>{result.dir}</p>
      <ul>
        {list.map((w) => (
          <li key={w.name}>
            {w.name}
            {/* A fast cut can only start on a keyframe; say so rather than
                leave the extra seconds as a surprise. */}
            {w.startedAt !== undefined && w.asked - w.startedAt > 0.01 ? (
              <em className="written__early">
                starts at {formatClock(w.startedAt, true)}, {(w.asked - w.startedAt).toFixed(1)} s before your cut, on the nearest keyframe
              </em>
            ) : null}
          </li>
        ))}
      </ul>
      {result.subtitles > 0 ? <p className="written__note">Subtitles kept, timed to the edit.</p> : null}
    </div>
  )
}

/**
 * Each text drawn onto its own transparent full-size frame, with the same
 * code the preview uses, for the server to lay over the video. Chrome encodes
 * PNGs off the main thread, so several go at once.
 */
async function textPictures (texts, info, look, total, onProgress) {
  const { W, H } = frameSize(info, look)
  const items = texts.filter((t) => t.start < total && t.text.trim())
  const out = new Array(items.length)
  let done = 0
  const one = async (i) => {
    const t = items[i]
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    drawText(c.getContext('2d'), t, W, H)
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'))
    const png = await new Promise((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.readAsDataURL(blob)
    })
    out[i] = { start: t.start, end: Math.min(t.end, total), png }
    onProgress(++done, items.length)
  }
  for (let i = 0; i < items.length; i += 8) {
    await Promise.all(items.slice(i, i + 8).map((_, k) => one(i + k)))
  }
  return out
}

function ExportSheet ({ video, bucket, pieces, total, hasAudio, soundOff, onSoundOff, music, look, texts, info, mode, onMode, onClose }) {
  const [fast, setFast] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(null)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  useEscape(onClose, busy)

  // A stream copy cannot crop, fill, add pictures or mix in a song.
  const plain = !music && !look.crop && look.canvas === 'original' && !pieces.some(isImage) && !(texts || []).length

  async function go () {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const overlays = texts && texts.length
        ? await textPictures(texts, info, look, total, (n, of) => setStage(`Preparing text ${n} of ${of}…`))
        : []
      setStage(null)
      setResult(await exportCuts({
        overlays,
        id: video.id,
        segments: pieces.map((p) => (isImage(p)
          ? { kind: 'image', image: p.image, length: p.end - p.start }
          : { start: p.start, end: p.end })),
        join: mode === 'join',
        stripAudio: soundOff,
        mode: mode === 'parts' && fast && plain ? 'fast' : 'accurate',
        music: music ? { id: music.id, offset: music.offset, volume: music.volume } : null,
        look
      }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  const n = pieces.length
  const extras = [
    look.crop ? 'cropped' : null,
    look.canvas !== 'original' ? `${look.canvas} with a ${look.background === 'black' ? 'black' : 'blurred'} fill` : null,
    music ? `♪ ${music.name}` : null,
    texts && texts.some((x) => x.caption) ? 'captions' : null,
    texts && texts.some((x) => !x.caption) ? `${texts.filter((x) => !x.caption).length} text${texts.filter((x) => !x.caption).length === 1 ? '' : 's'}` : null
  ].filter(Boolean)

  return (
    <div className="sheetwrap" onClick={() => !busy && onClose()}>
      <div className="sheet sheet--wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">Export</h2>

        <div className="choices" role="radiogroup" aria-label="What to export">
          <button
            className={'choice' + (mode === 'join' ? ' is-on' : '')}
            role="radio"
            aria-checked={mode === 'join'}
            onClick={() => onMode('join')}
            disabled={busy}
          >
            <strong>One video</strong>
            <span>{n === 1 ? 'The clip as trimmed' : `All ${n} pieces joined in order`}, {formatClock(total, true)} long</span>
          </button>
          <button
            className={'choice' + (mode === 'parts' ? ' is-on' : '')}
            role="radio"
            aria-checked={mode === 'parts'}
            onClick={() => onMode('parts')}
            disabled={busy}
          >
            <strong>Separate parts</strong>
            <span>{n} file{n === 1 ? '' : 's'}, one for each piece</span>
          </button>
        </div>

        {extras.length ? <p className="sheet__body sheet__extras">With: {extras.join(' · ')}</p> : null}

        <label className="opt">
          <input type="checkbox" checked={soundOff} onChange={(e) => onSoundOff(e.target.checked)} disabled={busy || !hasAudio} />
          <span>
            Remove the clip's own sound
            <em>{!hasAudio ? 'This clip has no sound anyway.' : music ? 'Only the added song will play.' : 'A silent video, so you can add your own audio.'}</em>
          </span>
        </label>
        {mode === 'parts' && plain ? (
          <label className="opt">
            <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} disabled={busy} />
            <span>
              Fast cut, no re-encode
              <em>Near instant, but each part can only start on a keyframe, so it may begin a few seconds early. You will be told exactly where.</em>
            </span>
          </label>
        ) : null}

        <p className="sheet__body sheet__where">
          Saved in the <strong>edits</strong> folder inside “{bucket.name}”. The original is not changed.
        </p>

        {error ? <p className="sheet__error">{error}</p> : null}
        {result ? <Written result={result} /> : null}

        <div className="sheet__actions">
          <button className="pill" onClick={onClose} disabled={busy}>{result ? 'Done' : 'Cancel'}</button>
          <button className="pill pill--solid" onClick={go} disabled={busy}>
            <Download size={16} />
            {busy ? (stage || 'Exporting…') : result ? 'Export again' : mode === 'join' ? 'Export video' : `Export ${n} file${n === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function AudioSheet ({ video, bucket, onClose }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  useEscape(onClose, busy)

  async function grab (format) {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await pullAudio(video.id, format))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheetwrap" onClick={() => !busy && onClose()}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">Extract audio</h2>
        <p className="sheet__body">
          Saves the sound of the whole clip as its own file, in the <strong>audio</strong> folder
          inside “{bucket.name}”.
        </p>
        <div className="choices">
          <button className="choice" onClick={() => grab('copy')} disabled={busy}>
            <strong>Keep quality</strong>
            <span>Copied straight out, nothing lost</span>
          </button>
          <button className="choice" onClick={() => grab('mp3')} disabled={busy}>
            <strong>As mp3</strong>
            <span>Plays on anything</span>
          </button>
        </div>
        {busy ? <p className="sheet__body">Working…</p> : null}
        {error ? <p className="sheet__error">{error}</p> : null}
        {result ? <Written result={result} /> : null}
        <div className="sheet__actions">
          <button className="pill" onClick={onClose} disabled={busy}>{result ? 'Done' : 'Close'}</button>
        </div>
      </div>
    </div>
  )
}

function TextPanel ({ item, fresh, captions, onChange, onStyleAll, onDelete, onClose, onUndo, onRedo }) {
  return (
    <div className="ed__panel ed__panel--text">
      <textarea
        className="ed__textin"
        value={item.text}
        rows={2}
        onChange={(e) => onChange({ text: e.target.value }, 'text:' + item.id)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
          // The edit's own undo, so the words and everything else stay in step.
          const ctrl = e.ctrlKey || e.metaKey
          if (ctrl && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? onRedo() : onUndo() }
          if (ctrl && e.code === 'KeyY') { e.preventDefault(); onRedo() }
        }}
        autoFocus={fresh}
        onFocus={(e) => { if (fresh && item.text === 'Your text') e.target.select() }}
        aria-label="Text"
        spellCheck
      />
      <div className="ed__textrow">
        {Object.entries(FONTS).map(([k, f]) => (
          <Choice key={k} on={item.font === k} onClick={() => onChange({ font: k })}>
            <span style={{ font: f.css(13) }}>{f.label}</span>
          </Choice>
        ))}
        <span className="ed__panel-sep" />
        {Object.entries(STYLES).map(([k, label]) => (
          <Choice key={k} on={item.style === k} onClick={() => onChange({ style: k })}>{label}</Choice>
        ))}
      </div>
      <div className="ed__textrow">
        {COLORS.map((c) => (
          <button
            key={c}
            className={'swatch' + (item.color === c ? ' is-on' : '')}
            style={{ background: c }}
            onClick={() => onChange({ color: c })}
            aria-label={'Colour ' + c}
          />
        ))}
        <label className="ed__panel-hint ed__vol">
          Size
          <input
            type="range"
            min={SIZE_MIN * 1000}
            max={SIZE_MAX * 1000}
            value={Math.round(item.size * 1000)}
            onChange={(e) => onChange({ size: Number(e.target.value) / 1000 }, 'size:' + item.id)}
            aria-label="Text size"
          />
        </label>
        <span className="ed__grow" />
        {item.caption && captions > 1 ? <button className="ed__ghost" onClick={onStyleAll}>Use this style for all {captions} captions</button> : null}
        <button className="ed__ghost ed__ghost--bad" onClick={onDelete}>Delete</button>
        <button className="ed__go" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

/**
 * Captions from the speech in the edit, worked out on this computer. The
 * first time, it offers the one-off download of the program and its language
 * model; after that it just listens and returns timed words.
 */
function CaptionsSheet ({ video, pieces, existing, onWords, onClose }) {
  const [st, setSt] = useState(null)
  const [model, setModel] = useState('base')
  const [phase, setPhase] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const alive = useRef(true)
  useEscape(onClose, false)

  useEffect(() => {
    alive.current = true
    captionsStatus()
      .then((s) => {
        if (!alive.current) return
        setSt(s)
        if (s.models.small.ready && !s.models.base.ready) setModel('small')
        if (s.install && !s.install.error && !(s.program && s.models[s.install.model]?.ready)) {
          setModel(s.install.model)
          setPhase('installing')
          watchInstall(s.install.model)
        }
      })
      .catch((err) => setError(err.message))
    return () => { alive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const ready = st && st.program && st.models[model]?.ready

  async function watchInstall (key) {
    for (;;) {
      await wait(500)
      if (!alive.current) return false
      const s = await captionsStatus()
      setSt(s)
      if (s.install?.error) { setError(s.install.error); setPhase('idle'); return false }
      if (s.program && s.models[key].ready) return true
    }
  }

  async function go () {
    setError(null)
    try {
      if (!ready) {
        setPhase('installing')
        setSt(await installCaptions(model))
        if (!(await watchInstall(model))) return
      }
      setPhase('listening')
      setProgress(0)
      const payload = {
        id: video.id,
        model,
        segments: pieces.map((p) => (isImage(p) ? { kind: 'image', length: p.end - p.start } : { start: p.start, end: p.end }))
      }
      for (;;) {
        const r = await transcribe(payload)
        if (!alive.current) return
        if (r.state === 'done') { onWords(r.words); return }
        if (r.state === 'error') throw new Error(r.error)
        setProgress(r.progress || 0)
        await wait(400)
      }
    } catch (err) {
      if (alive.current) { setError(err.message); setPhase('idle') }
    }
  }

  const mb = (n) => Math.round(n / 1048576) + ' MB'
  const inst = st?.install
  const working = phase !== 'idle'

  return (
    <div className="sheetwrap" onClick={() => !working && onClose()}>
      <div className="sheet sheet--wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">Auto captions</h2>
        <p className="sheet__body">
          Listens to the speech in your edit and writes it out, timed word by word, all on this
          computer. Make your cuts first: captions follow the edit as it is now.
          {existing ? ` This replaces the ${existing} captions already there.` : ''}
        </p>

        {st && !st.supported ? (
          <p className="sheet__error">Auto captions need whisper.cpp. Install it so that whisper-cli is on your PATH, then try again.</p>
        ) : null}

        {st && st.supported ? (
          <div className="choices">
            {Object.entries(st.models).map(([k, m]) => (
              <button
                key={k}
                className={'choice' + (model === k ? ' is-on' : '')}
                onClick={() => setModel(k)}
                disabled={working}
                aria-pressed={model === k}
              >
                <strong>{m.label}</strong>
                <span>
                  {k === 'base' ? 'Fast, good for clear speech. ' : 'Slower, copes better with music and accents. '}
                  {m.ready ? 'Ready.' : `One-time download, ${mb(m.size)}.`}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {phase === 'installing' && inst ? (
          <div className="progress">
            <span className="progress__label">
              {inst.phase === 'program' ? 'Downloading the program…' : inst.phase === 'model' ? 'Downloading the language model…' : 'Starting the download…'}
              {inst.total ? ` ${mb(inst.received)} of ${mb(inst.total)}` : ''}
            </span>
            <span className="progress__bar"><span style={{ width: (inst.total ? (100 * inst.received) / inst.total : 2) + '%' }} /></span>
          </div>
        ) : null}
        {phase === 'listening' ? (
          <div className="progress">
            <span className="progress__label">Listening… {Math.round(progress * 100)}%</span>
            <span className="progress__bar"><span style={{ width: Math.max(2, progress * 100) + '%' }} /></span>
          </div>
        ) : null}

        {error ? <p className="sheet__error">{error}</p> : null}

        <div className="sheet__actions">
          <button className="pill" onClick={onClose} disabled={working}>Cancel</button>
          <button className="pill pill--solid" onClick={go} disabled={!st || !st.supported || working}>
            <Captions size={16} />
            {working ? 'Working…' : ready ? 'Make captions' : 'Download and make captions'}
          </button>
        </div>
      </div>
    </div>
  )
}
