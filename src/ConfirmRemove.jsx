import { useEffect, useState } from 'react'
import { bucketContents, deleteBucket } from './api.js'

/**
 * Confirmation for removing a bucket.
 *
 * Removal is not a delete. Videos in the bucket are moved back to the source
 * folder so they rejoin the queue, and only the empty folder is removed.
 *
 * What is inside is asked fresh from the server when this opens, rather than
 * read from the bucket list. The earlier version trusted cached counts that
 * never included the audio folder or folders you made yourself, and told you
 * nothing would be deleted right before deleting them.
 */
export default function ConfirmRemove ({ bucket, onDone, onCancel }) {
  const [inside, setInside] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    bucketContents(bucket.id)
      .then((d) => { if (!cancelled) setInside(d) })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [bucket.id])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  async function go () {
    setBusy(true)
    setError(null)
    try {
      const next = await deleteBucket(bucket.id, (inside?.videos || 0) > 0)
      onDone(next)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const checking = !inside && !error
  const blocked = Boolean(inside?.blocker)
  const videos = inside?.videos || 0

  return (
    <div className="sheetwrap" onClick={() => !busy && onCancel()}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">Remove “{bucket.name}”?</h2>

        {checking ? (
          <p className="sheet__body">Checking what is inside…</p>
        ) : blocked ? (
          <p className="sheet__body">
            {inside.blocker} Nothing here will be touched.
          </p>
        ) : inside && videos > 0 ? (
          <p className="sheet__body">
            The {videos} video{videos === 1 ? '' : 's'} inside will move back to your
            main folder and rejoin the queue. Nothing is deleted. Then the empty
            folder goes.
          </p>
        ) : inside ? (
          <p className="sheet__body">
            The bucket is empty, so only the folder goes.
          </p>
        ) : null}

        {error ? <p className="sheet__error">{error}</p> : null}

        <div className="sheet__actions">
          <button className="pill" onClick={onCancel} disabled={busy}>Cancel</button>
          {inside && !blocked ? (
            <button className="pill pill--danger" onClick={go} disabled={busy}>
              {busy ? 'Removing…' : videos > 0 ? 'Move back and remove' : 'Remove'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
