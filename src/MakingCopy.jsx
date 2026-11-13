/**
 * Shown while a playable copy of a video is being made (server/previews.js):
 * which kind of work it is, how far along, or why it could not be made.
 */
export default function MakingCopy ({ ext, status, error, note }) {
  if (error) {
    return (
      <div className="noplay">
        <p className="noplay__title">This {ext} video will not play here</p>
        <p className="noplay__note">{error}</p>
        {note ? <p className="noplay__note">{note}</p> : null}
      </div>
    )
  }
  const pct = status ? Math.round((status.progress || 0) * 100) : 0
  const what = !status || status.state === 'waiting'
    ? (status && status.ahead ? 'Waiting for another copy to finish' : 'Getting it ready')
    : status.repack ? 'Repackaging it, a few seconds' : 'Making a playable copy'
  const left = status && status.left != null
    ? (status.left >= 90 ? ', about ' + Math.round(status.left / 60) + ' min left' : status.left >= 10 ? ', under a minute left' : '')
    : ''
  return (
    <div className="noplay" role="status">
      <p className="noplay__title">Getting this {ext} video ready to play</p>
      <div className="noplay__bar"><i style={{ width: Math.max(pct, 3) + '%' }} /></div>
      <p className="noplay__note">{what}{status && status.state === 'making' ? '… ' + pct + '%' + left : '…'}</p>
      <p className="noplay__note noplay__note--soft">Only the first time. Exports still use your original file.{note ? ' ' + note : ''}</p>
    </div>
  )
}
