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

export const pullBucketAudio = (bucketId, format) =>
  request('/api/bucket/' + encodeURIComponent(bucketId) + '/audio', json('POST', { format }))
