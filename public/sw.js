/* Service worker for Video Splitter.
 *
 * Two jobs. It satisfies the installability requirement, which is what lets
 * Edge and Chrome offer "Install this app" and give the tool a real window.
 * And it caches the app shell, so if you launch the installed app before the
 * server is running you get our own "server is not running" screen instead of
 * the browser's error page.
 *
 * It deliberately never caches /api/. Folder listings, video streams and
 * export results must always come from the live server.
 */

const CACHE = 'video-splitter-v2'

const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png'
]

/**
 * Caches the shell plus the bundles it pulls in.
 *
 * Caching index.html alone is not enough: it loads hashed /assets/*.js and
 * .css, and without those the page comes up blank when the server is down,
 * which defeats the point. The filenames change on every build, so rather than
 * hardcode them we read them out of the HTML we just cached.
 */
async function precache () {
  const cache = await caches.open(CACHE)
  await Promise.allSettled(SHELL.map((url) => cache.add(url)))

  try {
    const shell = await cache.match('/')
    if (!shell) return
    const html = await shell.clone().text()
    const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1])
    await Promise.allSettled([...new Set(assets)].map((url) => cache.add(url)))
  } catch {
    // A partial cache still beats none.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

function remember (request, response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return
  const copy = response.clone()
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // Navigations go to the network first so a rebuilt interface shows up
  // immediately, with the cached shell as the fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          remember(request, response)
          return response
        })
        .catch(() => caches.match('/').then((hit) => hit || caches.match('/index.html')))
    )
    return
  }

  // Everything else is a hashed build asset or an icon, so cache first.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit
      return fetch(request).then((response) => {
        remember(request, response)
        return response
      })
    })
  )
})
