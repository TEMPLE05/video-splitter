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

  useEffect(() => {
    getState()
      .then(setState)
      .catch((err) => setError(err.message))
  }, [])

  if (error) {
    return (
      <div className="boot boot--error">
        <p>Cannot reach the local server.</p>
        <code>{error}</code>
        <p className="boot__hint">Is it running? Start it with <code>npm run dev</code>.</p>
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
