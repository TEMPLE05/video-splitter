import { useEffect, useState } from 'react'
import { Folder } from './icons.jsx'
import { browse, setSource } from './api.js'

/**
 * A browser cannot hand the server a real folder path, so we walk the disk
 * server-side instead. Typing or pasting a path still works for speed.
 */
export default function SourcePicker ({ current, onPicked, onCancel }) {
  const [dir, setDir] = useState(current || null)
  const [parent, setParent] = useState(null)
  const [entries, setEntries] = useState([])
  const [manual, setManual] = useState(current || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    browse(dir)
      .then((data) => {
        if (cancelled) return
        setEntries(data.entries)
        setParent(data.parent)
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [dir])

  async function choose (target) {
    const value = (target || '').trim()
    if (!value) return
    setLoading(true)
    try {
      onPicked(await setSource(value))
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div className="picker">
      <div className="picker__card">
        <header className="picker__head">
          <h1 className="picker__title">Choose your video folder</h1>
          <p className="picker__sub">
            Point this at the folder you copy phone videos into. Buckets are created as
            subfolders inside it.
          </p>
        </header>

        <form
          className="picker__manual"
          onSubmit={(e) => { e.preventDefault(); choose(manual) }}
        >
          <input
            className="picker__input"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Paste a path, for example C:\Users\HP\Videos\Inbox"
            aria-label="Folder path"
            spellCheck={false}
          />
          <button className="pill pill--solid" type="submit" disabled={!manual.trim()}>
            Use this
          </button>
        </form>

        <div className="picker__divider"><span>or browse</span></div>

        <div className="picker__crumbs">
          <button className="crumb" onClick={() => setDir(null)}>Drives</button>
          {dir ? <span className="crumb__here" title={dir}>{dir}</span> : null}
        </div>

        <div className="picker__list">
          {loading ? <p className="picker__status">Loading…</p> : null}
          {error ? <p className="picker__status picker__status--error">{error}</p> : null}

          {!loading && parent ? (
            <button className="entry entry--up" onClick={() => setDir(parent)}>
              <span className="entry__icon">↰</span> Up one level
            </button>
          ) : null}

          {!loading && entries.map((entry) => (
            <button key={entry.path} className="entry" onClick={() => setDir(entry.path)}>
              <span className="entry__icon"><Folder size={17} /></span>
              <span className="entry__name">{entry.name}</span>
            </button>
          ))}

          {!loading && !error && entries.length === 0 ? (
            <p className="picker__status">No subfolders here.</p>
          ) : null}
        </div>

        <footer className="picker__foot">
          {onCancel ? (
            <button className="pill" onClick={onCancel}>Cancel</button>
          ) : <span />}
          <button
            className="pill pill--solid"
            disabled={!dir || loading}
            onClick={() => choose(dir)}
          >
            Use this folder
          </button>
        </footer>
      </div>
    </div>
  )
}
