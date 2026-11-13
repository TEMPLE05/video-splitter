import { useEffect, useRef, useState } from 'react'
import Sorter from './Sorter.jsx'
import Library from './Library.jsx'
import CopyGate from './CopyGate.jsx'
import Editor from './Editor.jsx'
import SourcePicker from './SourcePicker.jsx'
import Setup from './Setup.jsx'
import { getState, onArrivals } from './api.js'

const byName = new Intl.Collator(undefined, { numeric: true }).compare

// Roughly twenty seconds of polling. At login the installed app window and the
// server start at the same moment, and the window usually wins, so giving up
// on the first failed request would show an error for something that is about
// to work on its own.
const MAX_TRIES = 25
const GAP_MS = 800

export default function App () {
  const [state, setState] = useState(null)
  const [picking, setPicking] = useState(false)
  // The set-up window, asked for by ?setup; it also opens itself on a first run.
  const [setup, setSetup] = useState(() => new URLSearchParams(window.location.search).has('setup'))
  const [view, setView] = useState({ name: 'sort' })
  const [error, setError] = useState(null)
  const [waiting, setWaiting] = useState(true)
  const [attempt, setAttempt] = useState(0)
  // The last batch of videos that arrived in the folder, for the sorter's note.
  const [arrivals, setArrivals] = useState({ seq: 0, n: 0, first: null })

  // Which library folder you were in and how far down. Held here because the
  // library unmounts while the editor is open, and keeping it inside the
  // library meant every return from the editor dropped you on the first folder.
  const [libraryPlace, setLibraryPlace] = useState({ bucketId: null, scroll: 0 })

  useEffect(() => {
    let cancelled = false
    let timer = null
    let tries = 0
    setWaiting(true)

    async function tryOnce () {
      try {
        const next = await getState()
        if (cancelled) return
        setState(next)
        setError(null)
        setWaiting(false)
      } catch (err) {
        if (cancelled) return
        tries += 1
        setError(err.message)
        if (tries < MAX_TRIES) timer = setTimeout(tryOnce, GAP_MS)
        else setWaiting(false)
      }
    }

    tryOnce()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [attempt])

  // Videos landing in the folder join the queue as they arrive. After a
  // reconnect (the server restarted, say) the queue is checked for any that
  // came in meanwhile.
  const ready = Boolean(state && state.sourceDir)
  const stateRef = useRef(state)
  stateRef.current = state
  useEffect(() => {
    if (!ready) return
    let first = true
    // The new queue and the note go out in one update, so the sorter sees
    // both at once and can keep the video on screen where it is.
    const merge = (items) => {
      const s = stateRef.current
      if (!s || !items.length) return
      const have = new Set(s.queue.map((q) => q.id))
      const added = items.filter((x) => !have.has(x.id))
      if (!added.length) return
      setState((now) => ({ ...now, queue: [...now.queue, ...added.filter((x) => !now.queue.some((q) => q.id === x.id))].sort((p, q) => byName(p.name, q.name)) }))
      setArrivals((n) => ({ seq: n.seq + 1, n: added.length, first: added[0].name }))
    }
    const stop = onArrivals(merge, () => {
      if (first) { first = false; return }
      getState().then((s) => merge(s.queue)).catch(() => { /* next time */ })
    })
    return stop
  }, [ready])

  if (!state && waiting) {
    return (
      <div className="boot">
        <img className="boot__logo" src="/icon-192.png" alt="" width="56" height="56" />
        <p className="boot__text">Waiting for the server…</p>
      </div>
    )
  }

  // Reached when the server really is not coming up, usually because it was
  // never started after a restart.
  if (!state) {
    return (
      <div className="boot boot--error">
        <img className="boot__logo" src="/icon-192.png" alt="" width="64" height="64" />
        <h1 className="boot__title">The app is not running yet</h1>
        <p className="boot__text">
          Video Splitter needs its server running on this machine before it can
          read your videos. Shutting down your PC stops it.
        </p>
        <p className="boot__text">
          Double-click <strong>Video Splitter</strong> on your desktop, then press
          Retry. To skip this every time, run <strong>Start with Windows</strong>
          once and it will start on its own from now on.
        </p>
        <button className="pill pill--solid" onClick={() => setAttempt((a) => a + 1)}>
          Retry
        </button>
        <code className="boot__detail">{error}</code>
      </div>
    )
  }

  if (!state.sourceDir || setup) {
    return (
      <Setup
        state={state}
        onState={setState}
        onDone={() => {
          setSetup(false)
          setView({ name: 'sort' })
          if (window.location.search) window.history.replaceState(null, '', window.location.pathname)
        }}
      />
    )
  }

  if (picking) {
    return (
      <SourcePicker
        current={state.sourceDir}
        onPicked={(next) => { setState(next); setPicking(false); setView({ name: 'sort' }) }}
        onCancel={state.sourceDir ? () => setPicking(false) : null}
      />
    )
  }

  if (view.name === 'edit') {
    const editor = (
      <Editor
        key={view.project ? 'p' + view.project.id : view.video.id}
        video={view.video}
        project={view.project}
        bucket={view.bucket}
        onBack={() => setView({ name: 'library' })}
      />
    )
    if (view.project) return editor
    return (
      <CopyGate key={view.video.id} video={view.video} onBack={() => setView({ name: 'library' })}>
        {editor}
      </CopyGate>
    )
  }

  if (view.name === 'library') {
    return (
      <Library
        state={state}
        onState={setState}
        place={libraryPlace}
        onPlace={setLibraryPlace}
        onOpen={(video, bucket) => setView({ name: 'edit', video, bucket })}
        onOpenProject={(project, bucket) => setView({ name: 'edit', project, bucket })}
        onBack={() => setView({ name: 'sort' })}
      />
    )
  }

  return (
    <Sorter
      state={state}
      onState={setState}
      arrivals={arrivals}
      onChangeFolder={() => setPicking(true)}
      onLibrary={() => setView({ name: 'library' })}
      onSetup={() => setSetup(true)}
    />
  )
}
