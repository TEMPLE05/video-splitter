import { useRef, useState } from 'react'
import { SPEED_MAX, SPEED_MIN, TRANSITIONS, formatClock, isImage, lengthOf, parseClock, speedsOf } from './model.js'
import { COLORS, CUSTOM_FONTS, FONTS, IN_ANIMS, LOOP_ANIMS, OUT_ANIMS, SIZE_MAX, SIZE_MIN, STYLES, animsOf } from './text.js'
import { loadFont } from './fonts.js'
import { uploadFont } from '../api.js'
import { BLUR_SHAPES } from './blur.js'

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
export function SoundPanel ({ sound, total, clipSound, canClipSound, onClipSound, onChange, onAnother, onAfter, onRemove, onClose }) {
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
        <button className="ed__ghost" onClick={onAfter} title="The next sound starts when this one ends">+ Sound after this</button>
        <button className="ed__ghost" onClick={onAnother} title="Another sound at the playhead">+ Sound here</button>
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

export function TextPanel ({ item, fresh, captions, total, onChange, onStyleAll, onDelete, onClose, onUndo, onRedo, onBelow, onDuplicate }) {
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
        <button className="ed__ghost" onClick={onBelow} title="A new line under this one, appearing a second after it">+ Text below</button>
        <button className="ed__ghost" onClick={onDuplicate} title="A copy right after this one, same place and style (D)">Duplicate</button>
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

// The speed slider runs on a log scale, so 1x sits in the middle and 0.5x and
// 2x are as far from it as each other. Close to 1x it snaps to 1x.
const SPAN = Math.log(SPEED_MAX / SPEED_MIN)
const toPos = (v) => Math.round((Math.log(v / SPEED_MIN) / SPAN) * 1000)
const fromPos = (pos) => {
  const v = SPEED_MIN * Math.exp((pos / 1000) * SPAN)
  if (Math.abs(v - 1) < 0.04) return 1
  return Number(v.toFixed(v < 1 ? 2 : 1))
}
const showSpeed = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)) + '×'

function SpeedSlider ({ label, value, onChange }) {
  return (
    <label className="ed__panel-hint ed__vol ed__nogrow">
      {label}
      <input
        type="range"
        className="ed__speed"
        min="0"
        max="1000"
        step="1"
        value={toPos(value)}
        onChange={(e) => onChange(fromPos(Number(e.target.value)))}
        aria-label={label}
      />
      <span className="ed__vol-n">{showSpeed(value)}</span>
    </label>
  )
}

/**
 * Speed of one piece: steady, or slow then fast across it, with the voice
 * either kept as it is or let go high and low (chipmunk and deep), and
 * optional made-up in-between frames so slow motion does not stutter.
 */
export function SpeedPanel ({ piece, count, onChange, onAll, onClose }) {
  if (!piece || isImage(piece)) {
    return (
      <div className="ed__panel ed__panel--text">
        <div className="ed__textrow">
          <p className="ed__panel-hint ed__grow">
            {piece ? 'A picture has no speed: drag its white handles to show it for longer or shorter.' : 'Tap a piece on the timeline to change its speed.'}
          </p>
          <button className="ed__go" onClick={onClose}>Done</button>
        </div>
      </div>
    )
  }
  const [a, b] = speedsOf(piece)
  const ramp = piece.speedEnd != null
  const footage = piece.end - piece.start
  const key = 'speed:' + piece.id
  const slow = Math.min(a, b) < 1
  return (
    <div className="ed__panel ed__panel--text">
      <div className="ed__textrow">
        <span className="ed__panel-label ed__nogrow">Speed</span>
        <Choice on={!ramp} onClick={() => onChange({ speedEnd: undefined })}>Steady</Choice>
        <Choice on={ramp} onClick={() => !ramp && onChange({ speed: Math.max(SPEED_MIN, a / 2), speedEnd: Math.min(SPEED_MAX, a * 2) })} title="Starts at one speed and ends at another, smoothly">Slow then fast</Choice>
        <span className="ed__panel-sep" />
        <span className="ed__panel-label ed__nogrow">Voice</span>
        <Choice on={piece.pitch !== 'shift'} onClick={() => onChange({ pitch: undefined })} title="Sped up or slowed down, voices still sound like themselves">Sounds normal</Choice>
        <Choice on={piece.pitch === 'shift'} onClick={() => onChange({ pitch: 'shift' })} title="Faster goes high like a chipmunk, slower goes deep">Chipmunk / deep</Choice>
        <span className="ed__grow" />
        {a !== 1 || b !== 1 || ramp || piece.pitch || piece.smooth
          ? <button className="ed__ghost" onClick={() => onChange({ speed: undefined, speedEnd: undefined, pitch: undefined, smooth: undefined })}>Normal speed</button>
          : null}
        <button className="ed__go" onClick={onClose}>Done</button>
      </div>
      <div className="ed__textrow">
        {ramp ? (
          <>
            <SpeedSlider label="Starts at" value={a} onChange={(v) => onChange({ speed: v }, key + ':a')} />
            <SpeedSlider label="Ends at" value={b} onChange={(v) => onChange({ speedEnd: v }, key + ':b')} />
          </>
        ) : (
          <SpeedSlider label="Speed" value={a} onChange={(v) => onChange({ speed: v === 1 ? undefined : v }, key)} />
        )}
        <span className="ed__panel-hint ed__grow">
          Plays for {formatClock(lengthOf(piece), true)}{a !== 1 || b !== 1 ? ` (filmed ${formatClock(footage, true)})` : ''}
        </span>
        {count > 1 ? <button className="ed__ghost" onClick={onAll}>Use on every clip piece</button> : null}
      </div>
      {slow ? (
        <div className="ed__textrow">
          <Choice on={Boolean(piece.smooth)} onClick={() => onChange({ smooth: piece.smooth ? undefined : true })}>Smooth slow motion</Choice>
          <span className="ed__panel-hint ed__grow">
            {piece.smooth
              ? 'The export makes up in-between frames so slow parts glide instead of stutter. It makes exporting much slower, and the preview does not show it.'
              : 'Slowed footage can stutter, since the phone filmed too few frames. This makes up the in-between frames when you export.'}
          </span>
        </div>
      ) : null}
    </div>
  )
}

const BRUSH_MIN = 0.01
const BRUSH_MAX = 0.12

function BrushSize ({ value, onChange }) {
  return (
    <label className="ed__panel-hint ed__vol ed__nogrow">
      Pencil size
      <input
        type="range"
        min={BRUSH_MIN * 1000}
        max={BRUSH_MAX * 1000}
        step="5"
        value={Math.round(value * 1000)}
        onChange={(e) => onChange(Number(e.target.value) / 1000)}
        aria-label="Pencil size"
      />
    </label>
  )
}

/**
 * Blurring part of the picture. With nothing chosen it is the drawing tool:
 * paint over what to hide, or drag a box or an oval. With a blur chosen it
 * sets how strong it is, when it shows, and the spots it glides between
 * when the thing it hides moves.
 */
export function BlurPanel ({ blur, draw, onDraw, total, t, onChange, onMark, onUnmark, onGo, onDelete, onDuplicate, onClose }) {
  if (!blur) {
    return (
      <div className="ed__panel ed__panel--text">
        <div className="ed__textrow">
          <span className="ed__panel-label ed__nogrow">Blur</span>
          {Object.entries(BLUR_SHAPES).map(([k, label]) => (
            <Choice key={k} on={draw.shape === k} onClick={() => onDraw({ shape: k })}>{label}</Choice>
          ))}
          {draw.shape === 'pencil' ? <BrushSize value={draw.size} onChange={(size) => onDraw({ size })} /> : null}
          <span className="ed__grow" />
          <button className="ed__go" onClick={onClose}>Cancel</button>
        </div>
        <p className="ed__panel-hint">
          {draw.shape === 'pencil'
            ? 'Paint over what you want hidden on the picture. Let go and it is blurred from here to the end; drag its ends on the timeline to change that.'
            : 'Drag a ' + (draw.shape === 'oval' ? 'circle' : 'box') + ' over what you want hidden on the picture.'}
        </p>
      </div>
    )
  }
  const moving = Boolean(blur.moving)
  const inside = t >= blur.start - 1e-6 && t < blur.end
  return (
    <div className="ed__panel ed__panel--text">
      <div className="ed__textrow">
        <span className="ed__panel-label ed__nogrow">Blur</span>
        <label className="ed__panel-hint ed__vol ed__nogrow">
          Strength
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={Math.round((blur.strength ?? 0.5) * 100)}
            onChange={(e) => onChange({ strength: Number(e.target.value) / 100 }, 'blur-strength:' + blur.id)}
            aria-label="Blur strength"
          />
        </label>
        {blur.shape === 'pencil' ? (
          <>
            <Choice on={draw.more} onClick={() => onDraw({ more: !draw.more })} title="Paint over more of the picture to hide it too">Paint more</Choice>
            {draw.more ? <BrushSize value={draw.size} onChange={(size) => onDraw({ size })} /> : null}
          </>
        ) : (
          ['box', 'oval'].map((k) => <Choice key={k} on={blur.shape === k} onClick={() => onChange({ shape: k })}>{BLUR_SHAPES[k]}</Choice>)
        )}
        <span className="ed__grow" />
        <button className="ed__ghost" onClick={onDuplicate}>Duplicate</button>
        <button className="ed__ghost" onClick={onDelete}>Delete</button>
        <button className="ed__go" onClick={onClose}>Done</button>
      </div>
      <div className="ed__textrow">
        <TimeBox label="Shows from" value={blur.start} onCommit={(v) => onChange({ start: Math.min(Math.max(v, 0), blur.end - 0.2) })} />
        <span className="ed__panel-hint ed__nogrow">to</span>
        <TimeBox label="Shows until" value={blur.end} onCommit={(v) => onChange({ end: Math.max(Math.min(v, total), blur.start + 0.2) })} />
        <span className="ed__panel-sep" />
        <span className="ed__panel-label ed__nogrow">{moving ? 'Glides between' : 'Stays in place'}</span>
        {moving ? blur.spots.map((s, i) => (
          <span key={i} className="chip chip--spot">
            <button className="chip__go" onClick={() => onGo(blur.start + s.t)} title="Go to this spot">{formatClock(blur.start + s.t, true)}</button>
            <button className="chip__x" onClick={() => onUnmark(i)} aria-label={'Remove the spot at ' + formatClock(blur.start + s.t, true)}>×</button>
          </span>
        )) : null}
        <button className="ed__ghost" onClick={onMark} disabled={!inside} title={inside ? 'Mark where the blur is at this moment' : 'Move the playhead over the blur first'}>+ Mark a spot here</button>
      </div>
      <p className="ed__panel-hint">
        {!inside
          ? 'The playhead is outside this blur; move it over the blur to see and move it.'
          : moving
            ? 'Play to where the thing has moved, pause, and drag the blur onto it: a spot is marked there and the blur glides between spots.'
            : 'Drag the blur on the picture to move it, or a corner to size it. If the thing moves, mark a spot here, then play on and drag the blur to follow it.'}
      </p>
    </div>
  )
}
