async function request (url, options) {
  const res = await fetch(url, options)
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    throw new Error((body && body.error) || 'Request failed (' + res.status + ')')
  }
  return body
}

const json = (method, data) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
})

export const getState = () => request('/api/state')

/** Bucket videos identical to this one, under any name. */
export const findDupes = (id) => request('/api/dupes/' + encodeURIComponent(id))

/** New videos arriving in the folder, as they land. Returns a function that stops listening. */
export function onArrivals (onArrived, onHello) {
  const es = new EventSource('/api/events')
  es.addEventListener('arrived', (e) => { try { onArrived(JSON.parse(e.data).items || []) } catch { /* malformed */ } })
  es.addEventListener('hello', () => onHello())
  return () => es.close()
}

export const browse = (dir) =>
  request('/api/browse' + (dir ? '?dir=' + encodeURIComponent(dir) : ''))

export const setSource = (dir) => request('/api/source', json('POST', { dir }))

export const createBucket = (name) => request('/api/buckets', json('POST', { name }))

export const assign = (id, bucketId) => request('/api/assign', json('POST', { id, bucketId }))

export const undo = () => request('/api/undo', { method: 'POST' })

// Videos the browser cannot play get a playable copy (server/previews.js).
// Once one is known, videoUrl hands out the copy instead, so every player in
// the app picks it up. Exports read the original on the server regardless.
const withCopy = new Set()
export const hasCopy = (id) => withCopy.has(id)

export const videoUrl = (id) => (withCopy.has(id) ? '/api/preview/' : '/api/video/') + encodeURIComponent(id)

export const previewStatus = (id) => request('/api/preview/' + encodeURIComponent(id) + '/status')
export const makePreview = (id) => request('/api/preview/' + encodeURIComponent(id), { method: 'POST' })

/**
 * Makes (or finds) the playable copy and waits for it, reporting progress on
 * the way. Resolves false if `isStale()` turns true while waiting.
 */
export async function waitForCopy (id, onProgress, isStale) {
  let s = await makePreview(id)
  while (s.state !== 'ready') {
    if (s.state === 'failed') throw new Error(s.error || 'Could not make a playable copy')
    if (isStale && isStale()) return false
    onProgress && onProgress(s)
    await new Promise((resolve) => setTimeout(resolve, 600))
    if (isStale && isStale()) return false
    s = await previewStatus(id)
  }
  withCopy.add(id)
  return true
}

/**
 * Whether this browser can actually show the picture of a video. A file type
 * it knows can still hold a picture format it cannot decode (HEVC without the
 * Windows extension): then it errors, or plays the sound over nothing.
 */
const playsHere = new Map()
export function canPlayHere (id) {
  if (withCopy.has(id)) return Promise.resolve(true)
  if (playsHere.has(id)) return playsHere.get(id)
  const p = new Promise((resolve) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'metadata'
    const done = (ok) => { clearTimeout(t); v.removeAttribute('src'); v.load(); resolve(ok) }
    const t = setTimeout(() => done(true), 8000)
    v.addEventListener('loadedmetadata', () => done(v.videoWidth > 0), { once: true })
    v.addEventListener('error', () => done(false), { once: true })
    v.src = '/api/video/' + encodeURIComponent(id)
  })
  playsHere.set(id, p)
  return p
}

export const listBucket = (id) => request('/api/bucket/' + encodeURIComponent(id)).then((d) => {
  for (const v of (d && d.videos) || []) if (v.preview) withCopy.add(v.id)
  return d
})

export const probeVideo = (id) => request('/api/probe/' + encodeURIComponent(id))

export const exportCuts = (payload) => request('/api/export', json('POST', payload))

export const getPlaces = () => request('/api/places')

export const deleteBucket = (id, unfile) =>
  request('/api/buckets/' + encodeURIComponent(id) + (unfile ? '?unfile=1' : ''), { method: 'DELETE' })

export const clearSource = () => request('/api/source', { method: 'DELETE' })

export const pullAudio = (id, format) => request('/api/audio', json('POST', { id, format }))

export const thumbUrl = (id) => '/api/thumb/' + encodeURIComponent(id)

// Everything inside a bucket, asked fresh right before a removal is offered.
export const bucketContents = (id) => request('/api/buckets/' + encodeURIComponent(id) + '/contents')

export const pullBucketAudio = (bucketId, format) =>
  request('/api/bucket/' + encodeURIComponent(bucketId) + '/audio', json('POST', { format }))

// Editor timeline: a filmstrip of frames across the clip, and its loudness.
export const getStrip = (id) => request('/api/strip/' + encodeURIComponent(id))

export const getWave = (id) => request('/api/wave/' + encodeURIComponent(id))

// Sounds or pictures an edit in this bucket can use.
export const listMedia = (bucketId, kind) =>
  request('/api/bucket/' + encodeURIComponent(bucketId) + '/media?kind=' + kind)

// Copies a file chosen on this computer into the bucket's audio or images folder.
export const uploadMedia = (bucketId, kind, file) =>
  request('/api/bucket/' + encodeURIComponent(bucketId) + '/upload?kind=' + kind + '&name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file
  })

// Auto captions, worked out on this computer.
export const captionsStatus = () => request('/api/captions/status')

export const installCaptions = (model) => request('/api/captions/install', json('POST', { model }))

// Asked repeatedly while it works; answers with progress, then the words.
export const transcribe = (payload) => request('/api/captions/transcribe', json('POST', payload))

// The edit saved for a clip, picked up again when it is reopened.
export const loadEdit = (id) => request('/api/edit/' + encodeURIComponent(id))

export const saveEdit = (id, edit, extra) => request('/api/edit/' + encodeURIComponent(id), json('PUT', { edit, extra }))

export const forgetEdit = (id) => request('/api/edit/' + encodeURIComponent(id), { method: 'DELETE' })

// Exports run in the background; these start one, follow it, and stop it.
export const exportStart = (payload) => request('/api/export', json('POST', { ...payload, async: true }))

export const exportJob = (id) => request('/api/export/job/' + encodeURIComponent(id))

export const exportStop = (id) => request('/api/export/job/' + encodeURIComponent(id) + '/stop', { method: 'POST' })

// Saved looks: a crop, shape, caption style and fades, kept under a name.
export const listLooks = () => request('/api/looks')

export const saveLook = (look) => request('/api/looks', json('POST', look))

export const deleteLook = (id) => request('/api/looks/' + encodeURIComponent(id), { method: 'DELETE' })

// Library housekeeping: the Recycle Bin, moving between buckets, tidying up.
export const trashClips = (ids) => request('/api/clips/trash', json('POST', { ids }))

export const moveClips = (ids, bucketId) => request('/api/clips/move', json('POST', { ids, bucketId }))

export const tidyInfo = () => request('/api/tidy')

export const tidyRun = () => request('/api/tidy', { method: 'POST' })

export const tidyUndo = () => request('/api/tidy/undo', { method: 'POST' })

// Fonts imported from this computer, shared by every clip.
export const listFonts = () => request('/api/fonts')

export const uploadFont = (file) =>
  request('/api/fonts?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file
  })

export const fontUrl = (file) => '/api/fonts/file/' + encodeURIComponent(file)

// Projects: edits that start from pictures and clips rather than one video.
export const listProjects = (bucketId) => request(bucketId ? '/api/bucket/' + encodeURIComponent(bucketId) + '/projects' : '/api/projects')

export const createProject = (data) => request('/api/projects', json('POST', data))

export const getProject = (id) => request('/api/projects/' + encodeURIComponent(id))

export const saveProject = (id, edit, extra) => request('/api/projects/' + encodeURIComponent(id), json('PUT', { edit, extra }))

export const deleteProject = (id) => request('/api/projects/' + encodeURIComponent(id), { method: 'DELETE' })

// Start with Windows: the Startup-folder shortcut, on or off.
export const getStartup = () => request('/api/startup')

export const setStartup = (on) => request('/api/startup', json('POST', { on }))
