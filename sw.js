const CACHE = 'kaplan-os-v1'
const SHELL = ['/', '/index.html', '/parent.html', '/manifest.json', '/icon.svg']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  // Network-only for API calls
  if (e.request.url.includes('/api/')) return

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached
      return fetch(e.request).then(res => {
        const copy = res.clone()
        caches.open(CACHE).then(c => c.put(e.request, copy))
        return res
      })
    })
  )
})
