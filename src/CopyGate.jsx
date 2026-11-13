import { useEffect, useState } from 'react'
import { Back } from './icons.jsx'
import { canPlayHere, hasCopy, waitForCopy } from './api.js'
import MakingCopy from './MakingCopy.jsx'

/**
 * In front of the editor: a video this browser cannot play (an .mkv or .avi,
 * or HEVC without the decoder) gets its playable copy made first, and the
 * editor opens on that. Exports still read the original.
 */
export default function CopyGate ({ video, onBack, children }) {
  const [phase, setPhase] = useState(() => (hasCopy(video.id) ? 'ok' : 'check'))
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (phase === 'ok') return
    let stale = false
    ;(async () => {
      const fine = video.playable && await canPlayHere(video.id)
      if (stale) return
      if (fine) { setPhase('ok'); return }
      setPhase('making')
      try {
        const ok = await waitForCopy(video.id, (s) => { if (!stale) setStatus(s) }, () => stale)
        if (ok && !stale) setPhase('ok')
      } catch (err) {
        if (!stale) setError(err.message)
      }
    })()
    return () => { stale = true }
  }, [video.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'ok') return children
  return (
    <div className="gate">
      {phase === 'making' ? (
        <>
          <button className="ctl gate__back" onClick={onBack} aria-label="Back to the library" title="Back to the library">
            <Back size={18} />
          </button>
          <MakingCopy ext={video.ext} status={status} error={error} note={error ? null : 'The editor opens when it is done.'} />
        </>
      ) : null}
    </div>
  )
}
