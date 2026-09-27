import { useEffect, useRef, useState } from 'react'
import ConfirmRemove from './ConfirmRemove.jsx'
import { Back, Close, Scissors } from './icons.jsx'
import { listBucket, videoUrl } from './api.js'

function formatSize (bytes) {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return Math.round(bytes / 1024) + ' KB'
  if (mb < 1024) return mb.toFixed(1) + ' MB'
  return (mb / 1024).toFixed(2) + ' GB'
}

/** A card that previews on hover, so you can find a clip without opening it. */
function Card ({ video, onOpen }) {
  const ref = useRef(null)

  function enter () {
    const v = ref.current
    if (!v) return
    v.currentTime = 0
    v.play().catch(() => {})
  }
  function leave () {
    const v = ref.current
    if (!v) return
    v.pause()
    v.currentTime = 0.5
  }

  return (
    <button
      className="card"
      onClick={onOpen}
      onMouseEnter={enter}
      onMouseLeave={leave}
      title={'Edit ' + video.name}
    >
      <span className="card__frame">
        {video.playable ? (
          <video
            ref={ref}
            className="card__video"
            // The media fragment makes the browser show a real frame rather
            // than a black poster before anything is played.
            src={videoUrl(video.id) + '#t=0.5'}
            preload="metadata"
            muted
            loop
            playsInline
          />
        ) : (
          <span className="card__noplay">{video.ext}</span>
        )}
        <span className="card__cut"><Scissors size={15} /></span>
      </span>
      <span className="card__name" title={video.name}>{video.name}</span>
      <span className="card__meta">{formatSize(video.size)}</span>
    </button>
  )
}

export default function Library ({ state, onState, onOpen, onBack }) {
  const [bucketId, setBucketId] = useState(state.buckets[0]?.id || null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [removing, setRemoving] = useState(null)

  useEffect(() => {
    if (!bucketId) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    listBucket(bucketId)
      .then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bucketId])

  useEffect(() => {
    function onKey (event) {
      if (event.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  return (
    <div className="library">
      <header className="libbar">
        <div className="libbar__left">
          <button className="ctl" onClick={onBack} title="Back to sorting (Esc)" aria-label="Back">
            <Back size={18} />
          </button>
          <h1 className="libbar__title">Library</h1>
        </div>
        {data ? (
          <span className="libbar__count">
            <strong>{data.videos.length}</strong> clip{data.videos.length === 1 ? '' : 's'}
            {data.edits > 0 ? <span className="dot">·</span> : null}
            {data.edits > 0 ? <strong>{data.edits}</strong> : null}
            {data.edits > 0 ? ' exported' : null}
          </span>
        ) : null}
      </header>

      {state.buckets.length === 0 ? (
        <div className="libempty">
          <p>No buckets yet. Sort some videos first and they will show up here.</p>
          <button className="pill pill--solid" onClick={onBack}>Back to sorting</button>
        </div>
      ) : (
        <>
          <div className="tabs">
            {state.buckets.map((b) => (
              <div className="bubblewrap" key={b.id}>
                <button
                  className={'bubble' + (b.id === bucketId ? ' is-on' : '')}
                  onClick={() => setBucketId(b.id)}
                >
                  <span className="bubble__name">{b.name}</span>
                  <span className="bubble__count">{b.count}</span>
                </button>
                <button
                  className="bubble__drop"
                  onClick={() => setRemoving(b)}
                  title={'Remove ' + b.name}
                  aria-label={'Remove bucket ' + b.name}
                >
                  <Close size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="grid">
            {loading ? <p className="libnote">Loading…</p> : null}
            {error ? <p className="libnote libnote--error">{error}</p> : null}

            {!loading && data && data.videos.length === 0 ? (
              <p className="libnote">This bucket is empty.</p>
            ) : null}

            {!loading && data
              ? data.videos.map((v) => (
                <Card key={v.id} video={v} onOpen={() => onOpen(v, data.bucket)} />
              ))
              : null}
          </div>
        </>
      )}

      {removing ? (
        <ConfirmRemove
          bucket={removing}
          onCancel={() => setRemoving(null)}
          onDone={(next) => {
            onState(next)
            setRemoving(null)
            // The open bucket may be the one that just went.
            if (removing.id === bucketId) setBucketId(next.buckets[0]?.id || null)
          }}
        />
      ) : null}
    </div>
  )
}
