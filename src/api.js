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

export const browse = (dir) =>
  request('/api/browse' + (dir ? '?dir=' + encodeURIComponent(dir) : ''))

export const setSource = (dir) => request('/api/source', json('POST', { dir }))

export const createBucket = (name) => request('/api/buckets', json('POST', { name }))

export const assign = (id, bucketId) => request('/api/assign', json('POST', { id, bucketId }))

export const undo = () => request('/api/undo', { method: 'POST' })

export const videoUrl = (id) => '/api/video/' + encodeURIComponent(id)

export const listBucket = (id) => request('/api/bucket/' + encodeURIComponent(id))

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
