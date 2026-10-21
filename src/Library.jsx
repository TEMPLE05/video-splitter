import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ConfirmRemove from './ConfirmRemove.jsx'
import Thumb from './Thumb.jsx'
import { Back, Check, Close, Folder, Music, Scissors } from './icons.jsx'
import { listBucket, pullBucketAudio, thumbUrl, videoUrl } from './api.js'

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
 */
function Card ({ video, onOpen }) {
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
    <button
      className="card"
      onClick={onOpen}
      onMouseEnter={settle}
      onMouseLeave={leave}
      title={'Edit ' + video.name}
    >
      <span className="card__frame">
        <Thumb
          className="card__img"
          src={thumbUrl(video.id)}
          fallback={<span className="card__noplay">{video.ext}</span>}
        />
        {preview && video.playable ? (
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
        <span className="card__cut"><Scissors size={15} /></span>
      </span>
      <span className="card__name" title={video.name}>{video.name}</span>
      <span className="card__meta">{formatSize(video.size)}</span>
    </button>
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

  const scroller = useRef(null)
  const scrollNow = useRef(0)
  const pendingScroll = useRef(place?.bucketId === openId ? place?.scroll || 0 : 0)

  const open = state.buckets.find((b) => b.id === openId) || null

  function goInto (id) {
    pendingScroll.current = 0
    setGrabbed(null)
    setError(null)
    setOpenId(id)
    onPlace({ bucketId: id, scroll: 0 })
  }

  function goUp () {
    pendingScroll.current = 0
    setGrabbed(null)
    setError(null)
    setData(null)
    setOpenId(null)
    onPlace({ bucketId: null, scroll: 0 })
  }

  function openClip (video) {
    // Remember exactly where you were, to land back here afterwards.
    onPlace({ bucketId: openId, scroll: scrollNow.current })
    onOpen(video, data.bucket)
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
      if (removing) return
      const tag = event.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // Backspace goes up a level, as it does in File Explorer.
      if (event.key === 'Escape' || event.key === 'Backspace') {
        event.preventDefault()
        if (openId) goUp()
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
          {data ? (
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
          className="grid"
          ref={scroller}
          onScroll={(e) => { scrollNow.current = e.currentTarget.scrollTop }}
        >
          {loading && !data ? <p className="libnote">Loading…</p> : null}
          {error ? <p className="libnote libnote--error">{error}</p> : null}
          {data && data.videos.length === 0 ? <p className="libnote">This folder is empty.</p> : null}
          {data ? data.videos.map((v) => (
            <Card key={v.id} video={v} onOpen={() => openClip(v)} />
          )) : null}
        </div>

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
        <span className="libbar__count">
          <strong>{state.buckets.length}</strong> {state.buckets.length === 1 ? 'folder' : 'folders'}
        </span>
      </header>

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

      {removal}
    </div>
  )
}
