import { useEffect, useState } from 'react'
import Sorter from './Sorter.jsx'
import SourcePicker from './SourcePicker.jsx'
import { getState } from './api.js'

export default function App () {
  const [state, setState] = useState(null)
  const [picking, setPicking] = useState(false)
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

  const needsFolder = !state.sourceDir || picking

  if (needsFolder) {
    return (
      <SourcePicker
        current={state.sourceDir}
        onPicked={(next) => { setState(next); setPicking(false) }}
        onCancel={state.sourceDir ? () => setPicking(false) : null}
      />
    )
  }

  return <Sorter state={state} onState={setState} onChangeFolder={() => setPicking(true)} />
}
