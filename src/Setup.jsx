import { useEffect, useRef, useState } from 'react'
import SourcePicker from './SourcePicker.jsx'
import { Back, Captions, Check, Download, Film, Folder, Replay, Scissors, VolumeOff, VolumeOn } from './icons.jsx'
import { captionsStatus, getStartup, installCaptions, setStartup as saveStartup } from './api.js'

const STEPS = ['Welcome', 'Videos', 'Captions', 'Finish']

const MODELS = {
  base: { name: 'Quick', size: '148 MB', note: 'Good for clear speech. About a minute of work for every ten minutes of video.' },
  small: { name: 'Better', size: '488 MB', note: 'Catches more words and accents, and translates other languages into English better. About three times slower.' }
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
  const installPrompt = window.__installPrompt || null
  const standalone = window.matchMedia('(display-mode: standalone)').matches

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
  function chime () {
    const a = soundRef.current
    if (a && sound && !muted && a.paused) a.play().catch(() => { /* needs a press first */ })
  }
  useEffect(() => { chime() }, [sound]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleMute () {
    const m = !muted
    setMuted(m)
    try { localStorage.setItem('vs.setupSound', m ? 'off' : 'on') } catch { /* no storage */ }
    if (m && soundRef.current) soundRef.current.pause()
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
        ? { label: 'Done', go: onDone, disabled: !state.sourceDir, title: state.sourceDir ? undefined : 'Choose a videos folder first' }
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
          {sound ? <audio ref={soundRef} src="/api/brand/sound" preload="auto" onError={() => setSound(false)} /> : null}
          {sound ? (
            <button className="ctl setup__sound" onClick={toggleMute} aria-label={muted ? 'Sound is off' : 'Sound is on'} title={muted ? 'Turn the sound on' : 'Turn the sound off'}>
              {muted ? <VolumeOff size={16} /> : <VolumeOn size={16} />}
            </button>
          ) : null}
          <div className="setup__brand">
            <img src="/icon-192.png" alt="" width="44" height="44" />
            <strong>Video Splitter</strong>
            <span>Every clip you saved, finally in order.<br />Sort the pile. Cut the good ones.</span>
          </div>
        </aside>

        <section className="setup__main">
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
                  Sort the videos you save from your phone into folders, cut and caption
                  the good ones, and export them for anywhere. Everything happens on this
                  computer. Nothing is uploaded.
                </p>
                <ul className="setup__perks">
                  <li><Folder size={20} /><div><strong>Sort</strong><span>Watch each video and press a bucket. It moves into that folder.</span></div></li>
                  <li><Scissors size={20} /><div><strong>Cut</strong><span>Trim, split, speed up, add text, blur, transitions and music.</span></div></li>
                  <li><Captions size={20} /><div><strong>Caption</strong><span>Captions from the speech, worked out offline, translated if you like.</span></div></li>
                </ul>
                <p className="setup__hint">Set-up takes about a minute. You can change any of it later.</p>
              </>
            ) : null}

            {step === 1 ? (
              <>
                <h1 className="setup__title">Where are your videos?</h1>
                <p className="setup__lead">
                  Point at the folder you copy phone videos into. Buckets are made as
                  folders inside it, and nothing is moved anywhere else.
                </p>
                <SourcePicker current={state.sourceDir} onPicked={(s) => { onState(s); next() }} onCancel={null} />
              </>
            ) : null}

            {step === 2 ? (
              <>
                <h1 className="setup__title">Captions and translation</h1>
                <p className="setup__lead">
                  Captions are worked out by a speech program on this computer, so they
                  work offline and nothing is uploaded. It is a one-time download. Speech
                  in another language can be translated into English.
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
                    <div><strong>Later</strong><span>Downloads the first time you press Captions in the editor.</span></div>
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
                <p className="setup__lead">Three things that make it feel like a proper app. All optional, all changeable later.</p>
                <div className="setup__rows">
                  <div className="setup__row">
                    <Film size={20} />
                    <div>
                      <strong>FFmpeg {state.tools
                        ? <b className="setup__badge"><Check size={13} /> Found</b>
                        : <b className="setup__badge setup__badge--no">Not found</b>}
                      </strong>
                      <span>{state.tools
                        ? 'It plays, cuts and exports the video. Nothing to do.'
                        : <>Needed to play, cut and export. Install it from a terminal with <code>{WINGET}</code>, then start the app again.</>}
                      </span>
                    </div>
                    {!state.tools ? <button className="pill pill--sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button> : null}
                  </div>
                  <div className="setup__row">
                    <Download size={20} />
                    <div>
                      <strong>Install as an app</strong>
                      <span>{standalone
                        ? 'Done: this is the installed app.'
                        : installPrompt
                          ? 'Its own window and a taskbar icon, no browser bar.'
                          : 'Its own window and a taskbar icon. Open the browser menu (⋮) and choose Install Video Splitter.'}
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
                      <span>{boot && !boot.supported ? 'Only on Windows.' : 'Ready the moment you log in, quietly in the background.'}</span>
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
