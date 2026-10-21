import { useEffect, useRef, useState } from 'react'
import Thumb from './Thumb.jsx'
import { Check, Close, Film, Plus } from './icons.jsx'
import { createProject, deleteProject, listBucket, listMedia, thumbUrl, uploadMedia, videoUrl } from './api.js'

const SHAPES = [['9:16', 'Tall', 'TikTok, Reels, Shorts'], ['1:1', 'Square', 'Instagram posts'], ['4:5', 'Portrait', 'Instagram feed'], ['16:9', 'Wide', 'YouTube']]

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function useEscape (onClose, busy) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, busy])
}

/** A project in a folder: its first picture or clip, its name and length. */
export function ProjectCard ({ project, onOpen, onDelete }) {
  const c = project.cover
  return (
    <div className="cardbox">
      <button className="card" onClick={onOpen} title={'Open the project ' + project.name}>
        <span className="card__frame card__frame--project">
          {c && c.image ? <Thumb className="card__img" src={thumbUrl(c.image)} fallback={null} /> : null}
          {c && c.clip ? <Thumb className="card__img" src={thumbUrl(c.clip)} fallback={null} /> : null}
          <span className="card__edited card__project">Project</span>
        </span>
        <span className="card__name" title={project.name}>{project.name}</span>
        <span className="card__meta">{project.shape} · {clock(project.length)}{project.bucketName ? ' · ' + project.bucketName : ''}</span>
      </button>
      <button className="card__check card__del" onClick={(e) => { e.stopPropagation(); onDelete() }} aria-label={'Delete the project ' + project.name} title="Delete this project">
        <Close size={12} />
      </button>
    </div>
  )
}

/** The tile that starts a new project, first in the row. */
export function NewProjectCard ({ onClick }) {
  return (
    <div className="cardbox">
      <button className="card" onClick={onClick} title="Start a video from pictures and clips">
        <span className="card__frame card__frame--new"><Plus size={30} /><span>New project</span></span>
        <span className="card__name">New project</span>
        <span className="card__meta">From pictures, clips and sound</span>
      </button>
    </div>
  )
}

export function ConfirmDeleteProject ({ project, onDone, onCancel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEscape(onCancel, busy)
  return (
    <div className="sheetwrap" onClick={() => !busy && onCancel()}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">Delete the project “{project.name}”?</h2>
        <p className="sheet__body">
          The project's edit goes. The pictures, clips and sounds it used stay where they are, and so does
          anything you already exported from it.
        </p>
        {error ? <p className="sheet__error">{error}</p> : null}
        <div className="sheet__actions">
          <button className="pill" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="pill pill--danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try { await deleteProject(project.id); onDone() } catch (err) { setError(err.message); setBusy(false) }
            }}
          >
            {busy ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Starts a video from nothing: a name, a shape, and the pictures and clips to
 * begin with, in the order picked. Everything else (sounds, voice-overs,
 * transitions, text, captions) is added in the editor.
 */
export function NewProjectSheet ({ buckets, bucketId, onCreated, onCancel }) {
  const [name, setName] = useState('')
  const [shape, setShape] = useState('9:16')
  const [where, setWhere] = useState(bucketId || buckets[0]?.id)
  const [media, setMedia] = useState(null)
  const [chosen, setChosen] = useState([])
  const [seconds, setSeconds] = useState('3')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const fileInput = useRef(null)
  const nameRef = useRef(null)
  useEscape(onCancel, busy)

  // The pictures and clips in the chosen bucket, to start from.
  useEffect(() => {
    if (!where) return
    let cancelled = false
    setMedia(null)
    Promise.all([listMedia(where, 'image').catch(() => ({ files: [] })), listBucket(where).catch(() => ({ videos: [] }))])
      .then(([im, b]) => {
        if (cancelled) return
        setMedia([
          ...im.files.map((f) => ({ kind: 'image', id: f.id, name: f.name })),
          ...b.videos.filter((v) => v.playable).map((v) => ({ kind: 'clip', id: v.id, name: v.name }))
        ])
      })
    return () => { cancelled = true }
  }, [where])

  const toggle = (m) => setChosen((c) => (c.some((x) => x.id === m.id) ? c.filter((x) => x.id !== m.id) : [...c, m]))

  async function upload (files) {
    setBusy(true)
    setError(null)
    try {
      const added = []
      for (const f of files) {
        const r = await uploadMedia(where, 'image', f)
        added.push({ kind: 'image', id: r.id, name: r.name })
      }
      setMedia((m) => [...added, ...(m || [])])
      setChosen((c) => [...c, ...added])
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function create () {
    setBusy(true)
    setError(null)
    try {
      const rec = await createProject({ bucketId: where, name: nameRef.current ? nameRef.current.value : name, shape })
      const secs = Math.min(Math.max(Number(seconds) || 3, 0.5), 600)
      rec.initial = chosen.map((m) => ({ ...m, seconds: secs }))
      onCreated(rec, buckets.find((b) => b.id === where))
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const order = (m) => chosen.findIndex((x) => x.id === m.id) + 1
  return (
    <div className="sheetwrap" onClick={() => !busy && onCancel()}>
      <div className="sheet sheet--wide sheet--tall" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">New project</h2>
        <p className="sheet__body">
          A video made from pictures and clips, with your own sounds, voice-overs, transitions, text and
          captions. Pick what to start with; you can add more in the editor.
        </p>

        <div className="tplsave">
          <label className="tplsave__label" htmlFor="proj-name">Name</label>
          <input
            id="proj-name"
            ref={nameRef}
            className="tplsave__name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Like Messi tribute, or Morning prayer"
            autoFocus
            disabled={busy}
          />
          <div className="ed__textrow">
            <span className="ed__panel-label ed__nogrow">Shape</span>
            {SHAPES.map(([k, label, hint]) => (
              <button key={k} className={'chip' + (shape === k ? ' is-on' : '')} onClick={() => setShape(k)} title={hint} disabled={busy}>
                {label} {k}
              </button>
            ))}
          </div>
          {buckets.length > 1 ? (
            <label className="ed__secs">
              Save in
              <select className="ed__select" value={where} onChange={(e) => { setWhere(e.target.value); setChosen([]) }} disabled={busy}>
                {buckets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <span className="ed__panel-hint">Exports go in its edits folder.</span>
            </label>
          ) : null}
        </div>

        <h3 className="sheet__sub">Start with {chosen.length ? `(${chosen.length} chosen, in this order)` : ''}</h3>
        <div className="cliplist">
          {media === null ? <p className="sheet__body">Looking…</p> : null}
          {media && !media.length ? <p className="sheet__body">No pictures or clips here yet. Add pictures from this computer.</p> : null}
          {(media || []).map((m) => (
            <button key={m.id} className={'clipitem' + (order(m) ? ' is-on' : '')} onClick={() => toggle(m)} disabled={busy} title={m.name}>
              {m.kind === 'image'
                ? <img className="clipitem__thumb" src={thumbUrl(m.id)} alt="" loading="lazy" decoding="async" />
                : <img className="clipitem__thumb" src={thumbUrl(m.id)} alt="" loading="lazy" />}
              {order(m) ? <span className="clipitem__n">{order(m)}</span> : null}
              {m.kind === 'clip' ? <span className="clipitem__kind"><Film size={12} /></span> : null}
              <span className="clipitem__name">{m.name}</span>
            </button>
          ))}
        </div>
        <div className="ed__textrow sheet__row">
          <button className="ed__ghost" onClick={() => fileInput.current?.click()} disabled={busy}>+ Pictures from this computer…</button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { upload([...(e.target.files || [])]); e.target.value = '' }} />
          <span className="ed__grow" />
          <label className="ed__secs ed__nogrow">
            Each picture shows for
            <input className="ed__field ed__field--n" type="number" min="0.5" max="600" step="0.5" value={seconds} onChange={(e) => setSeconds(e.target.value)} />
            s
          </label>
        </div>

        {error ? <p className="sheet__error">{error}</p> : null}
        <div className="sheet__actions">
          <button className="pill" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="pill pill--solid" onClick={create} disabled={busy || !name.trim() || !chosen.length}>
            <Check size={16} /> {busy ? 'Starting…' : 'Start editing'}
          </button>
        </div>
      </div>
    </div>
  )
}
