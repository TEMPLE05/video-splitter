import { useEffect, useRef, useState } from 'react'
import Player from './Player.jsx'
import { Back, Check, Close, Folder, Grid, Help, Plus, Skip, Undo } from './icons.jsx'
import ConfirmRemove from './ConfirmRemove.jsx'
import { assign, createBucket, undo, videoUrl } from './api.js'

// Puts an item back in the order the server sorts by, so a restored video, or
// one whose move failed, lands where it was rather than at the end.
function insertSorted (list, item) {
  if (list.some((x) => x.id === item.id)) return list
  const next = [...list, item]
  next.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return next
}

const SHORTCUTS = [
  ['1 – 9', 'File into that bucket'],
  ['Space', 'Play / pause'],
  ['← →', 'Seek 5 seconds'],
  ['M', 'Sound on / off'],
  ['R', 'Restart the clip'],
  ['S', 'Skip, keep it in the queue'],
  ['B', 'Back to the video before'],
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
  const inFlight = useRef(new Set())
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

  /**
   * Files the current video without waiting for the disk.
   *
   * The queue entry disappears and the bucket count goes up the moment you
   * click, then the server's real count replaces the guess when it arrives.
   * Waiting for the round trip made filing feel broken on a big folder: the
   * count sat still for half a second and further clicks were swallowed.
   */
  async function fileInto (bucket) {
    if (!current || inFlight.current.has(current.id)) return
    const item = current
    inFlight.current.add(item.id)

    onState((s) => ({
      ...s,
      queue: s.queue.filter((q) => q.id !== item.id),
      buckets: s.buckets.map((b) => (b.id === bucket.id ? { ...b, count: b.count + 1 } : b)),
      canUndo: true
    }))
    setToast({ name: item.name, bucket: bucket.name })
    setError(null)

    try {
      const res = await assign(item.id, bucket.id)
      onState((s) => ({
        ...s,
        buckets: s.buckets.map((b) => (b.id === res.bucket.id ? res.bucket : b)),
        canUndo: res.canUndo
      }))
    } catch (err) {
      // Put it back exactly where it was, so a failed move never loses a video.
      onState((s) => ({
        ...s,
        queue: insertSorted(s.queue, item),
        buckets: s.buckets.map((b) =>
          (b.id === bucket.id ? { ...b, count: Math.max(0, b.count - 1) } : b))
      }))
      setToast(null)
      setError(err.message)
    } finally {
      inFlight.current.delete(item.id)
    }
  }

  async function undoLast () {
    if (!state.canUndo) return
    setError(null)
    try {
      const res = await undo()
      const rebuilt = insertSorted(queue, res.restored)
      onState((s) => ({
        ...s,
        queue: insertSorted(s.queue, res.restored),
        buckets: res.bucket
          ? s.buckets.map((b) => (b.id === res.bucket.id ? res.bucket : b))
          : s.buckets,
        canUndo: res.canUndo
      }))
      setToast(null)
      const at = rebuilt.findIndex((q) => q.id === res.restored.id)
      if (at >= 0) setCursor(at)
    } catch (err) {
      setError(err.message)
    }
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
        case 'KeyB':
          setCursor((c) => Math.max(0, c - 1))
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
              {/* Clickable as well as keyed, since a key-only way back is easy
                  to never discover. */}
              <span className="stepper">
                <button
                  className="stepper__btn"
                  onClick={() => setCursor((c) => Math.max(0, c - 1))}
                  disabled={cursor === 0}
                  title="Back to the video before (B)"
                  aria-label="Previous video"
                >
                  <Back size={14} />
                </button>
                <span className="filemeta">{cursor + 1} of {queue.length}</span>
                <button
                  className="stepper__btn"
                  onClick={() => setCursor((c) => c + 1)}
                  disabled={cursor >= queue.length - 1}
                  title="Skip for now (S)"
                  aria-label="Next video"
                >
                  <Skip size={14} />
                </button>
              </span>
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
              disabled={!current}
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
          onDone={(next) => {
            // Stay on the video you were watching. Removing a bucket can push
            // its contents back into the queue and shift every index, so the
            // position is found again by id rather than kept as a number.
            const watching = current?.id
            onState(next)
            setRemoving(null)
            const at = watching ? next.queue.findIndex((q) => q.id === watching) : -1
            setCursor(at >= 0 ? at : Math.min(cursor, Math.max(next.queue.length - 1, 0)))
          }}
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
