import { useEffect, useState } from 'react'
import Sorter from './Sorter.jsx'
import Library from './Library.jsx'
import Editor from './Editor.jsx'
import SourcePicker from './SourcePicker.jsx'
import { getState } from './api.js'

export default function App () {
  const [state, setState] = useState(null)
  const [picking, setPicking] = useState(false)
  const [view, setView] = useState({ name: 'sort' })
  const [error, setError] = useState(null)
  const [retrying, setRetrying] = useState(false)

  function load () {
    setRetrying(true)
    getState()
      .then((next) => { setState(next); setError(null) })
      .catch((err) => setError(err.message))
      .finally(() => setRetrying(false))
  }

  useEffect(load, [])

  // Reachable when the installed app is opened before the server is running,
  // which is easy to do once it has its own icon in the Start menu.
  if (error) {
    return (
      <div className="boot boot--error">
        <img className="boot__logo" src="/icon-192.png" alt="" width="64" height="64" />
        <h1 className="boot__title">The app is not running yet</h1>
        <p className="boot__text">
          Video Splitter needs its server running on this machine before it can
          read your videos.
        </p>
        <p className="boot__text">
          Double-click <strong>Video Splitter</strong> on your desktop, wait for
          the black window to appear, then press Retry.
        </p>
        <button className="pill pill--solid" onClick={load} disabled={retrying}>
          {retrying ? 'Checking…' : 'Retry'}
        </button>
        <code className="boot__detail">{error}</code>
      </div>
    )
  }

  if (!state) return <div className="boot">Loading…</div>

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
