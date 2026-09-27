import { useEffect, useState } from 'react'
import { deleteBucket } from './api.js'

/**
 * Confirmation for removing a bucket.
 *
 * Removal is not a delete. Videos in the bucket are moved back to the source
 * folder so they rejoin the queue, and only the empty folder is removed. The
 * server refuses outright when a bucket holds exports or unknown files, and
 * that refusal is shown here rather than swallowed.
 */
export default function ConfirmRemove ({ bucket, onDone, onCancel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  async function go () {
    setBusy(true)
    setError(null)
    try {
      const next = await deleteBucket(bucket.id, bucket.count > 0)
      onDone(next)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const blocked = bucket.edits > 0 || bucket.others > 0

  return (
    <div className="sheetwrap" onClick={() => !busy && onCancel()}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet__title">Remove “{bucket.name}”?</h2>

        {blocked ? (
          <p className="sheet__body">
            This bucket holds {bucket.edits > 0
              ? `${bucket.edits} exported clip${bucket.edits === 1 ? '' : 's'}`
              : `${bucket.others} file${bucket.others === 1 ? '' : 's'} that are not videos`}.
            Nothing here will be touched. Move those out yourself first, so
            nothing can be lost by accident.
          </p>
        ) : bucket.count > 0 ? (
          <p className="sheet__body">
            The {bucket.count} video{bucket.count === 1 ? '' : 's'} inside will move
            back to your main folder and rejoin the queue. Nothing is deleted.
            Then the empty folder goes.
          </p>
        ) : (
          <p className="sheet__body">
            The bucket is empty, so only the folder goes.
          </p>
        )}

        {error ? <p className="sheet__error">{error}</p> : null}

        <div className="sheet__actions">
          <button className="pill" onClick={onCancel} disabled={busy}>Cancel</button>
          {!blocked ? (
            <button className="pill pill--danger" onClick={go} disabled={busy}>
              {busy ? 'Removing…' : bucket.count > 0 ? 'Move back and remove' : 'Remove'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
