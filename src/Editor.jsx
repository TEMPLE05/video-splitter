import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Back, Check, Close, Download, Eye, EyeOff, Pause, Play, Replay, Scissors,
  VolumeOff, VolumeOn
} from './icons.jsx'
import { exportCuts, probeVideo, pullAudio, videoUrl } from './api.js'

const MIN_SEGMENT = 0.1

export function formatTime (seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2)
}

/** Accepts "1:23.45", "83.45" or "83". Returns null if it makes no sense. */
export function parseTime (text) {
  const raw = String(text).trim()
  if (!raw) return null
  if (raw.includes(':')) {
    const bits = raw.split(':')
    if (bits.length !== 2) return null
    const m = Number(bits[0])
    const s = Number(bits[1])
    if (!Number.isFinite(m) || !Number.isFinite(s) || s < 0 || s >= 60) return null
    return m * 60 + s
  }
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** An editable m:ss.ms field that only commits a value it could parse. */
function TimeField ({ value, onCommit, disabled }) {
  const [draft, setDraft] = useState(null)
  const shown = draft === null ? formatTime(value) : draft

  function commit () {
    if (draft === null) return
    const parsed = parseTime(draft)
    setDraft(null)
    if (parsed !== null) onCommit(parsed)
  }

  return (
    <input
      className="timefield"
      value={shown}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
        if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() }
      }}
      aria-label="Time"
      spellCheck={false}
    />
  )
}

export default function Editor ({ video, bucket, onBack }) {
  const videoRef = useRef(null)
  const timelineRef = useRef(null)

  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState(null)

  // Contiguous boundaries, so segments can never overlap or leave a gap.
  // cuts has one more entry than keep: cuts[i]..cuts[i+1] is segment i.
  const [cuts, setCuts] = useState([0, 0])
  const [keep, setKeep] = useState([true])

  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [dragging, setDragging] = useState(null)

  const [stripAudio, setStripAudio] = useState(false)
  const [mode, setMode] = useState('accurate')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

  const [atTime, setAtTime] = useState('')
  const [parts, setParts] = useState(4)
  const [splitError, setSplitError] = useState(null)

  const [audioBusy, setAudioBusy] = useState(false)
  const [audioDone, setAudioDone] = useState(null)
  const [audioError, setAudioError] = useState(null)

  const duration = info?.duration || 0

  useEffect(() => {
    let cancelled = false
    probeVideo(video.id)
      .then((d) => {
        if (cancelled) return
        setInfo(d)
        setCuts([0, d.duration])
        setKeep([true])
      })
      .catch((err) => { if (!cancelled) setLoadError(err.message) })
    return () => { cancelled = true }
  }, [video.id])

  const segments = keep.map((k, i) => ({ index: i, start: cuts[i], end: cuts[i + 1], keep: k }))
  const kept = segments.filter((s) => s.keep)
  const keptLength = kept.reduce((sum, s) => sum + (s.end - s.start), 0)

  const segmentAt = (t) => segments.findIndex((s) => t >= s.start && t < s.end)

  function seek (to) {
    const v = videoRef.current
    if (!v || !duration) return
    const next = Math.min(Math.max(to, 0), duration)
    v.currentTime = next
    setTime(next)
  }

  function togglePlay () {
    const v = videoRef.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }

  function splitHere () {
    const t = time
    const i = cuts.findIndex((c, idx) => idx < cuts.length - 1 && t > c + MIN_SEGMENT && t < cuts[idx + 1] - MIN_SEGMENT)
    if (i < 0) return
    setCuts((cs) => [...cs.slice(0, i + 1), t, ...cs.slice(i + 1)])
    setKeep((ks) => [...ks.slice(0, i), ks[i], ks[i], ...ks.slice(i + 1)])
    setResults(null)
  }

  // Adds a cut at a typed timestamp, so you can split at an exact point
  // without scrubbing the playhead to it first.
  function splitAtTyped (event) {
    event.preventDefault()
    const t = parseTime(atTime)

    if (t === null) {
      setSplitError('Type a time like 1:15, or just seconds')
      return
    }
    if (t <= 0 || t >= duration) {
      setSplitError('Pick a time between 0:00 and ' + formatTime(duration))
      return
    }
    if (cuts.some((c) => Math.abs(c - t) < MIN_SEGMENT)) {
      setSplitError('There is already a cut there')
      return
    }

    const i = cuts.findIndex((c, idx) => idx < cuts.length - 1 && t > c && t < cuts[idx + 1])
    if (i < 0) {
      setSplitError('Cannot split there')
      return
    }

    setCuts((cs) => [...cs.slice(0, i + 1), t, ...cs.slice(i + 1)])
    setKeep((ks) => [...ks.slice(0, i), ks[i], ks[i], ...ks.slice(i + 1)])
    setSplitError(null)
    setAtTime('')
    seek(t)
    setResults(null)
  }

  // Replaces every cut with evenly spaced ones. Explicitly a reset rather than
  // a subdivision, so the result is always exactly the number you asked for.
  function splitEqually (event) {
    event.preventDefault()
    const n = Math.round(Number(parts))

    if (!Number.isFinite(n) || n < 2 || n > 50) {
      setSplitError('Choose between 2 and 50 parts')
      return
    }
    if (!duration || duration / n < MIN_SEGMENT) {
      setSplitError('That would make the parts too short to export')
      return
    }

    const next = []
    for (let i = 0; i <= n; i++) next.push((duration * i) / n)
    next[n] = duration

    setCuts(next)
    setKeep(new Array(n).fill(true))
    setSplitError(null)
    setResults(null)
  }

  function toggleKeep (index) {
    setKeep((ks) => ks.map((k, i) => (i === index ? !k : k)))
    setResults(null)
  }

  // Dropping a boundary merges the two segments it separated. The earlier
  // segment's keep state wins, which is what the eye icons already showed.
  function removeBoundary (i) {
    if (i <= 0 || i >= cuts.length - 1) return
    setCuts((cs) => cs.filter((_, idx) => idx !== i))
    setKeep((ks) => ks.filter((_, idx) => idx !== i))
    setResults(null)
  }

  function moveBoundary (i, to) {
    if (i <= 0 || i >= cuts.length - 1) return
    setCuts((cs) => {
      const low = cs[i - 1] + MIN_SEGMENT
      const high = cs[i + 1] - MIN_SEGMENT
      if (high <= low) return cs
      const next = [...cs]
      next[i] = Math.min(Math.max(to, low), high)
      return next
    })
    setResults(null)
  }

  const timeFromEvent = useCallback((event) => {
    const el = timelineRef.current
    if (!el || !duration) return 0
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
    return ratio * duration
  }, [duration])

  // Dragging is tracked on the window so the pointer can leave the track
  // mid-drag without the handle sticking.
  useEffect(() => {
    if (dragging === null) return
    const onMove = (e) => moveBoundary(dragging, timeFromEvent(e))
    const onUp = () => setDragging(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, timeFromEvent])

  async function doExport () {
    if (kept.length === 0 || busy) return
    setBusy(true)
    setError(null)
    setResults(null)
    try {
      const out = await exportCuts({
        id: video.id,
        segments: kept.map((s) => ({ start: s.start, end: s.end })),
        stripAudio,
        mode
      })
      setResults(out)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // Pulls the whole clip's audio out, not just the kept parts: the point is
  // usually to get the track itself, not a trimmed version of it.
  async function grabAudio (format) {
    if (audioBusy) return
    setAudioBusy(true)
    setAudioError(null)
    setAudioDone(null)
    try {
      setAudioDone(await pullAudio(video.id, format))
    } catch (err) {
      setAudioError(err.message)
    } finally {
      setAudioBusy(false)
    }
  }

  useEffect(() => {
    function onKey (event) {
      const tag = event.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      switch (event.code) {
        case 'Escape': onBack(); break
        case 'Space': event.preventDefault(); togglePlay(); break
        case 'ArrowLeft': event.preventDefault(); seek(time - (event.shiftKey ? 0.1 : 1)); break
        case 'ArrowRight': event.preventDefault(); seek(time + (event.shiftKey ? 0.1 : 1)); break
        case 'KeyS': event.preventDefault(); splitHere(); break
        case 'KeyK': {
          const i = segmentAt(time)
          if (i >= 0) toggleKeep(i)
          break
        }
        case 'KeyM': setMuted((m) => !m); break
        case 'KeyR': seek(0); break
        default: break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (loadError) {
    return (
      <div className="editor">
        <header className="libbar">
          <div className="libbar__left">
            <button className="ctl" onClick={onBack} aria-label="Back"><Back size={18} /></button>
            <h1 className="libbar__title">{video.name}</h1>
          </div>
        </header>
        <p className="libnote libnote--error">{loadError}</p>
      </div>
    )
  }

  const playheadPercent = duration ? (time / duration) * 100 : 0

  return (
    <div className="editor">
      <header className="libbar">
        <div className="libbar__left">
          <button className="ctl" onClick={onBack} title="Back to library (Esc)" aria-label="Back">
            <Back size={18} />
          </button>
          <h1 className="libbar__title" title={video.name}>{video.name}</h1>
          <span className="libbar__crumb">{bucket.name}</span>
        </div>
        <span className="libbar__count">
          {info ? `${info.width}×${info.height}` : ''}
          {info && !info.hasAudio ? <span className="dot">·</span> : null}
          {info && !info.hasAudio ? 'no audio track' : null}
        </span>
      </header>

      <div className="editor__stage">
        <video
          ref={videoRef}
          className="editor__video"
          src={videoUrl(video.id)}
          muted={muted}
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => !dragging && setTime(e.currentTarget.currentTime)}
          onClick={togglePlay}
        />
      </div>

      <div className="editor__controls">
        <button className="ctl" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause /> : <Play />}
        </button>
        <button className="ctl" onClick={() => seek(0)} aria-label="Restart"><Replay size={18} /></button>
        <button className="ctl" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute' : 'Mute'}>
          {muted ? <VolumeOff size={18} /> : <VolumeOn size={18} />}
        </button>
        <span className="clock">
          {formatTime(time)} <span className="clock__sep">/</span> {formatTime(duration)}
        </span>
        <button className="pill pill--solid pill--sm" onClick={splitHere} disabled={!duration}>
          <Scissors size={15} /> Split here <kbd>S</kbd>
        </button>
      </div>

      <div className="splitbar">
        <form className="tool" onSubmit={splitAtTyped}>
          <label className="tool__label" htmlFor="split-at">Split at</label>
          <input
            id="split-at"
            className="tool__time"
            value={atTime}
            onChange={(e) => { setAtTime(e.target.value); setSplitError(null) }}
            placeholder={duration ? '1:15' : '—'}
            disabled={!duration}
            spellCheck={false}
          />
          <button className="tool__go" type="submit" disabled={!duration || !atTime.trim()}>
            Add cut
          </button>
        </form>

        <span className="splitbar__or">or</span>

        <form className="tool" onSubmit={splitEqually}>
          <label className="tool__label" htmlFor="split-n">Split into</label>
          <input
            id="split-n"
            className="tool__n"
            type="number"
            min="2"
            max="50"
            value={parts}
            onChange={(e) => { setParts(e.target.value); setSplitError(null) }}
            disabled={!duration}
          />
          <span className="tool__label">equal parts</span>
          <button className="tool__go" type="submit" disabled={!duration}>
            Apply
          </button>
        </form>

        {splitError ? <span className="splitbar__error">{splitError}</span> : null}
        {duration ? <span className="splitbar__len">Clip is {formatTime(duration)}</span> : null}
      </div>

      {/* The track doubles as the scrub bar: click anywhere to seek, drag a
          handle to move a cut point. */}
      <div
        className="track"
        ref={timelineRef}
        onPointerDown={(e) => {
          if (e.target.closest('.track__handle')) return
          seek(timeFromEvent(e))
        }}
      >
        {segments.map((s) => (
          <div
            key={s.index}
            className={'track__seg' + (s.keep ? '' : ' is-dropped')}
            style={{ left: (s.start / duration) * 100 + '%', width: ((s.end - s.start) / duration) * 100 + '%' }}
            onDoubleClick={(e) => { e.stopPropagation(); toggleKeep(s.index) }}
            title={s.keep ? 'Double-click to drop' : 'Double-click to keep'}
          />
        ))}

        {cuts.slice(1, -1).map((c, i) => (
          <div
            key={i}
            className={'track__handle' + (dragging === i + 1 ? ' is-dragging' : '')}
            style={{ left: (c / duration) * 100 + '%' }}
            onPointerDown={(e) => { e.stopPropagation(); setDragging(i + 1) }}
            title="Drag to move this cut"
          />
        ))}

        <div className="track__playhead" style={{ left: playheadPercent + '%' }} />
      </div>

      <div className="editor__panel">
        <ol className="seglist">
          {segments.map((s) => (
            <li key={s.index} className={'seg' + (s.keep ? '' : ' is-dropped')}>
              <button
                className="seg__eye"
                onClick={() => toggleKeep(s.index)}
                title={s.keep ? 'Drop this part' : 'Keep this part'}
                aria-label={s.keep ? 'Drop part ' + (s.index + 1) : 'Keep part ' + (s.index + 1)}
              >
                {s.keep ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
              <span className="seg__n">{s.index + 1}</span>
              <TimeField
                value={s.start}
                disabled={s.index === 0}
                onCommit={(t) => moveBoundary(s.index, t)}
              />
              <span className="seg__dash">→</span>
              <TimeField
                value={s.end}
                disabled={s.index === segments.length - 1}
                onCommit={(t) => moveBoundary(s.index + 1, t)}
              />
              <span className="seg__len">{(s.end - s.start).toFixed(2)}s</span>
              <button
                className="seg__drop"
                onClick={() => removeBoundary(s.index)}
                disabled={s.index === 0}
                title="Merge with the part above"
                aria-label={'Merge part ' + (s.index + 1) + ' with the one above'}
              >
                <Close size={13} />
              </button>
            </li>
          ))}
        </ol>

        <div className="editor__side">
          <label className="opt">
            <input type="checkbox" checked={stripAudio} onChange={(e) => setStripAudio(e.target.checked)} />
            <span>
              Remove the sound
              <em>Exports a silent clip so you can add your own audio.</em>
            </span>
          </label>

          <label className="opt">
            <input type="checkbox" checked={mode === 'fast'} onChange={(e) => setMode(e.target.checked ? 'fast' : 'accurate')} />
            <span>
              Fast cut, no re-encode
              <em>Near instant, but only lands on keyframes so the cut can drift a second or two.</em>
            </span>
          </label>

          <div className="summary">
            <span>
              <strong>{kept.length}</strong> of {segments.length} part{segments.length === 1 ? '' : 's'}
            </span>
            <span className="summary__len">{keptLength.toFixed(2)}s total</span>
          </div>

          <button className="pill pill--solid" onClick={doExport} disabled={busy || kept.length === 0}>
            <Download size={16} />
            {busy ? 'Exporting…' : 'Export ' + kept.length + ' file' + (kept.length === 1 ? '' : 's')}
          </button>

          {error ? <p className="libnote libnote--error">{error}</p> : null}

          <div className="pullaudio">
            <span className="pullaudio__label">Pull the audio out</span>
            <div className="pullaudio__row">
              <button
                className="tool__go"
                onClick={() => grabAudio('copy')}
                disabled={audioBusy || (info && !info.hasAudio)}
                title="Copies the existing audio with no quality lost"
              >
                {audioBusy ? 'Working…' : 'Keep quality'}
              </button>
              <button
                className="tool__go"
                onClick={() => grabAudio('mp3')}
                disabled={audioBusy || (info && !info.hasAudio)}
                title="Re-encodes to mp3, which more things will play"
              >
                As mp3
              </button>
            </div>
            {info && !info.hasAudio
              ? <p className="pullaudio__note">This clip has no audio track.</p>
              : null}
            {audioError ? <p className="pullaudio__note pullaudio__note--bad">{audioError}</p> : null}
            {audioDone ? (
              <p className="pullaudio__note pullaudio__note--good">
                {audioDone.written.name}
                <br />
                {audioDone.lossless
                  ? 'Copied straight out, nothing re-encoded.'
                  : 'Converted to mp3.'}
              </p>
            ) : null}
          </div>

          {results ? (
            <div className="written">
              <p className="written__head">
                <Check size={14} /> {results.written.length} file
                {results.written.length === 1 ? '' : 's'} written
              </p>
              {/* The full path, because "it went somewhere" is not an answer. */}
              <p className="written__where" title={results.dir}>{results.dir}</p>
              <ul>
                {results.written.map((w) => <li key={w.name}>{w.name}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
