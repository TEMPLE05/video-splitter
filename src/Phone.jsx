import { useEffect, useRef, useState } from 'react'
import { Check, Close, Phone as PhoneIcon } from './icons.jsx'
import { answerPhone, forgetPhone, lookForPhones, setPhone, stopPhone } from './api.js'

const sizeOf = (b) => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'
const videos = (n) => n + (n === 1 ? ' video' : ' videos')

/**
 * Everything about receiving from a phone that shows on screen, whatever
 * screen you are on: the question when a phone wants to send, the progress
 * while it does, a note when it is done, and the panel that switches it on.
 * The server pushes its status as it changes (server/localsend.js).
 */
export default function PhoneLayer ({ phone, onPhone, panel, onPanel }) {
  return (
    <>
      {panel ? <PhonePanel phone={phone} onPhone={onPhone} onClose={() => onPanel(false)} /> : null}
      {phone && phone.request ? <PhoneRequest key={phone.request.id} request={phone.request} onPhone={onPhone} /> : null}
      {phone && phone.receiving ? <PhoneProgress receiving={phone.receiving} onPhone={onPhone} /> : <PhoneResult last={phone && phone.last} />}
    </>
  )
}

/** Switching receiving on, and how to send from the phone. */
function PhonePanel ({ phone, onPhone, onClose }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function run (fn) {
    setBusy(true)
    setError(null)
    try { onPhone(await fn()) } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const on = Boolean(phone && phone.on)
  return (
    <div className="sheetwrap" onClick={onClose}>
      <div className="sheet phone" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <h2 className="sheet__title">Send from your phone</h2>
          <button className="ctl" onClick={onClose} aria-label="Close"><Close size={16} /></button>
        </div>

        <div className="phone__switch">
          <div>
            <strong>Receive with LocalSend</strong>
            <span>Over your Wi-Fi, encrypted. Nothing goes through the internet.</span>
          </div>
          <label className="switch">
            <input type="checkbox" checked={on} disabled={busy || !phone || phone.starting} onChange={(e) => run(() => setPhone(e.target.checked))} aria-label="Receive with LocalSend" />
            <i />
          </label>
        </div>

        {phone && phone.problem ? <p className="sheet__error">{phone.problem}</p> : null}
        {error ? <p className="sheet__error">{error}</p> : null}

        {on ? (
          <>
            <ol className="phone__steps">
              <li>Open <strong>LocalSend</strong> on your phone and pick the videos to send.</li>
              <li>Choose <strong>{phone.alias}</strong> from the list of devices.</li>
              <li>Press <strong>Accept</strong> here. They go into your videos folder, ready to sort.</li>
            </ol>
            <p className="phone__seen">
              {phone.nearby.length
                ? <>Seen on your Wi-Fi: <strong>{phone.nearby.map((d) => d.alias).join(', ')}</strong></>
                : 'No phone seen yet. Open LocalSend on the phone, on the same Wi-Fi.'}
              {' '}<button className="phone__link" onClick={() => run(lookForPhones)} disabled={busy}>Look again</button>
            </p>
            {phone.trusted.length ? (
              <div className="phone__trusted">
                <span>Accepted without asking:</span>
                {phone.trusted.map((t) => (
                  <span className="phone__chip" key={t.fingerprint}>
                    {t.alias}
                    <button onClick={() => run(() => forgetPhone(t.fingerprint))} aria-label={'Ask again for ' + t.alias} title="Ask every time again"><Close size={12} /></button>
                  </span>
                ))}
              </div>
            ) : null}
            <p className="phone__note">
              The first time, Windows may ask whether to let Node.js use your networks. Choose
              <strong> Allow</strong> for private networks, or phones cannot reach this PC.
            </p>
          </>
        ) : (
          <p className="phone__note">
            Needs the free LocalSend app on your phone (App Store or Google Play) and both
            devices on the same Wi-Fi. Only videos are taken, and nothing arrives until you accept it.
          </p>
        )}
      </div>
    </div>
  )
}

/** A phone wants to send: accept or decline. */
function PhoneRequest ({ request, onPhone }) {
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  async function answer (accept) {
    setBusy(true)
    try { onPhone(await answerPhone(request.id, accept, accept && always)) } catch { /* the phone gave up meanwhile */ }
  }
  return (
    <div className="sheetwrap">
      <div className="sheet phone phone--ask" role="alertdialog" aria-label="A phone wants to send videos">
        <div className="phone__from"><PhoneIcon size={22} /></div>
        <h2 className="sheet__title">{request.from} wants to send {videos(request.count)}</h2>
        <p className="sheet__body">
          {sizeOf(request.bytes)}, into your videos folder.
          {request.skipped ? ` ${request.skipped} other ${request.skipped === 1 ? 'file is not a video' : 'files are not videos'} and will be left out.` : ''}
        </p>
        <ul className="phone__names">
          {request.names.map((n) => <li key={n}>{n}</li>)}
          {request.count > request.names.length ? <li className="phone__more">and {request.count - request.names.length} more</li> : null}
        </ul>
        {request.canTrust ? (
          <label className="phone__always">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            Always accept from this phone
          </label>
        ) : null}
        <div className="sheet__actions">
          <button className="pill" onClick={() => answer(false)} disabled={busy}>Decline</button>
          <button className="pill pill--solid" onClick={() => answer(true)} disabled={busy} autoFocus>Accept</button>
        </div>
      </div>
    </div>
  )
}

/** While videos come in. */
function PhoneProgress ({ receiving, onPhone }) {
  const pct = receiving.bytes ? Math.min(100, Math.round((receiving.received / receiving.bytes) * 100)) : 0
  const arrived = receiving.done
  return (
    <div className="phonebar" role="status">
      <PhoneIcon size={16} />
      <div className="phonebar__text">
        <span>Receiving from <strong>{receiving.from}</strong></span>
        <span>{arrived} of {videos(receiving.count)} · {sizeOf(receiving.received)} of {sizeOf(receiving.bytes)}</span>
        <div className="phonebar__bar"><i style={{ width: pct + '%' }} /></div>
      </div>
      <button className="ctl" onClick={() => stopPhone().then(onPhone).catch(() => {})} aria-label="Stop receiving" title="Stop receiving"><Close size={15} /></button>
    </div>
  )
}

/** A short note once a transfer ends, or why one was turned away. */
function PhoneResult ({ last }) {
  const [shown, setShown] = useState(null)
  const seen = useRef(null)
  useEffect(() => {
    const key = last && JSON.stringify(last)
    if (!key || key === seen.current) return
    seen.current = key
    setShown(last)
    const t = setTimeout(() => setShown(null), 7000)
    return () => clearTimeout(t)
  }, [last])
  if (!shown) return null
  const { kind, from } = shown
  let text
  if (kind === 'finished' && !shown.failed) text = <><Check size={15} /> <span><strong>{videos(shown.done)}</strong> arrived from {from}</span></>
  else if (kind === 'finished' || kind === 'cancelled' || kind === 'stalled') {
    text = <span>{kind === 'finished' ? '' : kind === 'stalled' ? 'The phone stopped sending. ' : 'Stopped. '}<strong>{videos(shown.done)}</strong> arrived{shown.failed ? `, ${shown.failed} did not` : ''}</span>
  } else if (kind === 'no-videos') text = <span>{from} sent no videos, so nothing was taken</span>
  else if (kind === 'no-room') text = <span>Not enough space on the disk for {sizeOf(shown.bytes)} from {from}</span>
  else if (kind === 'no-folder') text = <span>Choose a videos folder first, then send again</span>
  else return null
  return <div className="phonebar phonebar--done" role="status">{text}</div>
}
