import { useEffect, useState } from 'react'
import Sorter from './Sorter.jsx'
import Library from './Library.jsx'
import Editor from './Editor.jsx'
import SourcePicker from './SourcePicker.jsx'
import { getState } from './api.js'

// Roughly twenty seconds of polling. At login the installed app window and the
// server start at the same moment, and the window usually wins, so giving up
// on the first failed request would show an error for something that is about
// to work on its own.
const MAX_TRIES = 25
const GAP_MS = 800

export default function App () {
  const [state, setState] = useState(null)
  const [picking, setPicking] = useState(false)
  const [view, setView] = useState({ name: 'sort' })
  const [error, setError] = useState(null)
  const [waiting, setWaiting] = useState(true)
  const [attempt, setAttempt] = useState(0)

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

  if (!state.sourceDir || picking) {
    return (
      <SourcePicker
        current={state.sourceDir}
        onPicked={(next) => { setState(next); setPicking(false); setView({ name: 'sort' }) }}
        onCancel={state.sourceDir ? () => setPicking(false) : null}
      />
    )
  }

  if (view.name === 'edit') {
    return (
      <Editor
        video={view.video}
        bucket={view.bucket}
        onBack={() => setView({ name: 'library' })}
      />
    )
  }

  if (view.name === 'library') {
    return (
      <Library
        state={state}
        onState={setState}
        onOpen={(video, bucket) => setView({ name: 'edit', video, bucket })}
        onBack={() => setView({ name: 'sort' })}
      />
    )
  }

  return (
    <Sorter
      state={state}
      onState={setState}
      onChangeFolder={() => setPicking(true)}
      onLibrary={() => setView({ name: 'library' })}
    />
  )
}
