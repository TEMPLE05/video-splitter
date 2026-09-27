import { useEffect, useRef, useState } from 'react'
import Player from './Player.jsx'
import { Check, Close, Folder, Grid, Help, Plus, Skip, Undo } from './icons.jsx'
import ConfirmRemove from './ConfirmRemove.jsx'
import { assign, createBucket, undo, videoUrl } from './api.js'

function formatSize (bytes) {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return Math.round(bytes / 1024) + ' KB'
  if (mb < 1024) return mb.toFixed(1) + ' MB'
  return (mb / 1024).toFixed(2) + ' GB'
}

const SHORTCUTS = [
  ['1 – 9', 'File into that bucket'],
  ['Space', 'Play / pause'],
  ['← →', 'Seek 5 seconds'],
  ['M', 'Sound on / off'],
  ['R', 'Restart the clip'],
  ['S', 'Skip, keep it in the queue'],
  ['U', 'Undo the last file'],
  ['L', 'Open the library to edit'],
  ['?', 'This panel']
]

export default function Sorter ({ state, onState, onChangeFolder, onLibrary }) {
  const [cursor, setCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [helpOpen, setHelpOpen] = useState(false)
  const [idle, setIdle] = useState(false)
  const [removing, setRemoving] = useState(null)
  const playerRef = useRef(null)
  const draftRef = useRef(null)

  const queue = state.queue
  const atEnd = cursor >= queue.length
  const current = atEnd ? null : queue[cursor]

  const sorted = state.buckets.reduce((sum, b) => sum + b.count, 0)
  const total = sorted + queue.length
  const percent = total > 0 ? (sorted / total) * 100 : 0

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3600)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (adding && draftRef.current) draftRef.current.focus()
  }, [adding])

  // Chrome fades out when the pointer rests, the way a photo viewer does, so
  // the video is the only thing on screen while it plays.
  useEffect(() => {
    let timer
    function wake () {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), 2800)
    }
    wake()
    window.addEventListener('mousemove', wake)
    window.addEventListener('keydown', wake)
    window.addEventListener('click', wake)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousemove', wake)
      window.removeEventListener('keydown', wake)
      window.removeEventListener('click', wake)
    }
  }, [])

  async function run (fn) {
    if (busy) return null
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function fileInto (bucket) {
    if (!current) return
    const name = current.name
    await run(async () => {
      const next = await assign(current.id, bucket.id)
      onState(next)
      // The cursor stays put: removing this item slides the next one into the
      // same slot, so the queue keeps flowing without a jump.
      setToast({ name, bucket: bucket.name })
    })
  }

  async function undoLast () {
    await run(async () => {
      const next = await undo()
      onState(next)
      setToast(null)
      const at = next.queue.findIndex((q) => q.id === next.restored.id)
      if (at >= 0) setCursor(at)
    })
  }

  async function addBucket (event) {
    event.preventDefault()
    const name = draft.trim()
    if (!name) return
    await run(async () => {
      onState(await createBucket(name))
      setDraft('')
      setAdding(false)
    })
  }

  // An empty bucket goes straight away; anything with contents asks first,
  // because the videos inside have to be moved back to the queue.
  function dropBucket (bucket) {
    setRemoving(bucket)
  }

  // One keydown listener for the whole screen. Filing is the primary action,
  // so the number row is bound closest to the fingers.
  useEffect(() => {
    function onKey (event) {
      const tag = event.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) {
        if (event.key === 'Escape') {
          setAdding(false)
          setDraft('')
        }
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === '?') {
        setHelpOpen((v) => !v)
        return
      }
      if (event.key === 'Escape') {
        setHelpOpen(false)
        return
      }

      if (event.code >= 'Digit1' && event.code <= 'Digit9') {
        const bucket = state.buckets[Number(event.code.slice(5)) - 1]
        if (bucket && current) {
          event.preventDefault()
          fileInto(bucket)
        }
        return
      }

      switch (event.code) {
        case 'Space':
          event.preventDefault()
          playerRef.current && playerRef.current.togglePlay()
          break
        case 'ArrowLeft':
          event.preventDefault()
          playerRef.current && playerRef.current.seek(-5)
          break
        case 'ArrowRight':
          event.preventDefault()
          playerRef.current && playerRef.current.seek(5)
          break
        case 'KeyM':
          playerRef.current && playerRef.current.toggleMute()
          break
        case 'KeyR':
          playerRef.current && playerRef.current.restart()
          break
        case 'KeyS':
          if (!atEnd) setCursor((c) => c + 1)
          break
        case 'KeyL':
          onLibrary()
          break
        case 'KeyU':
          if (state.canUndo) undoLast()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const hide = idle && !helpOpen && !adding && !removing

  return (
    <div className="sorter">
      {current ? (
        <Player
          ref={playerRef}
          item={current}
          src={videoUrl(current.id)}
          nextSrc={queue[cursor + 1] ? videoUrl(queue[cursor + 1].id) : null}
          idle={hide}
        />
      ) : (
        <div className="finished">
          <div className="finished__mark">
            {queue.length === 0 ? <Check size={30} /> : <Skip size={30} />}
          </div>
          <h2 className="finished__title">
            {queue.length === 0 ? 'Inbox empty' : 'End of the queue'}
          </h2>
          <p className="finished__note">
            {queue.length === 0
              ? 'Every video in this folder has been filed.'
              : queue.length + ' skipped and still waiting.'}
          </p>
          {queue.length > 0 ? (
            <button className="pill pill--solid" onClick={() => setCursor(0)}>
              Go through them again
            </button>
          ) : (
            <button className="pill pill--solid" onClick={onChangeFolder}>
              Pick another folder
            </button>
          )}
        </div>
      )}

      <div className="rail" aria-hidden="true">
        <div className="rail__fill" style={{ width: percent + '%' }} />
      </div>

      <header className={'topchrome' + (hide ? ' is-hidden' : '')}>
        <div className="topchrome__left">
          {current ? (
            <>
              <span className="filename" title={current.name}>{current.name}</span>
              <span className="filemeta">{formatSize(current.size)}</span>
            </>
          ) : null}
        </div>
        <div className="topchrome__right">
          <span className="left-count">
            <strong>{sorted}</strong> sorted<span className="dot">·</span>
            <strong>{queue.length}</strong> left
          </span>
          <button className="ctl" onClick={undoLast} disabled={!state.canUndo || busy}
            title="Undo the last file (U)" aria-label="Undo">
            <Undo size={18} />
          </button>
          <button className="ctl" onClick={onLibrary}
            title="Open the library to edit sorted clips (L)" aria-label="Library">
            <Grid size={18} />
          </button>
          <button className="ctl" onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts (?)" aria-label="Shortcuts">
            <Help size={18} />
          </button>
          <button className="ctl" onClick={onChangeFolder}
            title={state.sourceDir} aria-label="Change folder">
            <Folder size={18} />
          </button>
        </div>
      </header>

      <div className={'dock' + (hide ? ' is-dim' : '')}>
        {state.buckets.length === 0 && !adding ? (
          <p className="dock__hint">Make a bucket to start filing</p>
        ) : null}

        {state.buckets.map((bucket, i) => (
          <div className="bubblewrap" key={bucket.id}>
            <button
              className="bubble"
              onClick={() => fileInto(bucket)}
              disabled={!current || busy}
              title={'File into ' + bucket.name}
            >
              {i < 9 ? <span className="bubble__key">{i + 1}</span> : null}
              <span className="bubble__name">{bucket.name}</span>
              <span className="bubble__count">{bucket.count}</span>
            </button>
            <button
              className="bubble__drop"
              onClick={() => dropBucket(bucket)}
              title="Remove from this bar. The folder and its videos stay on disk."
              aria-label={'Remove bucket ' + bucket.name}
            >
              <Close size={12} />
            </button>
          </div>
        ))}

        {adding ? (
          <form className="bubble bubble--form" onSubmit={addBucket}>
            <input
              ref={draftRef}
              className="bubble__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { if (!draft.trim()) setAdding(false) }}
              placeholder="Bucket name"
              aria-label="New bucket name"
            />
            <button className="bubble__go" type="submit" disabled={!draft.trim() || busy}
              aria-label="Create bucket">
              <Check size={14} />
            </button>
          </form>
        ) : (
          <button className="bubble bubble--add" onClick={() => setAdding(true)}
            title="New bucket">
            <Plus size={16} />
          </button>
        )}
      </div>

      {error ? (
        <div className="alert" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss"><Close size={14} /></button>
        </div>
      ) : null}

      {toast ? (
        <div className="toast" role="status">
          <Check size={15} />
          <span>Filed into <strong>{toast.bucket}</strong></span>
          <button className="toast__undo" onClick={undoLast}>Undo</button>
        </div>
      ) : null}

      {removing ? (
        <ConfirmRemove
          bucket={removing}
          onCancel={() => setRemoving(null)}
          onDone={(next) => { onState(next); setRemoving(null); setCursor(0) }}
        />
      ) : null}

      {helpOpen ? (
        <div className="sheetwrap" onClick={() => setHelpOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet__head">
              <h2 className="sheet__title">Shortcuts</h2>
              <button className="ctl" onClick={() => setHelpOpen(false)} aria-label="Close">
                <Close size={16} />
              </button>
            </div>
            <dl className="sheet__list">
              {SHORTCUTS.map(([key, what]) => (
                <div key={key}>
                  <dt><kbd>{key}</kbd></dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
            <p className="sheet__foot" title={state.sourceDir}>{state.sourceDir}</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
