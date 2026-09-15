/**
 * Phone layout for the public sim view: two edge tabs that slide panels in.
 *
 *   left tab   -> BRAIN   the cortex feed and the brain scan
 *   right tab  -> STATE   the Behavioral Intent & Internal State panel
 *
 * Opening one closes the other, so the fly is never buried under both. The tabs and
 * the sliding only exist below the phone breakpoint in App.css; on a desktop this
 * renders buttons that CSS keeps hidden, and the panels stay where they always were.
 * State is a class on the `.app` root, so no simulation component re-renders.
 */
import { useEffect, useState } from 'react'

type Side = 'left' | 'right' | null

export function MobileTabs() {
  const [open, setOpen] = useState<Side>(null)

  useEffect(() => {
    const app = document.querySelector('.app')
    if (!app) return
    app.classList.toggle('drawer-left', open === 'left')
    app.classList.toggle('drawer-right', open === 'right')
    return () => app.classList.remove('drawer-left', 'drawer-right')
  }, [open])

  const toggle = (side: Exclude<Side, null>) => setOpen((cur) => (cur === side ? null : side))

  return (
    <>
      <button
        className={`mtab mtab-left${open === 'left' ? ' on' : ''}`}
        aria-expanded={open === 'left'}
        aria-label={open === 'left' ? 'Close brain panel' : 'Open brain panel'}
        onClick={() => toggle('left')}
      >
        <span>{open === 'left' ? '◂ CLOSE' : 'BRAIN ▸'}</span>
      </button>
      <button
        className={`mtab mtab-right${open === 'right' ? ' on' : ''}`}
        aria-expanded={open === 'right'}
        aria-label={open === 'right' ? 'Close state panel' : 'Open state panel'}
        onClick={() => toggle('right')}
      >
        <span>{open === 'right' ? 'CLOSE ▸' : '◂ STATE'}</span>
      </button>
    </>
  )
}
