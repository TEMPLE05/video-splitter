import { useEffect, useRef, useState } from 'react'
import SourcePicker from './SourcePicker.jsx'
import { Back, Captions, Check, Close, Download, Film, Folder, Lock, Replay, Scissors, VolumeOff, VolumeOn } from './icons.jsx'
import { captionsStatus, getStartup, installCaptions, setStartup as saveStartup } from './api.js'

const STEPS = ['Welcome', 'Videos', 'Captions', 'Finish']

const MODELS = {
  base: { name: 'Quick', size: '148 MB', note: 'Good for clear speech. About a minute to caption ten minutes of video.' },
  small: { name: 'Better', size: '488 MB', note: 'Catches more words and accents, and translates better. About three times slower.' }
}

const WINGET = 'winget install Gyan.FFmpeg'

/**
 * The set-up window: shown the first time the app opens, and again from
 * ?setup. Four short steps: a welcome, where the videos are, the captions
 * download, and the finishing touches (FFmpeg, install as an app, start
 * with Windows). Every step can be skipped and changed later.
 */
export default function Setup ({ state, onState, onDone }) {
  const [step, setStep] = useState(0)
  const [caps, setCaps] = useState(null)
  const [pick, setPick] = useState(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState(null)
  const [boot, setBoot] = useState(null) // { supported, on }: the Startup-folder shortcut
  const [copied, setCopied] = useState(false)
  // The picture and sound from the assets folder, if there are any.
  const [photo, setPhoto] = useState(true)
  const [sound, setSound] = useState(true)
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem('vs.setupSound') === 'off' } catch { return false } })
  const soundRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const installPrompt = window.__installPrompt || null
  const standalone = window.matchMedia('(display-mode: standalone)').matches

  // Once a videos folder is chosen the window can be closed at any step
  // (the X, or Escape); on the very first run there is nothing to go back to.
  const canClose = Boolean(state.sourceDir)
  useEffect(() => {
    if (!canClose) return
    const onKey = (e) => { if (e.key === 'Escape') onDone() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canClose, onDone])

  // The captions download, while one runs, is watched until it is done.
  useEffect(() => {
    let timer
    let stop = false
    const look = async () => {
      try {
        const s = await captionsStatus()
        if (stop) return
        setCaps(s)
        if (s.install && !s.install.error) timer = setTimeout(look, 800)
        else {
          if (s.install && s.install.error) setError(s.install.error)
          setInstalling(false)
        }
      } catch (err) {
        if (!stop) { setError(err.message); setInstalling(false) }
      }
    }
    look()
    return () => { stop = true; clearTimeout(timer) }
  }, [installing])

  useEffect(() => {
    getStartup().then(setBoot).catch(() => setBoot({ supported: false, on: false }))
  }, [])

  // The sound plays as the window opens where the browser allows it (the
  // installed app does); elsewhere it waits for the first press.
  // It plays once, a little under full volume: it is loud as recorded.
  const played = useRef(false)
  function chime () {
    const a = soundRef.current
    if (!a || !sound || muted || !a.paused || played.current) return
    a.volume = 0.6
    a.play().then(() => { played.current = true }).catch(() => { /* needs a press first */ })
  }
  useEffect(() => { chime() }, [sound]) // eslint-disable-line react-hooks/exhaustive-deps

  // The speaker button: while the sound plays it stops it (and keeps it off
  // next time); once it has finished, or when it was off, it plays it again
  // from the start.
  function remember (off) {
    setMuted(off)
    try { localStorage.setItem('vs.setupSound', off ? 'off' : 'on') } catch { /* no storage */ }
  }
  function pressSound () {
    const a = soundRef.current
    if (!a) return
    if (playing) { a.pause(); remember(true); return }
    if (muted) remember(false)
    a.currentTime = 0
    a.volume = 0.6
    played.current = true
    a.play().catch(() => {})
  }

  async function toggleBoot (on) {
    setError(null)
    try {
      setBoot(await saveStartup(on))
    } catch (err) {
      setError(err.message)
    }
  }

  // Quick is suggested, unless a model is already here.
  useEffect(() => {
    if (!caps || pick) return
    setPick(Object.keys(MODELS).find((k) => caps.models?.[k]?.ready) || 'base')
  }, [caps, pick])

  const ready = (k) => Boolean(caps?.models?.[k]?.ready)
  const progress = caps?.install && caps.install.total ? caps.install.received / caps.install.total : 0

  async function download () {
    setError(null)
    try {
      await installCaptions(pick)
      setInstalling(true)
    } catch (err) {
      setError(err.message)
    }
  }

  async function installApp () {
    if (!installPrompt) return
    installPrompt.prompt()
    try { await installPrompt.userChoice } catch { /* dismissed */ }
    window.__installPrompt = null
  }

  function copy () {
    navigator.clipboard?.writeText(WINGET).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1))
  const back = () => setStep((s) => Math.max(s - 1, 0))

  // The main button's job on this step.
  const waitingForModel = step === 2 && pick && pick !== 'later' && !ready(pick)
  const action = step === 0
    ? { label: 'Get started', go: () => { chime(); next() } }
    : step === 2
      ? (waitingForModel
          ? { label: installing ? 'Downloading…' : 'Download', go: download, disabled: installing || !caps }
          : { label: 'Next', go: next })
      : step === 3
        ? { label: 'Start sorting', go: onDone, disabled: !state.sourceDir, title: state.sourceDir ? undefined : 'Choose a videos folder first' }
        : null

  return (
    <div className="setup">
      <div className="setup__card">
        <aside className="setup__side">
          <div className="setup__art" />
          {photo ? <img className="setup__photo" src="/api/brand/picture" alt="" onError={() => setPhoto(false)} /> : null}
          <div className="setup__scrim" />
          {/* Goes with the picture in assets/setup.jpg; change it if the picture changes. */}
          {photo ? <small className="setup__credit">Photo of Lionel Messi. Video Splitter is not affiliated with or endorsed by him.</small> : null}
          {sound ? <audio ref={soundRef} src="/api/brand/sound" preload="auto" onError={() => setSound(false)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /> : null}
          {sound ? (
            <button
              className={'ctl setup__sound' + (playing ? ' is-playing' : '')}
              onClick={pressSound}
              aria-label={playing ? 'Stop the sound' : muted ? 'Sound is off, play it' : 'Play the sound again'}
              title={playing ? 'Stop the sound' : muted ? 'Sound is off. Press to play it' : 'Play it again'}
            >
              {playing ? <VolumeOn size={16} /> : muted ? <VolumeOff size={16} /> : <Replay size={16} />}
            </button>
          ) : null}
          <div className="setup__brand">
            <img src="/icon-192.png" alt="" width="44" height="44" />
            <strong>Video Splitter</strong>
            <span>Every clip you saved, finally in order.<br />Sort the pile. Cut the good ones.</span>
          </div>
        </aside>

        <section className="setup__main">
          {canClose ? (
            <button className="ctl setup__close" onClick={onDone} aria-label="Close the set-up window" title="Close (Esc)">
              <Close size={18} />
            </button>
          ) : null}
          <ol className="setup__steps" aria-label="Set-up steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'is-on' : i < step ? 'is-done' : ''}>
                <span className="setup__num">{i < step ? <Check size={11} /> : i + 1}</span>{s}
              </li>
            ))}
          </ol>

          <div className="setup__body">
            {step === 0 ? (
              <>
                <h1 className="setup__title">Welcome to Video Splitter</h1>
                <p className="setup__lead">
                  The clips pile up. Video Splitter puts them into folders you can find
                  them in, and gives you an editor for the ones worth sharing.
                </p>
                <ul className="setup__perks">
                  <li><Folder size={20} /><div><strong>Sort the pile</strong><span>Watch each clip and press a folder. One key per video.</span></div></li>
                  <li><Scissors size={20} /><div><strong>Cut the good ones</strong><span>Trim, split, change speed, add text, music, blur and transitions.</span></div></li>
                  <li><Captions size={20} /><div><strong>Caption them</strong><span>Written from the speech, and translated when you need it.</span></div></li>
                  <li><Lock size={20} /><div><strong>Kept on this computer</strong><span>Nothing is uploaded, and there is no account to make.</span></div></li>
                </ul>
                <p className="setup__hint">Set-up takes about a minute, and you can change any of it later.</p>
              </>
            ) : null}

            {step === 1 ? (
              <>
                <h1 className="setup__title">Choose your videos folder</h1>
                <p className="setup__lead">
                  Pick the folder your phone videos land in. The folders you sort into
                  are made inside it, and nothing ever leaves it.
                </p>
                <SourcePicker current={state.sourceDir} onPicked={(s) => { onState(s); next() }} onCancel={null} />
              </>
            ) : null}

            {step === 2 ? (
              <>
                <h1 className="setup__title">Get captions ready</h1>
                <p className="setup__lead">
                  Captions are written by a speech program that runs on this computer, so
                  they work offline. It is a one-time download, and speech in other
                  languages can be translated into English.
                </p>
                <div className="setup__choices" role="radiogroup" aria-label="Captions download">
                  {Object.entries(MODELS).map(([k, m]) => (
                    <button
                      key={k}
                      className={'choice' + (pick === k ? ' is-on' : '')}
                      role="radio"
                      aria-checked={pick === k}
                      onClick={() => setPick(k)}
                      disabled={installing}
                    >
                      <div><strong>{m.name} <em className="setup__size">{m.size}</em></strong><span>{m.note}</span></div>
                      {ready(k) ? <b className="setup__badge"><Check size={13} /> Downloaded</b> : null}
                    </button>
                  ))}
                  <button
                    className={'choice' + (pick === 'later' ? ' is-on' : '')}
                    role="radio"
                    aria-checked={pick === 'later'}
                    onClick={() => setPick('later')}
                    disabled={installing}
                  >
                    <div><strong>Later</strong><span>It downloads the first time you press Captions in the editor.</span></div>
                  </button>
                </div>
                {installing && caps?.install ? (
                  <div className="setup__progress">
                    <div className="setup__bar"><i style={{ width: Math.round(progress * 100) + '%' }} /></div>
                    <span>{caps.install.phase === 'model' ? 'Downloading the language model' : 'Downloading the speech program'}… {Math.round(progress * 100)}%</span>
                  </div>
                ) : null}
              </>
            ) : null}

            {step === 3 ? (
              <>
                <h1 className="setup__title">Finishing touches</h1>
                <p className="setup__lead">Three optional extras. To change them later, press ? and choose Set-up window.</p>
                <div className="setup__rows">
                  <div className="setup__row">
                    <Film size={20} />
                    <div>
                      <strong>FFmpeg {state.tools
                        ? <b className="setup__badge"><Check size={13} /> Found</b>
                        : <b className="setup__badge setup__badge--no">Not found</b>}
                      </strong>
                      <span>{state.tools
                        ? 'Cuts and exports your videos. Already installed.'
                        : <>Needed to cut and export. Install it from a terminal with <code>{WINGET}</code>, then restart the app.</>}
                      </span>
                    </div>
                    {!state.tools ? <button className="pill pill--sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button> : null}
                  </div>
                  <div className="setup__row">
                    <Download size={20} />
                    <div>
                      <strong>Install as an app</strong>
                      <span>{standalone
                        ? 'Already installed. You are in the app now.'
                        : installPrompt
                          ? 'Its own window and taskbar icon, without the browser around it.'
                          : 'Its own window and taskbar icon. Open the browser menu (⋮) and choose Install Video Splitter.'}
                      </span>
                    </div>
                    {standalone
                      ? <b className="setup__badge"><Check size={13} /> Installed</b>
                      : installPrompt ? <button className="pill pill--sm" onClick={installApp}>Install</button> : null}
                  </div>
                  <div className="setup__row">
                    <Replay size={20} />
                    <div>
                      <strong>Start with Windows</strong>
                      <span>{boot && !boot.supported ? 'Only on Windows.' : 'Starts quietly in the background when you sign in, so the app opens instantly.'}</span>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={Boolean(boot && boot.on)}
                        disabled={!boot || !boot.supported}
                        onChange={(e) => toggleBoot(e.target.checked)}
                        aria-label="Start with Windows"
                      />
                      <i />
                    </label>
                  </div>
                </div>
              </>
            ) : null}

            {error ? <p className="setup__error">{error}</p> : null}
          </div>

          <footer className="setup__foot">
            {step > 0 ? <button className="pill" onClick={back} disabled={installing}><Back size={15} /> Back</button> : null}
            {step === 1 && state.sourceDir ? <button className="pill setup__keep" onClick={next}>Keep this folder</button> : null}
            {step === 2 && waitingForModel && !installing ? <button className="setup__skip" onClick={() => { setPick('later'); next() }}>Skip for now</button> : null}
            {action ? <button className="pill pill--solid" onClick={action.go} disabled={action.disabled} title={action.title}>{action.label}</button> : null}
          </footer>
        </section>
      </div>
    </div>
  )
}
