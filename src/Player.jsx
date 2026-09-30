import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Pause, Play, Replay, VolumeOff, VolumeOn } from './icons.jsx'

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
const Player = forwardRef(function Player ({ item, src, nextSrc, idle }, ref) {
  const videoRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [failed, setFailed] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)

  // New clip: reset the transport so the previous clip's time never leaks in.
  useEffect(() => {
    setTime(0)
    setDuration(0)
    setFailed(false)
  }, [src])

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
  const disabled = !item.playable || failed

  return (
    <>
      <div className="videolayer" onClick={disabled ? undefined : toggle}>
        {disabled ? (
          <div className="noplay">
            <p className="noplay__title">No preview for {item.ext}</p>
            <p className="noplay__note">
              The browser cannot decode this format. You can still file it.
            </p>
          </div>
        ) : (
          <video
            ref={videoRef}
            className="videolayer__el"
            src={src}
            autoPlay
            loop
            // Browsers block autoplay with sound until the page is interacted
            // with, so start muted and let M turn sound on for good.
            muted={muted}
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => !scrubbing && setTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
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

      {/* Intended to warm the next clip, and worth knowing: it does nothing.
          The element is display:none, and browsers skip preloading hidden media
          whatever the attribute says. Measured both ways with a 52 MB clip
          queued behind a small one and neither pulled a single byte. Kept at
          metadata rather than auto so that if it is ever made visible it asks
          for a header instead of a whole file, which would matter here because
          the queue has full-length movies in it. */}
      {nextSrc ? <video className="preload" src={nextSrc} preload="metadata" muted /> : null}
    </>
  )
})

export default Player
