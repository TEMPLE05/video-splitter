import { useEffect, useState } from 'react'
import { Back, Folder } from './icons.jsx'
import { browse, getPlaces, setSource } from './api.js'

const plural = (n) => (n === 1 ? '1 video' : n + ' videos')

/**
 * A browser cannot hand the server a real folder path, so the disk is walked
 * server-side instead. Three ways in, because hunting down a path is the most
 * annoying part of using this: shortcuts to the usual folders, a breadcrumb
 * you can click any level of, and a box to paste a path into.
 */
export default function SourcePicker ({ current, onPicked, onCancel }) {
  const [dir, setDir] = useState(current || null)
  const [data, setData] = useState(null)
  const [places, setPlaces] = useState(null)
  const [manual, setManual] = useState(current || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    getPlaces().then(setPlaces).catch(() => setPlaces({ places: [], drives: [] }))
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    browse(dir)
      .then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((err) => { if (!cancelled) { setError(err.message); setData(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
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

  const here = data && data.dir ? data.videos : null

  return (
    <div className="picker">
      <div className="picker__card">
        <header>
          <h1 className="picker__title">Choose your video folder</h1>
          <p className="picker__sub">
            Point this at the folder you copy phone videos into. Buckets are made
            as subfolders inside it.
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
            placeholder="Paste a folder path"
            aria-label="Folder path"
            spellCheck={false}
          />
          <button className="pill pill--solid" type="submit" disabled={!manual.trim()}>
            Go
          </button>
        </form>

        <div className="browser">
          <aside className="places">
            {places && places.places.length > 0 ? (
              <>
                <h2 className="places__head">Places</h2>
                {places.places.map((p) => (
                  <button
                    key={p.path}
                    className={'place' + (data && data.dir === p.path ? ' is-on' : '')}
                    onClick={() => { setDir(p.path); setManual(p.path) }}
                    title={p.path}
                  >
                    <span className="place__name">{p.label}</span>
                    {p.videos ? <span className="place__n">{p.videos}</span> : null}
                  </button>
                ))}
              </>
            ) : null}

            {places && places.drives.length > 0 ? (
              <>
                <h2 className="places__head">Drives</h2>
                {places.drives.map((d) => (
                  <button
                    key={d.path}
                    className={'place' + (data && data.dir === d.path ? ' is-on' : '')}
                    onClick={() => { setDir(d.path); setManual(d.path) }}
                  >
                    <span className="place__name">{d.name}</span>
                  </button>
                ))}
              </>
            ) : null}
          </aside>

          <div className="browser__main">
            <div className="crumbs">
              {data && data.parent ? (
                <button className="crumb crumb--up" onClick={() => setDir(data.parent)} title="Up one level">
                  <Back size={15} />
                </button>
              ) : null}
              {data && data.crumbs && data.crumbs.length > 0 ? (
                data.crumbs.map((c, i) => (
                  <span key={c.path} className="crumbs__seg">
                    {i > 0 ? <span className="crumbs__sep">/</span> : null}
                    <button
                      className={'crumb' + (i === data.crumbs.length - 1 ? ' is-here' : '')}
                      onClick={() => { setDir(c.path); setManual(c.path) }}
                      title={c.path}
                    >
                      {c.name}
                    </button>
                  </span>
                ))
              ) : (
                <span className="crumb is-here">This PC</span>
              )}
            </div>

            <div className="listing">
              {loading ? <p className="picker__status">Loading…</p> : null}
              {error ? <p className="picker__status picker__status--error">{error}</p> : null}

              {!loading && !error && data ? data.entries.map((entry) => (
                <button
                  key={entry.path}
                  className="entry"
                  onClick={() => { setDir(entry.path); setManual(entry.path) }}
                  onDoubleClick={() => choose(entry.path)}
                  title={entry.path}
                >
                  <span className="entry__icon"><Folder size={17} /></span>
                  <span className="entry__name">{entry.name}</span>
                  {entry.videos ? (
                    <span className="entry__n">{entry.videos}</span>
                  ) : null}
                </button>
              )) : null}

              {!loading && !error && data && data.entries.length === 0 ? (
                <p className="picker__status">No folders in here.</p>
              ) : null}
            </div>
          </div>
        </div>

        <footer className="picker__foot">
          <span className="picker__here">
            {here === null
              ? ''
              : here > 0
                ? plural(here) + ' in this folder'
                : 'No videos directly in this folder'}
          </span>
          <div className="picker__actions">
            {onCancel ? <button className="pill" onClick={onCancel}>Cancel</button> : null}
            <button
              className="pill pill--solid"
              disabled={!data || !data.dir || loading}
              onClick={() => choose(data.dir)}
            >
              Use this folder
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
