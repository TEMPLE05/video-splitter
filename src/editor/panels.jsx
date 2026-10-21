import { useState } from 'react'
import { formatClock } from './model.js'
import { ANIMS, COLORS, FONTS, SIZE_MAX, SIZE_MIN, STYLES } from './text.js'

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

export function SoundPanel ({ music, clipSound, canClipSound, onClipSound, onVolume, onReplace, onRemove, onClose }) {
  const pct = Math.round(music.volume * 100)
  const from = music.offset >= 0
    ? `from ${formatClock(music.offset, true)} into the song`
    : `${formatClock(-music.offset, true)} into the video`
  return (
    <div className="ed__panel">
      <span className="ed__panel-label ed__song" title={music.name}>♪ {music.name}</span>
      <label className="ed__panel-hint ed__vol">
        Volume
        <input
          type="range"
          min="0"
          max="100"
          value={pct}
          onChange={(e) => onVolume(Number(e.target.value) / 100, false)}
          onPointerUp={(e) => onVolume(Number(e.target.value) / 100, true)}
          onKeyUp={(e) => onVolume(Number(e.target.value) / 100, true)}
          aria-label="Song volume"
        />
        <span className="ed__vol-n">{pct}%</span>
      </label>
      <span className="ed__panel-hint">Starts {from}. Drag the green bar to slide it.</span>
      {canClipSound ? (
        <Choice on={clipSound} onClick={() => onClipSound(!clipSound)}>{clipSound ? 'Clip sound on' : 'Clip sound off'}</Choice>
      ) : null}
      <button className="ed__ghost" onClick={onReplace}>Replace</button>
      <button className="ed__ghost ed__ghost--bad" onClick={onRemove}>Remove</button>
      <button className="ed__go" onClick={onClose}>Done</button>
    </div>
  )
}

export function TextPanel ({ item, fresh, captions, onChange, onStyleAll, onDelete, onClose, onUndo, onRedo }) {
  const [tab, setTab] = useState('font')
  const anims = Object.entries(ANIMS).filter(([k]) => k !== 'karaoke' || (item.words && item.words.length))
  return (
    <div className="ed__panel ed__panel--text">
      <textarea
        className="ed__textin"
        value={item.text}
        rows={2}
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
      <div className="ed__tabs" role="tablist">
        {[['font', 'Font'], ['style', 'Style'], ['anim', 'Animation'], ['colour', 'Colour']].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={'ed__tab' + (tab === k ? ' is-on' : '')} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="ed__textrow">
        {tab === 'font' ? Object.entries(FONTS).map(([k, f]) => (
          <Choice
            key={k}
            on={item.font === k}
            // Hand lettering looks hand-drawn when it moves a little, so it
            // brings its wobble along unless another animation is chosen.
            onClick={() => onChange(k === 'hand' && (!item.anim || item.anim === 'none') ? { font: k, anim: 'wobble' } : { font: k })}
          >
            <span style={{ font: f.css(13) }}>{f.label}</span>
          </Choice>
        )) : null}
        {tab === 'style' ? Object.entries(STYLES).map(([k, label]) => (
          <Choice key={k} on={item.style === k} onClick={() => onChange({ style: k })}>{label}</Choice>
        )) : null}
        {tab === 'anim' ? anims.map(([k, label]) => (
          <Choice key={k} on={(item.anim || 'none') === k} onClick={() => onChange({ anim: k })}>{label}</Choice>
        )) : null}
        {tab === 'colour' ? (
          <>
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
            {item.anim === 'karaoke' ? (
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
          </>
        ) : null}
      </div>
      <div className="ed__textrow">
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
        <span className="ed__grow" />
        {item.caption && captions > 1 ? <button className="ed__ghost" onClick={onStyleAll}>Use this look for all {captions} captions</button> : null}
        <button className="ed__ghost ed__ghost--bad" onClick={onDelete}>Delete</button>
        <button className="ed__go" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
