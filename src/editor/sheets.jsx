import { useEffect, useRef, useState } from 'react'
import { formatClock, isImage } from './model.js'
import { frameSize } from './frame.js'
import { drawText, textFrames } from './text.js'
import { Choice } from './panels.jsx'
import { Captions, Check, Download, Music } from '../icons.jsx'
import {
  captionsStatus, exportCuts, installCaptions, listMedia, pullAudio, transcribe, uploadMedia, videoUrl
} from '../api.js'

export function useEscape (onClose, busy) {
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
export function MediaSheet ({ kind, bucket, onPick, onClose }) {
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

export function Written ({ result }) {
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
 * Each text drawn onto transparent full-size frames, with the same code the
 * preview uses, for the server to lay over the video. A still text is one
 * picture; an animated one is a short run of them. Chrome encodes PNGs off
 * the main thread, so several go at once.
 */
export async function textPictures (texts, info, look, total, onProgress) {
  const { W, H } = frameSize(info, look)
  const jobs = []
  for (const t of texts) {
    if (!(t.start < total) || !t.text.trim()) continue
    for (const f of textFrames(t)) if (f.start < total) jobs.push({ t, f })
  }
  const out = new Array(jobs.length)
  let done = 0
  const one = async (i) => {
    const { t, f } = jobs[i]
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    drawText(c.getContext('2d'), t, W, H, f.time)
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'))
    const png = await new Promise((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.readAsDataURL(blob)
    })
    out[i] = { start: f.start, end: Math.min(f.end, total), png }
    onProgress(++done, jobs.length)
  }
  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(jobs.slice(i, i + 8).map((_, k) => one(i + k)))
  }
  return out
}

export function ExportSheet ({ video, bucket, pieces, total, hasAudio, soundOff, onSoundOff, music, look, texts, info, mode, onMode, onClose }) {
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
        {texts && texts.some((x) => x.caption) ? (
          <p className="sheet__body sheet__extras">
            Captions go out exactly as they are now. If a word is wrong, close this and click the caption to fix it first.
          </p>
        ) : null}

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

export function AudioSheet ({ video, bucket, onClose }) {
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

/**
 * Captions from the speech in the edit, worked out on this computer. The
 * first time, it offers the one-off download of the program and its language
 * model; after that it just listens and returns timed words.
 */
export function CaptionsSheet ({ video, pieces, existing, onWords, onClose }) {
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
          Listens to the speech in your edit and writes it out, timed word by word. It all
          happens on this computer; nothing is uploaded.
        </p>
        <ul className="sheet__points">
          <li>
            <strong>Make your cuts first.</strong> Captions are timed to the edit as it is right
            now. If you split, delete, trim or move pieces afterwards, captions can end up at
            the wrong moment, and the app will offer to make them again.
          </li>
          <li>
            <strong>Check them before you export.</strong> Speech recognition gets names and
            unusual words wrong sometimes. Click any caption, on the picture or the timeline, to
            fix a word or change how it looks. Nothing is final until you export.
          </li>
          {existing ? <li>This replaces the {existing} captions already there. Undo brings them back.</li> : null}
        </ul>

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
