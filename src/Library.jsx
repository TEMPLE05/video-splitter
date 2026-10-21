import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ConfirmRemove from './ConfirmRemove.jsx'
import Thumb from './Thumb.jsx'
import { Back, Check, Close, Folder, Music, Scissors, Trash } from './icons.jsx'
import {
  getState, listBucket, moveClips, pullBucketAudio, thumbUrl, tidyInfo, tidyRun, tidyUndo, trashClips, videoUrl
} from './api.js'

function formatSize (bytes) {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return Math.round(bytes / 1024) + ' KB'
  if (mb < 1024) return mb.toFixed(1) + ' MB'
  return (mb / 1024).toFixed(2) + ' GB'
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * One clip in a folder.
 *
 * Shows a still JPEG from the server rather than a <video>. A video per card
 * meant a folder of 187 clips started 187 downloads at once, and with only six
 * connections allowed per server every other click waited behind them. The
 * image is lazy, so only cards on screen ask for one at all.
 *
 * Hovering still plays a preview, but only one video exists at a time, and
 * only after the pointer settles, so sweeping across the grid starts nothing.
 *
 * The round tick in the corner selects it; so does Ctrl-click, and Shift-click
 * selects a run. Once anything is selected, a plain click selects too.
 */
function Card ({ video, onOpen, selected, selecting, onSelect }) {
  const [preview, setPreview] = useState(false)
  const timer = useRef(null)

  const settle = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setPreview(true), 280)
  }
  const leave = () => {
    clearTimeout(timer.current)
    setPreview(false)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <div className={'cardbox' + (selected ? ' is-selected' : '') + (selecting ? ' is-selecting' : '')}>
      <button
        className="card"
        onClick={(e) => {
          if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) onSelect(e)
          else onOpen()
        }}
        onMouseEnter={settle}
        onMouseLeave={leave}
        title={selecting ? 'Select ' + video.name : 'Edit ' + video.name}
      >
        <span className="card__frame">
          <Thumb
            className="card__img"
            src={thumbUrl(video.id)}
            fallback={<span className="card__noplay">{video.ext}</span>}
          />
          {preview && video.playable && !selecting ? (
            <video
              className="card__video"
              src={videoUrl(video.id)}
              autoPlay
              muted
              loop
              playsInline
            />
          ) : null}
          {/* Clips you have started editing, so you can find them again. */}
          {video.edited ? <span className="card__edited">Edited</span> : null}
          {!selecting ? <span className="card__cut"><Scissors size={15} /></span> : null}
        </span>
        <span className="card__name" title={video.name}>{video.name}</span>
        <span className="card__meta">{formatSize(video.size)}</span>
      </button>
      <button
        className="card__check"
        role="checkbox"
        aria-checked={selected}
        aria-label={(selected ? 'Unselect ' : 'Select ') + video.name}
        onClick={(e) => { e.stopPropagation(); onSelect(e) }}
      >
        {selected ? <Check size={14} /> : null}
      </button>
    </div>
  )
}

/** A folder tile on the library's front page, with its first clip as a cover. */
function FolderTile ({ bucket, onOpen, onRemove }) {
  const glyph = <span className="folder__glyph"><Folder size={36} /></span>
  return (
    <div className="folder">
      <button className="folder__open" onClick={onOpen} title={'Open ' + bucket.name}>
        <span className="folder__cover">
          {glyph}
          {bucket.cover ? (
            <Thumb className="folder__img" src={thumbUrl(bucket.cover)} fallback={null} />
          ) : null}
        </span>
        <span className="folder__name" title={bucket.name}>{bucket.name}</span>
        <span className="folder__meta">{plural(bucket.count, 'clip')}</span>
      </button>
      <button
        className="folder__drop"
        onClick={onRemove}
        title={'Remove ' + bucket.name}
        aria-label={'Remove bucket ' + bucket.name}
      >
        <Close size={12} />
      </button>
    </div>
  )
}

function useEscape (onClose, busy) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, busy])
}

/** Asks before anything goes to the Recycle Bin, and names what will. */
function ConfirmTrash ({ clips, onDone, onCancel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEscape(onCancel, busy)
  const bin = navigator.platform.toLowerCase().startsWith('mac') ? 'Trash' : 'Recycle Bin'

  async function go () {
    setBusy(true)
    setError(null)
    try {
      const r = await trashClips(clips.map((c) => c.id))
      if (r.failed.length) {
        setError(`${plural(r.failed.length, 'clip')} could not be moved, perhaps because it is open somewhere else: ${r.failed.join(', ')}`)
        setBusy(false)
        onDone(r, true)
        return
      }
      onDone(r)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const shown = clips.slice(0, 5)
  return (
    <div className="sheetwrap" onClick={() => !busy && onCancel()}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">Move {plural(clips.length, 'clip')} to the {bin}?</h2>
        <ul className="sheet__names">
          {shown.map((c) => <li key={c.id}>{c.name}</li>)}
          {clips.length > shown.length ? <li>and {clips.length - shown.length} more</li> : null}
        </ul>
        <p className="sheet__body">
          {clips.length === 1 ? 'It' : 'They'} can be restored from the {bin} if you change your mind.
          Anything already exported, and any audio you pulled out, stays where it is.
        </p>
        {error ? <p className="sheet__error">{error}</p> : null}
        <div className="sheet__actions">
          <button className="pill" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="pill pill--danger" onClick={go} disabled={busy}>
            <Trash size={16} /> {busy ? 'Moving…' : 'Move to ' + bin}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Moves clips to another bucket, or back to the main folder to be sorted again. */
function MoveSheet ({ clips, buckets, here, onDone, onCancel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEscape(onCancel, busy)

  async function go (bucketId, label) {
    setBusy(true)
    setError(null)
    try {
      const r = await moveClips(clips.map((c) => c.id), bucketId)
      onDone(r, label)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheetwrap" onClick={() => !busy && onCancel()}>
      <div className="sheet sheet--wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">Move {plural(clips.length, 'clip')} to…</h2>
        <div className="movelist">
          {buckets.filter((b) => b.id !== here).map((b) => (
            <button key={b.id} className="moveitem" onClick={() => go(b.id, b.name)} disabled={busy}>
              <Folder size={16} /> <span>{b.name}</span> <em>{plural(b.count, 'clip')}</em>
            </button>
          ))}
        </div>
        <button className="moveitem moveitem--queue" onClick={() => go(null, 'the sorting queue')} disabled={busy}>
          <Back size={16} /> <span>Back to the sorting queue</span> <em>to be sorted again</em>
        </button>
        <p className="sheet__body sheet__extras">Their saved edits go with them. A name already taken there gets a number added.</p>
        {error ? <p className="sheet__error">{error}</p> : null}
        <div className="sheet__actions">
          <button className="pill" onClick={onCancel} disabled={busy}>{busy ? 'Moving…' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}

/** Gathers the pictures, documents and other non-video files in the main folder into one place. */
function TidySheet ({ info, onDone, onCancel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  useEscape(onCancel, busy)

  async function go () {
    setBusy(true)
    setError(null)
    try {
      setResult(await tidyRun())
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function undo () {
    setBusy(true)
    try {
      const r = await tidyUndo()
      setResult(null)
      onDone(`Put ${plural(r.back, 'file')} back where ${r.back === 1 ? 'it was' : 'they were'}`)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const kinds = Object.entries(info.kinds)
  return (
    <div className="sheetwrap" onClick={() => !busy && onCancel()}>
      <div className="sheet sheet--wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">Tidy up the main folder</h2>
        {!result ? (
          <>
            <p className="sheet__body">
              Your main folder has {plural(info.count, 'file')} that {info.count === 1 ? 'is not a video' : 'are not videos'}.
              They can go into one folder called <strong>{info.folder}</strong>, sorted by kind. Nothing is deleted,
              and you can put them back.
            </p>
            <ul className="tidylist">
              {kinds.map(([k, v]) => (
                <li key={k}>
                  <strong>{k}</strong> <span>{v.count} · {formatSize(v.size)}</span>
                  <em>{v.examples.join(', ')}{v.count > v.examples.length ? '…' : ''}</em>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="sheet__body">
            Moved {plural(result.moved, 'file')} into <strong>{result.folder}</strong> inside your main folder.
          </p>
        )}
        {error ? <p className="sheet__error">{error}</p> : null}
        <div className="sheet__actions">
          {result ? (
            <>
              <button className="pill" onClick={undo} disabled={busy || !result.canUndo}>Put them back</button>
              <button className="pill pill--solid" onClick={() => onDone(null)} disabled={busy}>Done</button>
            </>
          ) : (
            <>
              <button className="pill" onClick={onCancel} disabled={busy}>Cancel</button>
              <button className="pill pill--solid" onClick={go} disabled={busy}>{busy ? 'Moving…' : `Move them into ${info.folder}`}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The library, laid out like File Explorer: a grid of folders, and clicking one
 * opens it on its own screen.
 *
 * Where you were, which folder and how far down, lives in App rather than here,
 * so coming back from the editor lands you where you left instead of on the
 * first folder in the list.
 */
export default function Library ({ state, onState, onOpen, onBack, place, onPlace }) {
  const exists = (id) => state.buckets.some((b) => b.id === id)
  const [openId, setOpenId] = useState(place?.bucketId && exists(place.bucketId) ? place.bucketId : null)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [grabbing, setGrabbing] = useState(false)
  const [grabbed, setGrabbed] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [sheet, setSheet] = useState(null)
  const [notice, setNotice] = useState(null)
  const [tidy, setTidy] = useState(null)
  const lastPick = useRef(null)

  const scroller = useRef(null)
  const scrollNow = useRef(0)
  const pendingScroll = useRef(place?.bucketId === openId ? place?.scroll || 0 : 0)

  const open = state.buckets.find((b) => b.id === openId) || null
  const videos = data ? data.videos : []
  const picked = videos.filter((v) => selected.has(v.id))

  function goInto (id) {
    pendingScroll.current = 0
    setGrabbed(null)
    setError(null)
    setSelected(new Set())
    setNotice(null)
    setOpenId(id)
    onPlace({ bucketId: id, scroll: 0 })
  }

  function goUp () {
    pendingScroll.current = 0
    setGrabbed(null)
    setError(null)
    setData(null)
    setSelected(new Set())
    setNotice(null)
    setOpenId(null)
    onPlace({ bucketId: null, scroll: 0 })
  }

  function openClip (video) {
    // Remember exactly where you were, to land back here afterwards.
    onPlace({ bucketId: openId, scroll: scrollNow.current })
    onOpen(video, data.bucket)
  }

  /** Ctrl toggles one; Shift selects everything between the last pick and this. */
  function toggle (video, e) {
    const i = videos.findIndex((v) => v.id === video.id)
    // Read before the update runs; by then lastPick already points here.
    const from = lastPick.current
    setSelected((cur) => {
      const next = new Set(cur)
      if (e && e.shiftKey && from !== null) {
        const [a, b] = [from, i].sort((x, y) => x - y)
        for (let k = a; k <= b; k++) next.add(videos[k].id)
      } else if (next.has(video.id)) next.delete(video.id)
      else next.add(video.id)
      return next
    })
    lastPick.current = i
  }

  async function refresh () {
    const [d, s] = await Promise.all([listBucket(openId).catch(() => null), getState().catch(() => null)])
    if (d) setData(d)
    if (s) onState(s)
  }

  async function grabAll () {
    if (!openId || grabbing) return
    setGrabbing(true)
    setError(null)
    setGrabbed(null)
    try {
      setGrabbed(await pullBucketAudio(openId))
      // The header shows how many tracks are in the audio folder; refresh it.
      setData(await listBucket(openId))
    } catch (err) {
      setError(err.message)
    } finally {
      setGrabbing(false)
    }
  }

  useEffect(() => {
    if (!openId) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    listBucket(openId)
      .then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [openId])

  // How many non-video files sit in the main folder, for the tidy-up offer.
  useEffect(() => {
    if (openId) return
    tidyInfo().then(setTidy).catch(() => setTidy(null))
  }, [openId, state.sourceDir])

  // Put the scroll position back once the cards it refers to exist.
  useLayoutEffect(() => {
    if (!data || !scroller.current) return
    if (pendingScroll.current) {
      scroller.current.scrollTop = pendingScroll.current
      pendingScroll.current = 0
    }
  }, [data])

  useEffect(() => {
    function onKey (event) {
      if (removing || sheet) return
      const tag = event.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (openId && (event.ctrlKey || event.metaKey) && event.code === 'KeyA') {
        event.preventDefault()
        setSelected(new Set(videos.map((v) => v.id)))
        return
      }
      if (event.key === 'Delete' && picked.length) {
        event.preventDefault()
        setSheet('trash')
        return
      }
      // Backspace goes up a level, as it does in File Explorer; Esc first
      // lets go of a selection.
      if (event.key === 'Escape' || event.key === 'Backspace') {
        event.preventDefault()
        if (selected.size) setSelected(new Set())
        else if (openId) goUp()
        else if (event.key === 'Escape') onBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const removal = removing ? (
    <ConfirmRemove
      bucket={removing}
      onCancel={() => setRemoving(null)}
      onDone={(next) => {
        onState(next)
        if (removing.id === openId) goUp()
        if (place?.bucketId === removing.id) onPlace({ bucketId: null, scroll: 0 })
        setRemoving(null)
      }}
    />
  ) : null

  // ------------------------------------------------------------ folder view
  if (open) {
    return (
      <div className="library">
        <header className="libbar">
          <div className="libbar__left">
            <button className="ctl" onClick={goUp} title="Up to all folders (Esc)" aria-label="Up to all folders">
              <Back size={18} />
            </button>
            <nav className="crumbtrail" aria-label="Location">
              <button className="crumbtrail__link" onClick={goUp}>Library</button>
              <span className="crumbtrail__sep">›</span>
              <h1 className="libbar__title" title={open.name}>{open.name}</h1>
            </nav>
          </div>
          {data && picked.length ? (
            <div className="libbar__right selbar">
              <span className="libbar__count"><strong>{picked.length}</strong> selected</span>
              <button className="pill pill--sm" onClick={() => setSelected(new Set(videos.map((v) => v.id)))} disabled={picked.length === videos.length}>Select all</button>
              <button className="pill pill--sm" onClick={() => setSheet('move')}><Folder size={15} /> Move to…</button>
              <button className="pill pill--sm pill--danger" onClick={() => setSheet('trash')}><Trash size={15} /> Delete</button>
              <button className="ctl" onClick={() => setSelected(new Set())} title="Clear the selection (Esc)" aria-label="Clear the selection"><Close size={16} /></button>
            </div>
          ) : data ? (
            <div className="libbar__right">
              <span className="libbar__count">
                <strong>{data.videos.length}</strong> {data.videos.length === 1 ? 'clip' : 'clips'}
                {data.edits > 0 ? <><span className="dot">·</span><strong>{data.edits}</strong> exported</> : null}
                {data.audio > 0 ? <><span className="dot">·</span><strong>{data.audio}</strong> audio</> : null}
              </span>
              {data.videos.length > 0 ? (
                <button
                  className="pill pill--sm"
                  onClick={grabAll}
                  disabled={grabbing}
                  title="Pull the audio from every clip here into one folder"
                >
                  <Music size={15} />
                  {grabbing ? 'Pulling audio…' : 'Pull all audio'}
                </button>
              ) : null}
            </div>
          ) : null}
        </header>

        {notice ? (
          <div className="grabbed">
            <div className="grabbed__text"><p className="grabbed__head"><Check size={14} /> {notice}</p></div>
            <button className="grabbed__close" onClick={() => setNotice(null)} aria-label="Dismiss"><Close size={13} /></button>
          </div>
        ) : null}

        {grabbed ? (
          <div className="grabbed">
            <div className="grabbed__text">
              <p className="grabbed__head">
                <Check size={14} /> {grabbed.done} pulled
                {grabbed.already > 0 ? `, ${grabbed.already} already there` : ''}
                {grabbed.silent > 0 ? `, ${grabbed.silent} had no sound` : ''}
                {grabbed.failed > 0 ? `, ${grabbed.failed} failed` : ''}
              </p>
              <p className="grabbed__where">
                Point any music player at <code>{grabbed.dir}</code>
              </p>
            </div>
            <button className="grabbed__close" onClick={() => setGrabbed(null)} aria-label="Dismiss">
              <Close size={13} />
            </button>
          </div>
        ) : null}

        <div
          className={'grid' + (picked.length ? ' is-selecting' : '')}
          ref={scroller}
          onScroll={(e) => { scrollNow.current = e.currentTarget.scrollTop }}
        >
          {loading && !data ? <p className="libnote">Loading…</p> : null}
          {error ? <p className="libnote libnote--error">{error}</p> : null}
          {data && data.videos.length === 0 ? <p className="libnote">This folder is empty.</p> : null}
          {data ? data.videos.map((v) => (
            <Card
              key={v.id}
              video={v}
              onOpen={() => openClip(v)}
              selected={selected.has(v.id)}
              selecting={picked.length > 0}
              onSelect={(e) => toggle(v, e)}
            />
          )) : null}
        </div>

        {sheet === 'trash' ? (
          <ConfirmTrash
            clips={picked}
            onCancel={() => setSheet(null)}
            onDone={async (r, partly) => {
              if (!partly) setSheet(null)
              setSelected(new Set())
              setNotice(`Moved ${plural(r.trashed.length, 'clip')} to the Recycle Bin`)
              await refresh()
            }}
          />
        ) : null}
        {sheet === 'move' ? (
          <MoveSheet
            clips={picked}
            buckets={state.buckets}
            here={openId}
            onCancel={() => setSheet(null)}
            onDone={async (r, label) => {
              setSheet(null)
              setSelected(new Set())
              setNotice(`Moved ${plural(r.moved.length, 'clip')} to ${label}${r.failed.length ? `; ${r.failed.length} could not be moved` : ''}`)
              await refresh()
            }}
          />
        ) : null}
        {removal}
      </div>
    )
  }

  // ------------------------------------------------------ all-folders view
  return (
    <div className="library">
      <header className="libbar">
        <div className="libbar__left">
          <button className="ctl" onClick={onBack} title="Back to sorting (Esc)" aria-label="Back to sorting">
            <Back size={18} />
          </button>
          <h1 className="libbar__title">Library</h1>
        </div>
        <div className="libbar__right">
          {tidy && tidy.count > 0 ? (
            <button className="pill pill--sm" onClick={() => setSheet('tidy')} title="Gather the files that are not videos into one folder">
              Tidy up {plural(tidy.count, 'other file')}
            </button>
          ) : null}
          <span className="libbar__count">
            <strong>{state.buckets.length}</strong> {state.buckets.length === 1 ? 'folder' : 'folders'}
          </span>
        </div>
      </header>

      {notice ? (
        <div className="grabbed">
          <div className="grabbed__text"><p className="grabbed__head"><Check size={14} /> {notice}</p></div>
          <button className="grabbed__close" onClick={() => setNotice(null)} aria-label="Dismiss"><Close size={13} /></button>
        </div>
      ) : null}

      {state.buckets.length === 0 ? (
        <div className="libempty">
          <p>No buckets yet. Sort some videos first and they will show up here.</p>
          <button className="pill pill--solid" onClick={onBack}>Back to sorting</button>
        </div>
      ) : (
        <div className="grid grid--folders">
          {state.buckets.map((b) => (
            <FolderTile
              key={b.id}
              bucket={b}
              onOpen={() => goInto(b.id)}
              onRemove={() => setRemoving(b)}
            />
          ))}
        </div>
      )}

      {sheet === 'tidy' && tidy ? (
        <TidySheet
          info={tidy}
          onCancel={() => setSheet(null)}
          onDone={(msg) => {
            setSheet(null)
            if (msg) setNotice(msg)
            tidyInfo().then(setTidy).catch(() => {})
          }}
        />
      ) : null}
      {removal}
    </div>
  )
}
