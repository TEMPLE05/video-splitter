import { useEffect, useRef, useState } from 'react'
import Timeline from './editor/Timeline.jsx'
import usePlayback from './editor/usePlayback.js'
import {
  formatClock, initial, parseClock, removePiece, splitAt, splitEvenly, total as totalOf, trimPiece
} from './editor/model.js'
import {
  Back, Check, Download, Grid, Minus, Music, Pause, Play, Plus, Redo, Scissors, Timer, Trash, Undo,
  VolumeOff, VolumeOn
} from './icons.jsx'
import { exportCuts, getStrip, getWave, probeVideo, pullAudio, videoUrl } from './api.js'

const MIN_PIECE = 0.1
const MAX_PPS = 400
const HISTORY = 100

function decodePeaks (b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * The editor, laid out like CapCut on a phone: the picture on top, the
 * timeline under it with the playhead fixed in the middle, the tools along the
 * bottom.
 *
 * The edit is a list of pieces of the clip. Split cuts the piece under the
 * playhead in two, Delete removes the selected piece and closes the gap, and
 * the handles on a selected piece trim it. Export makes one finished video by
 * default; "Into parts" switches it to one file per piece.
 */
export default function Editor ({ video, bucket, onBack }) {
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState(null)

  // Undo history. present is the edit; draft is a trim still being dragged.
  const [hist, setHist] = useState(null)
  const [draft, setDraft] = useState(null)
  const [selectedId, setSelectedId] = useState(null)

  const [strip, setStrip] = useState(null)
  const [stripImg, setStripImg] = useState(null)
  const [wave, setWave] = useState(null)

  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(null)
  const [previewMuted, setPreviewMuted] = useState(false)
  const [soundOff, setSoundOff] = useState(false)
  const [outMode, setOutMode] = useState('join')
  const [panel, setPanel] = useState(null)
  const [sheet, setSheet] = useState(null)
  const [note, setNote] = useState(null)
  const noteTimer = useRef(0)
  const trimBase = useRef(null)

  const pieces = draft ?? hist?.present ?? []
  const total = totalOf(pieces)
  const fps = info?.fps || 30
  const frame = 1 / fps
  const duration = info?.duration || 0

  const pb = usePlayback(pieces, hist?.present, fps, previewMuted || soundOff)

  useEffect(() => {
    let cancelled = false
    probeVideo(video.id)
      .then((d) => {
        if (cancelled) return
        if (!d.hasVideo) throw new Error('This file has no picture to edit.')
        if (!(d.duration > 0)) throw new Error('Could not read how long this clip is.')
        setInfo(d)
        setHist({ past: [], present: initial(d.duration), future: [] })
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

  function flash (text) {
    setNote(text)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 4000)
  }

  /* ------------------------------------------------------------ history */

  function commit (next) {
    if (!next) return false
    setHist((h) => ({ past: [...h.past, h.present].slice(-HISTORY), present: next, future: [] }))
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
      pb.peek(edge === 'start' ? after.start : Math.max(after.start, after.end - frame))
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
        case 'Backspace': e.preventDefault(); deleteSelected(); break
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
          if (panel) setPanel(null)
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

  return (
    <div className="editor" data-pieces={pieces.length}>
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

      <div className="ed__stage" onClick={() => hist && pb.toggle()}>
        {[pb.aRef, pb.bRef].map((ref, k) => (
          <video
            key={k}
            ref={ref}
            className={'ed__video' + (pb.front === k ? ' is-front' : '')}
            src={videoUrl(video.id)}
            preload="auto"
            playsInline
            muted
          />
        ))}
        {!hist ? <span className="ed__loading">Opening…</span> : null}
      </div>

      <div className="ed__transport">
        <button className="ctl" onClick={pb.toggle} disabled={!hist} aria-label={pb.playing ? 'Pause' : 'Play'} title="Play or pause (Space)">
          {pb.playing ? <Pause /> : <Play />}
        </button>
        <span className="clock ed__clock">
          {formatClock(pb.t, true)} <span className="clock__sep">/</span> {formatClock(total, true)}
        </span>
        <span className="ed__status" aria-live="polite">
          {note ?? (selected
            ? `Piece ${selectedIndex + 1} of ${pieces.length} · ${formatClock(selected.end - selected.start, true)} · drag the white handles to trim`
            : pieces.length > 1 ? `${pieces.length} pieces` : '')}
        </span>
        <div className="ed__transport-right">
          <button
            className="ctl"
            onClick={() => setPreviewMuted((m) => !m)}
            title={soundOff ? 'The clip sound is off for the export' : 'Mute the preview (M)'}
            aria-label={previewMuted ? 'Unmute preview' : 'Mute preview'}
            disabled={soundOff}
          >
            {previewMuted || soundOff ? <VolumeOff size={18} /> : <VolumeOn size={18} />}
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
        peaks={wave ? wave.peaks : undefined}
        waveRate={wave?.rate || 50}
        soundOff={soundOff}
        selectedId={selectedId}
        onWidth={setWidth}
        onSeek={(T) => pb.seek(clampT(T))}
        onSelect={(id) => { setSelectedId(id); if (id) setNote(null) }}
        onTrim={onTrim}
        onZoom={zoomBy}
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

      <nav className="ed__tools" aria-label="Editing tools">
        <Tool icon={<Scissors />} label="Split" hint="S" onClick={split} disabled={!hist} />
        <Tool icon={<Trash />} label="Delete" hint="Del" onClick={deleteSelected} disabled={!selected || pieces.length < 2} />
        <Tool icon={<Timer />} label="Split at…" onClick={() => setPanel((p) => (p === 'at' ? null : 'at'))} on={panel === 'at'} disabled={!hist} />
        <Tool icon={<Grid />} label="Into parts" onClick={() => setPanel((p) => (p === 'parts' ? null : 'parts'))} on={panel === 'parts'} disabled={!hist} />
        <Tool
          icon={soundOff ? <VolumeOff /> : <VolumeOn />}
          label={soundOff ? 'Sound off' : 'Sound on'}
          onClick={() => setSoundOff((s) => !s)}
          on={soundOff}
          disabled={!info || !info.hasAudio}
          title={info && !info.hasAudio ? 'This clip has no sound' : 'Turn the clip sound off for the export, so you can add your own'}
        />
        <Tool icon={<Music />} label="Extract audio" onClick={() => { pb.pause(); setSheet('audio') }} disabled={!info || !info.hasAudio} />
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
          mode={outMode}
          onMode={setOutMode}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'audio' ? <AudioSheet video={video} bucket={bucket} onClose={() => setSheet(null)} /> : null}
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

function useEscape (onClose, busy) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])
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
      <ul>{list.map((w) => <li key={w.name}>{w.name}</li>)}</ul>
    </div>
  )
}

function ExportSheet ({ video, bucket, pieces, total, hasAudio, soundOff, onSoundOff, mode, onMode, onClose }) {
  const [fast, setFast] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  useEscape(onClose, busy)

  async function go () {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await exportCuts({
        id: video.id,
        segments: pieces.map((p) => ({ start: p.start, end: p.end })),
        join: mode === 'join',
        stripAudio: soundOff,
        mode: mode === 'parts' && fast ? 'fast' : 'accurate'
      }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const n = pieces.length
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

        <label className="opt">
          <input type="checkbox" checked={soundOff} onChange={(e) => onSoundOff(e.target.checked)} disabled={busy || !hasAudio} />
          <span>
            Remove the sound
            <em>{hasAudio ? 'A silent video, so you can add your own audio.' : 'This clip has no sound anyway.'}</em>
          </span>
        </label>
        {mode === 'parts' ? (
          <label className="opt">
            <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} disabled={busy} />
            <span>
              Fast cut, no re-encode
              <em>Near instant, but each part can only start on a keyframe, so it may begin a few seconds early.</em>
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
            {busy ? 'Exporting…' : result ? 'Export again' : mode === 'join' ? 'Export video' : `Export ${n} file${n === 1 ? '' : 's'}`}
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
