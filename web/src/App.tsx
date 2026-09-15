/**
 * One app, one port. `/` is the landing page, `/docs` the documentation, `/sim`
 * the simulation. Routing is the History API: internal links are intercepted and
 * the view swaps in place, so entering the sim never makes an HTTP request for a
 * page that does not exist. A refresh on /sim works because Vite serves
 * index.html for unknown paths (a production host needs the same SPA fallback).
 *
 * ponytail: a path in state and a click listener, not a router library. Add one
 * when there are nested routes or route params.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import Landing from './Landing'

// The sim pulls in three.js, the GLB loader and the socket; only load it on /sim.
const Sim = lazy(() => import('./Sim'))
const Docs = lazy(() => import('./Docs'))

const TITLES: Record<string, string> = {
  '/': 'FLYER // WETWARE V.1',
  '/docs': 'FLYER // DOCS',
  '/sim': 'FLYER // SIM',
}

export function navigate(to: string) {
  const url = new URL(to, window.location.href)
  if (url.pathname + url.search === window.location.pathname + window.location.search) return
  window.history.pushState(null, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo(0, 0)
}

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a')
      if (!a || (a.target && a.target !== '_self')) return
      const href = a.getAttribute('href')
      if (!href || !href.startsWith('/') || href.startsWith('//')) return
      const url = new URL(href, window.location.href)
      if (!(url.pathname in TITLES)) return
      e.preventDefault()
      navigate(href)
    }
    window.addEventListener('popstate', onPop)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('popstate', onPop)
      document.removeEventListener('click', onClick)
    }
  }, [])

  useEffect(() => {
    document.title = TITLES[path] ?? TITLES['/']
  }, [path])

  return (
    <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#000' }} />}>
      {path === '/sim' ? <Sim /> : path === '/docs' ? <Docs /> : <Landing />}
    </Suspense>
  )
}
