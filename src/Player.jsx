import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Pause, Play, Replay, VolumeOff, VolumeOn } from './icons.jsx'
import { hasCopy, videoUrl, waitForCopy } from './api.js'
import MakingCopy from './MakingCopy.jsx'

function formatTime (seconds) {
  if (!Number.isFinite(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return m + ':' + String(s).padStart(2, '0')
}

/**
 * The video layer plus its transport. Keyboard handling lives in the Sorter so
 * there is one listener for the whole screen; it reaches in through the ref.
 */
const Player = forwardRef(function Player ({ item, src, idle }, ref) {
  const videoRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [failed, setFailed] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  // A video this browser cannot play gets a playable copy made for it.
  const [copy, setCopy] = useState(null) // { id, ready, status, error }

  // New clip: reset the transport so the previous clip's time never leaks in.
  useEffect(() => {
    setTime(0)
    setDuration(0)
    setFailed(false)
  }, [src])

  const id = item ? item.id : null
  const copyReady = Boolean(id && (hasCopy(id) || (copy && copy.id === id && copy.ready)))
  const needCopy = Boolean(item && (!item.playable || failed) && !copyReady)
  useEffect(() => {
    if (!needCopy) return
    let stale = false
    setCopy({ id, status: null })
    waitForCopy(id, (status) => setCopy({ id, status }), () => stale)
      .then((ok) => { if (ok && !stale) { setFailed(false); setCopy({ id, ready: true }) } })
      .catch((err) => { if (!stale) setCopy({ id, error: err.message }) })
    return () => { stale = true }
  }, [id, needCopy]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggle () {
    const v = videoRef.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }

  function restart () {
    const v = videoRef.current
    if (!v) return
    v.currentTime = 0
    setTime(0)
    v.play().catch(() => {})
  }

  useImperativeHandle(ref, () => ({
    togglePlay: toggle,
    restart,
    seek (delta) {
      const v = videoRef.current
      if (!v || !Number.isFinite(v.duration)) return
      v.currentTime = Math.min(Math.max(v.currentTime + delta, 0), v.duration)
    },
    toggleMute () {
      setMuted((m) => !m)
    }
  }))

  function scrubTo (event) {
    const v = videoRef.current
    if (!v || !Number.isFinite(v.duration)) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
    v.currentTime = ratio * v.duration
    setTime(v.currentTime)
  }

  if (!item) return null

  const percent = duration > 0 ? (time / duration) * 100 : 0
  const disabled = needCopy || (copyReady && failed)
  const playSrc = copyReady ? videoUrl(item.id) : src

  return (
    <>
      <div className="videolayer" onClick={disabled ? undefined : toggle}>
        {disabled ? (
          <MakingCopy
            ext={item.ext}
            status={copy && copy.id === item.id ? copy.status : null}
            error={copyReady && failed ? 'Even the playable copy would not play.' : copy && copy.id === item.id ? copy.error : null}
            note="You can file it without waiting."
          />
        ) : (
          <video
            ref={videoRef}
            className="videolayer__el"
            src={playSrc}
            autoPlay
            loop
            // Browsers block autoplay with sound until the page is interacted
            // with, so start muted and let M turn sound on for good.
            muted={muted}
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => !scrubbing && setTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration)
              // The sound plays but the picture cannot be decoded (HEVC
              // without the decoder): treat it as not playable.
              if (e.currentTarget.videoWidth === 0) setFailed(true)
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>

      <div className={'transport' + (idle ? ' is-hidden' : '')}>
        <div
          className="scrub"
          onClick={scrubTo}
          onMouseDown={() => setScrubbing(true)}
          onMouseUp={() => setScrubbing(false)}
          onMouseLeave={() => setScrubbing(false)}
          onMouseMove={(e) => scrubbing && scrubTo(e)}
          role="presentation"
        >
          <div className="scrub__rail" />
          <div className="scrub__fill" style={{ width: percent + '%' }} />
          <div className="scrub__knob" style={{ left: percent + '%' }} />
        </div>

        <div className="transport__row">
          <button className="ctl" onClick={toggle} disabled={disabled}
            aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause /> : <Play />}
          </button>
          <button className="ctl" onClick={restart} disabled={disabled} aria-label="Restart">
            <Replay size={18} />
          </button>
          <button className="ctl" onClick={() => setMuted((m) => !m)} disabled={disabled}
            aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <VolumeOff size={18} /> : <VolumeOn size={18} />}
          </button>
          <span className="clock">
            {formatTime(time)} <span className="clock__sep">/</span> {formatTime(duration)}
          </span>
        </div>
      </div>
    </>
  )
})

export default Player
