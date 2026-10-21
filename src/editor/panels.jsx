import { useRef, useState } from 'react'
import { TRANSITIONS, formatClock, parseClock } from './model.js'
import { COLORS, CUSTOM_FONTS, FONTS, IN_ANIMS, LOOP_ANIMS, OUT_ANIMS, SIZE_MAX, SIZE_MIN, STYLES, animsOf } from './text.js'
import { loadFont } from './fonts.js'
import { uploadFont } from '../api.js'

export function Tool ({ icon, label, hint, on, title, ...rest }) {
  return (
    <button className={'tool' + (on ? ' is-on' : '')} title={title || (hint ? `${label} (${hint})` : label)} {...rest}>
      <span className="tool__icon">{icon}</span>
      <span className="tool__label">{label}</span>
    </button>
  )
}

export function Choice ({ on, children, ...rest }) {
  return <button className={'chip' + (on ? ' is-on' : '')} aria-pressed={Boolean(on)} {...rest}>{children}</button>
}

export function TypedSplit ({ total, onSubmit, onClose }) {
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  return (
    <form
      className="ed__panel"
      onSubmit={(e) => {
        e.preventDefault()
        const problem = onSubmit(text)
        setError(problem)
        if (!problem) setText('')
      }}
    >
      <label className="ed__panel-label" htmlFor="split-at">Split at</label>
      <input
        id="split-at"
        className="ed__field"
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null) }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        placeholder="1:15"
        autoFocus
        spellCheck={false}
      />
      <span className="ed__panel-hint">on the timeline, 00:00 to {formatClock(total, true)}</span>
      <button className="ed__go" type="submit" disabled={!text.trim()}>Split</button>
      {error ? <span className="ed__panel-error">{error}</span> : null}
    </form>
  )
}

export function PartsSplit ({ replacing, total, onSubmit, onClose }) {
  const [n, setN] = useState('5')
  const [error, setError] = useState(null)
  const count = Math.round(Number(n))
  const each = count >= 2 ? total / count : 0
  return (
    <form
      className="ed__panel"
      onSubmit={(e) => {
        e.preventDefault()
        const problem = onSubmit(count)
        setError(problem)
        if (!problem) onClose()
      }}
    >
      <label className="ed__panel-label" htmlFor="split-n">Cut into</label>
      <input
        id="split-n"
        className="ed__field ed__field--n"
        type="number"
        min="2"
        max="100"
        value={n}
        onChange={(e) => { setN(e.target.value); setError(null) }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        autoFocus
      />
      <span className="ed__panel-label">equal parts</span>
      <span className="ed__panel-hint">
        {each ? `about ${formatClock(each, true)} each, saved as separate files` : ''}
        {replacing ? '. Replaces your current cuts; Undo brings them back' : ''}
      </span>
      <button className="ed__go" type="submit" disabled={!(count >= 2)}>Cut</button>
      {error ? <span className="ed__panel-error">{error}</span> : null}
    </form>
  )
}

/**
 * One added sound: how loud, when it starts on the timeline, and where in the
 * sound file it starts. Its length is set by dragging the ends of its bar.
 */
export function SoundPanel ({ sound, total, clipSound, canClipSound, onClipSound, onChange, onAnother, onRemove, onClose }) {
  const pct = Math.round(sound.volume * 100)
  const room = (sound.duration || Infinity)
  return (
    <div className="ed__panel ed__panel--text">
      <div className="ed__textrow">
        <span className="ed__panel-label ed__song" title={sound.name}>♪ {sound.name}</span>
        <label className="ed__panel-hint ed__vol ed__nogrow">
          Volume
          <input
            type="range"
            min="0"
            max="100"
            value={pct}
            onChange={(e) => onChange({ volume: Number(e.target.value) / 100 }, 'vol:' + sound.id)}
            aria-label="Sound volume"
          />
          <span className="ed__vol-n">{pct}%</span>
        </label>
        <span className="ed__grow" />
        <button className="ed__ghost" onClick={onAnother}>+ Another sound</button>
        <button className="ed__ghost ed__ghost--bad" onClick={onRemove}>Remove</button>
        <button className="ed__go" onClick={onClose}>Done</button>
      </div>
      <div className="ed__textrow">
        <span className="ed__panel-hint ed__nogrow">Starts at</span>
        <TimeBox label="Starts at" value={sound.at} onCommit={(v) => onChange({ at: Math.min(Math.max(v, 0), Math.max(0, total - 0.2)) })} />
        <span className="ed__panel-hint ed__nogrow">on the timeline, playing from</span>
        <TimeBox label="Plays from" value={sound.from} onCommit={(v) => onChange({ from: Math.min(Math.max(v, 0), Math.max(0, room - 0.2)) })} />
        <span className="ed__panel-hint ed__nogrow">into the sound, for {formatClock(sound.len, true)}</span>
        <span className="ed__grow" />
        {canClipSound ? (
          <Choice on={clipSound} onClick={() => onClipSound(!clipSound)}>{clipSound ? 'Clip sound on' : 'Clip sound off'}</Choice>
        ) : null}
      </div>
    </div>
  )
}

/** A time typed as 1:15.50 or seconds; commits on Enter or leaving the box. */
function TimeBox ({ value, onCommit, label }) {
  const [draft, setDraft] = useState(null)
  const commit = () => {
    if (draft === null) return
    const v = parseClock(draft)
    setDraft(null)
    if (v !== null) onCommit(v)
  }
  return (
    <input
      className="ed__field ed__field--time"
      value={draft ?? formatClock(value, true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur() } }}
      aria-label={label}
      spellCheck={false}
    />
  )
}

export function TextPanel ({ item, fresh, captions, total, onChange, onStyleAll, onDelete, onClose, onUndo, onRedo }) {
  const [tab, setTab] = useState('font')
  const [, setFontsChanged] = useState(0)
  const [fontError, setFontError] = useState(null)
  const fontInput = useRef(null)
  const anims = animsOf(item)
  const loops = Object.entries(LOOP_ANIMS).filter(([k]) => k !== 'karaoke' || (item.words && item.words.length))
  const setAnim = (patch) => onChange({ ...anims, ...patch })

  async function importFont (file) {
    if (!file) return
    setFontError(null)
    try {
      const { added } = await uploadFont(file)
      const family = await loadFont(added)
      if (!family) throw new Error('The browser could not read that font')
      setFontsChanged((n) => n + 1)
      onChange({ font: 'font:' + family })
    } catch (err) {
      setFontError(err.message)
    }
  }

  const fontChoices = [...Object.entries(FONTS), ...Object.entries(CUSTOM_FONTS)]
  return (
    <div className="ed__panel ed__panel--text">
      <div className="ed__textrow ed__textrow--top">
        <textarea
          className="ed__textin"
          value={item.text}
          rows={Math.min(3, Math.max(1, item.text.split('\n').length))}
          onChange={(e) => onChange({ text: e.target.value }, 'text:' + item.id)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose() }
            // The edit's own undo, so the words and everything else stay in step.
            const ctrl = e.ctrlKey || e.metaKey
            if (ctrl && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? onRedo() : onUndo() }
            if (ctrl && e.code === 'KeyY') { e.preventDefault(); onRedo() }
          }}
          autoFocus={fresh}
          onFocus={(e) => { if (fresh && item.text === 'Your text') e.target.select() }}
          aria-label="Text"
          spellCheck
        />
        <label className="ed__panel-hint ed__vol ed__nogrow">
          Size
          <input
            type="range"
            min={SIZE_MIN * 1000}
            max={SIZE_MAX * 1000}
            value={Math.round(item.size * 1000)}
            onChange={(e) => onChange({ size: Number(e.target.value) / 1000 }, 'size:' + item.id)}
            aria-label="Text size"
          />
        </label>
        <button className="ed__ghost ed__ghost--bad" onClick={onDelete}>Delete</button>
        <button className="ed__go" onClick={onClose}>Done</button>
      </div>
      <div className="ed__tabs" role="tablist">
        {[['font', 'Font'], ['style', 'Style'], ['anim', 'Animation'], ['colour', 'Colour']].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={'ed__tab' + (tab === k ? ' is-on' : '')} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
        <span className="ed__grow" />
        {item.caption && captions > 1 ? <button className="textbtn" onClick={onStyleAll}>Use this look for all {captions} captions</button> : null}
      </div>
      {tab === 'font' ? (
        <div className="ed__textrow">
          {fontChoices.map(([k, f]) => (
            <Choice
              key={k}
              on={item.font === k}
              // Hand lettering looks hand-drawn when it moves a little, so it
              // brings its wobble along unless something else already moves it.
              onClick={() => onChange(k === 'hand' && anims.animLoop === 'none' ? { font: k, ...anims, animLoop: 'wobble' } : { font: k })}
            >
              <span style={{ font: f.css(13) }}>{f.label}</span>
            </Choice>
          ))}
          <button className="ed__ghost" onClick={() => fontInput.current?.click()} title="Use a font file from this computer: .ttf, .otf, .woff or .woff2">+ Import font…</button>
          <input ref={fontInput} type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={(e) => { importFont(e.target.files?.[0]); e.target.value = '' }} />
          {fontError ? <span className="ed__panel-error">{fontError}</span> : null}
        </div>
      ) : null}
      {tab === 'style' ? (
        <div className="ed__textrow">
          {Object.entries(STYLES).map(([k, label]) => (
            <Choice key={k} on={item.style === k} onClick={() => onChange({ style: k })}>{label}</Choice>
          ))}
        </div>
      ) : null}
      {tab === 'anim' ? (
        <div className="ed__animgrid">
          <span className="ed__animlabel">On screen</span>
          <div className="ed__textrow">
            <TimeBox label="Shows from" value={item.start} onCommit={(v) => onChange({ start: Math.min(Math.max(v, 0), item.end - 0.2) })} />
            <span className="ed__panel-hint ed__nogrow">to</span>
            <TimeBox label="Shows until" value={item.end} onCommit={(v) => onChange({ end: Math.max(Math.min(v, total), item.start + 0.2) })} />
            <span className="ed__panel-hint">{formatClock(item.end - item.start, true)} long</span>
          </div>
          <span className="ed__animlabel">In</span>
          <div className="ed__textrow">
            {Object.entries(IN_ANIMS).map(([k, label]) => (
              <Choice key={k} on={anims.animIn === k} onClick={() => setAnim({ animIn: k })}>{label}</Choice>
            ))}
          </div>
          <span className="ed__animlabel">Out</span>
          <div className="ed__textrow">
            {Object.entries(OUT_ANIMS).map(([k, label]) => (
              <Choice key={k} on={anims.animOut === k} onClick={() => setAnim({ animOut: k })}>{label}</Choice>
            ))}
          </div>
          <span className="ed__animlabel">While showing</span>
          <div className="ed__textrow">
            {loops.map(([k, label]) => (
              <Choice key={k} on={anims.animLoop === k} onClick={() => setAnim({ animLoop: k })}>{label}</Choice>
            ))}
          </div>
        </div>
      ) : null}
      {tab === 'colour' ? (
        <div className="ed__textrow">
          {COLORS.map((c) => (
            <button
              key={c}
              className={'swatch' + (item.color === c ? ' is-on' : '')}
              style={{ background: c }}
              onClick={() => onChange({ color: c })}
              aria-label={'Colour ' + c}
              title={item.style === 'pill' || item.style === 'marker' ? 'Background colour' : 'Text colour'}
            />
          ))}
          {anims.animLoop === 'karaoke' ? (
            <>
              <span className="ed__panel-sep" />
              <span className="ed__panel-hint ed__nogrow">Spoken word</span>
              {COLORS.filter((c) => c !== item.color).slice(0, 6).map((c) => (
                <button
                  key={'hl' + c}
                  className={'swatch swatch--sm' + ((item.hl || '#ffe14d') === c ? ' is-on' : '')}
                  style={{ background: c }}
                  onClick={() => onChange({ hl: c })}
                  aria-label={'Highlight colour ' + c}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const FADE_STEPS = [0, 0.5, 1, 2]

/**
 * Transitions between pieces, and fading the whole video in and out. A cut is
 * chosen by clicking its small square on the timeline.
 */
export function TransitionPanel ({ join, piece, count, look, playable, onSet, onAll, onFades, onClose }) {
  const t = piece?.transition || null
  const d = t ? t.d : 0.6
  return (
    <div className="ed__panel ed__panel--text">
      {join ? (
        <div className="ed__textrow">
          <span className="ed__panel-label ed__nogrow">Cut {join} of {count - 1}</span>
          <Choice on={!t} onClick={() => onSet(null, d)}>None</Choice>
          {Object.entries(TRANSITIONS).map(([k, label]) => (
            <Choice key={k} on={t?.type === k} onClick={() => onSet(k, d)}>{label}</Choice>
          ))}
        </div>
      ) : (
        <p className="ed__panel-hint">Click a small square between two pieces on the timeline to add a transition at that cut.</p>
      )}
      {join && t ? (
        <div className="ed__textrow">
          <label className="ed__panel-hint ed__vol ed__nogrow">
            Length
            <input
              type="range"
              min="200"
              max="2000"
              step="100"
              value={Math.round(d * 1000)}
              onChange={(e) => onSet(t.type, Number(e.target.value) / 1000, 'len:' + join)}
              aria-label="Transition length"
            />
            <span className="ed__vol-n">{d.toFixed(1)} s</span>
          </label>
          {count > 2 ? <button className="ed__ghost" onClick={() => onAll(t.type, d)}>Use on every cut</button> : null}
        </div>
      ) : null}
      {join && t && !playable ? (
        <p className="ed__panel-error">
          This cut has no spare footage on either side: both pieces run to the very end of their clips there.
          Trim a little off one of them and the transition will play.
        </p>
      ) : null}
      <div className="ed__textrow">
        <span className="ed__panel-label ed__nogrow">Fade in</span>
        {FADE_STEPS.map((v) => (
          <Choice key={'i' + v} on={(look.fadeIn || 0) === v} onClick={() => onFades({ fadeIn: v })}>{v ? v + ' s' : 'Off'}</Choice>
        ))}
        <span className="ed__panel-sep" />
        <span className="ed__panel-label ed__nogrow">Fade out</span>
        {FADE_STEPS.map((v) => (
          <Choice key={'o' + v} on={(look.fadeOut || 0) === v} onClick={() => onFades({ fadeOut: v })}>{v ? v + ' s' : 'Off'}</Choice>
        ))}
        <span className="ed__grow" />
        <button className="ed__go" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
