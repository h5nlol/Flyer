import { AnimatePresence, animate, motion, useInView, useScroll, useTransform } from 'framer-motion'
import Lenis from 'lenis'
import 'lenis/dist/lenis.css'
import { useEffect, useRef, useState } from 'react'

const VIDEO_SRC = 'https://i.imgur.com/dxXdbE1.mp4'
const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]
const NEON = 'hover:bg-[#E6FF00] hover:text-black hover:border-[#E6FF00]'

// ---------------------------------------------------------------- text effects

/** Characters rise out of a mask, staggered. Plays on `play`, or on scroll into view. */
function SplitText({ text, play, delay = 0, stagger = 0.022 }: { text: string; play?: boolean; delay?: number; stagger?: number }) {
  let n = 0
  const state = play === undefined ? {} : { animate: play ? 'show' : 'hidden' }
  return (
    <motion.span
      aria-label={text}
      initial="hidden"
      {...state}
      {...(play === undefined && { whileInView: 'show', viewport: { once: true, margin: '0px 0px -10% 0px' } })}
    >
      {text.split(' ').map((word, w) => (
        <span key={w} aria-hidden className="inline-block overflow-hidden whitespace-nowrap pb-[0.06em] align-bottom">
          {[...word].map((ch) => {
            const i = n++
            return (
              <motion.span
                key={i}
                className="inline-block will-change-transform"
                variants={{
                  hidden: { y: '115%', rotate: 6 },
                  show: { y: '0%', rotate: 0, transition: { duration: 0.9, ease: EASE, delay: delay + i * stagger } },
                }}
              >
                {ch}
              </motion.span>
            )
          })}
          {'\u00A0'}
        </span>
      ))}
    </motion.span>
  )
}

const GLYPHS = '!<>-_\\/[]{}=+*^?#01'

/** Monospace decode: scrambled glyphs resolve left to right. */
function Decode({ text, play, delay = 0 }: { text: string; play?: boolean; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useInView(ref, { once: true })
  const go = play ?? seen
  useEffect(() => {
    const el = ref.current
    if (!el || !go) return
    const t0 = performance.now() + delay * 1000
    const dur = Math.min(1400, 28 * text.length + 350)
    let raf = 0
    const tick = (now: number) => {
      const p = (now - t0) / dur
      if (p >= 1) {
        el.textContent = text
        return
      }
      const k = Math.max(0, Math.floor(p * text.length))
      el.textContent =
        text.slice(0, k) +
        [...text.slice(k)].map((c) => (c === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('')
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [go, text, delay])
  return (
    <span ref={ref} aria-label={text} className={play === false ? 'opacity-0' : ''}>
      {text}
    </span>
  )
}

/** Blur-and-rise for paragraphs. */
function Rise({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 28, filter: 'blur(10px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once: true, margin: '0px 0px -10% 0px' }}
      transition={{ duration: 1.1, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  )
}

/** Counts up to a measured value once scrolled into view. */
function Count({ to, decimals = 0, suffix = '' }: { to: number; decimals?: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useInView(ref, { once: true, margin: '0px 0px -10% 0px' })
  const fmt = (v: number) =>
    v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix
  useEffect(() => {
    if (!seen) return
    const c = animate(0, to, {
      duration: 1.8,
      ease: EASE,
      onUpdate: (v) => { if (ref.current) ref.current.textContent = fmt(v) },
    })
    return () => c.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, to])
  return <span ref={ref}>{fmt(0)}</span>
}

// ---------------------------------------------------------------- building blocks

function Button({ href, children, huge = false }: { href: string; children: React.ReactNode; huge?: boolean }) {
  return (
    <a
      href={href}
      className={`inline-block rounded-none border-2 border-white bg-black font-mono uppercase text-white
        transition-colors duration-75 hover:bg-white hover:text-black
        ${huge ? 'px-8 py-6 text-xl md:px-14 md:py-8 md:text-3xl' : 'px-6 py-4 text-base md:text-lg'}`}
    >
      {children}
    </a>
  )
}

function Loader({ video, onDone }: { video: React.RefObject<HTMLVideoElement | null>; onDone: (ready: boolean) => void }) {
  const num = useRef<HTMLSpanElement>(null)
  const bar = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t0 = performance.now()
    let shown = 0
    let raf = 0
    // Real buffer progress. ponytail: after 12 s (or a failed load) the page opens
    // anyway and the video keeps buffering behind it, so a slow link never strands a visitor.
    const goal = () => {
      const v = video.current
      if (!v) return 0
      if (v.readyState >= 4 || v.error || performance.now() - t0 > 12000) return 100
      if (!v.duration || !v.buffered.length) return 0
      return Math.min(99, (v.buffered.end(v.buffered.length - 1) / v.duration) * 100)
    }
    let last = t0
    const tick = (now: number) => {
      const g = goal()
      // time-based easing, so a throttled or slow display still finishes on schedule
      shown += (g - shown) * (1 - Math.exp(-(now - last) / 250))
      last = now
      if (g === 100 && shown > 99.5) shown = 100
      if (num.current) num.current.textContent = String(Math.floor(shown)).padStart(3, '0')
      if (bar.current) bar.current.style.transform = `scaleX(${shown / 100})`
      if (shown === 100 && performance.now() - t0 > 1500) return onDone(true)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [video, onDone])

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex flex-col justify-between bg-black p-4 font-mono text-xs uppercase text-white md:p-8 md:text-sm"
      exit={{ clipPath: 'inset(0 0 100% 0)' }}
      initial={{ clipPath: 'inset(0 0 0% 0)' }}
      transition={{ duration: 1, ease: EASE }}
    >
      <div className="flex justify-between border-b border-white pb-3">
        <Decode text="FLYER // WETWARE V.1" play />
        <Decode text="BUFFERING CORTICAL FEED" play delay={0.2} />
      </div>
      <div className="space-y-1 text-white/60">
        <div><Decode text="FLYWIRE FAFB V783" play delay={0.3} /></div>
        <div><Decode text="139,255 NEURONS // 17,550 SENSORY CELLS" play delay={0.45} /></div>
        <div><Decode text="LIF ENGINE // DT 0.1 MS" play delay={0.6} /></div>
      </div>
      <div>
        <div className="flex items-end justify-between">
          <span ref={num} className="font-sans text-[30vw] font-black leading-[0.8] tracking-normal md:text-[18vw]">000</span>
          <span className="pb-2">%</span>
        </div>
        <div className="mt-4 h-2 border border-white">
          <div ref={bar} className="h-full origin-left bg-[#E6FF00]" style={{ transform: 'scaleX(0)' }} />
        </div>
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------- content

const STATS = [
  { to: 139255, label: 'Neurons simulated' },
  { to: 17550, label: 'Sensory cells' },
  { to: 0.1, decimals: 1, suffix: ' ms', label: 'Integration step' },
  { to: 120, decimals: 0, suffix: ' ms', label: 'Sensory Latency' },
]

const ORGANISM = [
  {
    title: '01. THE FLY (INSTINCT)',
    body:
      'We simulate all 139,255 neurons of the FlyWire fruit fly connectome. This handles the base biological instincts. It processes looming threats, sniffs out food, and drives the legs to walk around the enclosure.',
  },
  {
    title: '02. THE HUMAN (EXECUTIVE CONTROL)',
    body:
      "The fly's sensory inputs stream directly into a biological array of real human brain cells hosted on the FinalSpark Neuroplatform. This remote human tissue controls the grafted humanoid features and continuously monitors the organism's physical state.",
  },
  {
    title: '03. ONE MIND (THE OVERRIDE)',
    body:
      "They act as a single brain sharing one body. Usually, the fly is on autopilot. But if the human cells detect a severe threat, they can trigger an 'executive override', hijacking the fly's legs to force a full-body escape.",
  },
]

// Upcoming daily experiments. None of these environments exist yet.
const TRIALS = [
  {
    tag: 'PIPELINE // 01',
    title: 'BIOLOGICAL CAPTCHA BYPASS',
    status: 'UPCOMING',
    body: "Mapping the organism's erratic, organic motor outputs to cursor movements to test if living human wetware can bypass advanced bot-detection algorithms.",
  },
  {
    tag: 'PIPELINE // 02',
    title: 'NETWORK OLFACTION',
    status: 'UPCOMING',
    body: "Converting live server traffic into spatial chemical gradients. Testing if the connectome can 'smell' a DDoS attack before it crashes the server.",
  },
  {
    tag: 'PIPELINE // 03',
    title: 'UNCANNY VALLEY AVERSION',
    status: 'UPCOMING',
    body: "Training the human brain cells to identify AI-generated deepfakes. Testing if a biological 'uncanny valley' cringe can trigger the fly's physical escape reflex faster than conventional algorithmic detectors.",
  },
]

/** Live countdown to the next midnight UTC, so every visitor sees the same time. Writes the DOM once a second. */
function Countdown() {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
      const s = Math.max(0, Math.floor((next - now.getTime()) / 1000))
      const pad = (n: number) => String(n).padStart(2, '0')
      if (ref.current) ref.current.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return <span ref={ref}>--:--:--</span>
}

function TrialCard({ t, i }: { t: (typeof TRIALS)[number]; i: number }) {
  return (
    <article className="group flex flex-col bg-black transition-colors duration-150 hover:bg-white hover:text-black">
      <div className="flex items-center justify-between border-b border-white px-4 py-3 font-mono text-xs md:px-6">
        <span>[ <Decode text={t.tag} delay={i * 0.1} /> ]</span>
      </div>
      <div className="flex flex-1 flex-col gap-8 px-4 py-8 md:px-6 md:py-10">
        <h3 className="text-4xl font-black uppercase leading-[0.9] tracking-normal md:text-[clamp(1.5rem,2.8vw,3rem)]">
          <SplitText text={t.title} delay={i * 0.1} />
        </h3>
        <Rise className="mt-auto" delay={0.2 + i * 0.1}>
          <p className="font-mono text-sm leading-relaxed opacity-80">{t.body}</p>
        </Rise>
      </div>
      <div className="flex items-center gap-3 border-t border-white px-4 py-3 font-mono text-xs uppercase md:px-6 group-hover:border-black">
        <span className="h-2 w-2 animate-pulse bg-[#E6FF00] group-hover:bg-black" />
        <Decode text={`STATUS: ${t.status}`} delay={0.3 + i * 0.1} />
      </div>
    </article>
  )
}

// ---------------------------------------------------------------- page

export default function Landing() {
  const [ready, setReady] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const hero = useRef<HTMLElement>(null)
  const lenis = useRef<Lenis | null>(null)

  const { scrollYProgress } = useScroll({ target: hero, offset: ['start start', 'end start'] })
  const textY = useTransform(scrollYProgress, [0, 1], ['0%', '35%'])
  const textFade = useTransform(scrollYProgress, [0, 0.7], [1, 0])
  const videoScale = useTransform(scrollYProgress, [0, 1], [1, 1.15])

  useEffect(() => {
    const l = new Lenis({ autoRaf: true, anchors: true })
    l.stop()
    lenis.current = l
    return () => l.destroy()
  }, [])

  useEffect(() => {
    if (!ready) return
    lenis.current?.start()
    const v = video.current
    if (v) {
      v.currentTime = 0
      v.play().catch(() => {})
    }
  }, [ready])

  return (
    <main className="tw min-h-screen bg-black font-sans text-white antialiased selection:bg-[#E6FF00] selection:text-black">
      <AnimatePresence>{!ready && <Loader video={video} onDone={setReady} />}</AnimatePresence>

      {/* A. HEADER */}
      <motion.header
        className="sticky top-0 z-50 flex flex-col border-b border-white bg-black font-mono text-xs uppercase md:flex-row md:items-stretch md:justify-between md:text-sm"
        initial={{ y: '-100%' }}
        animate={{ y: ready ? '0%' : '-100%' }}
        transition={{ duration: 0.9, ease: EASE, delay: 0.5 }}
      >
        <div className="flex items-center border-b border-white px-4 py-3 md:border-b-0 md:border-r md:px-6">
          <Decode text="FLYER // WETWARE V.1" play={ready} delay={0.8} />
        </div>
        <nav className="flex divide-x divide-white whitespace-nowrap text-[11px] md:text-sm [&>a]:px-2 md:[&>a]:px-6">
          <a href="/docs" className="flex flex-1 items-center justify-center py-3 hover:bg-white hover:text-black md:flex-none">[ DOCS ]</a>
          <a href="#docs" className="flex flex-1 items-center justify-center py-3 hover:bg-white hover:text-black md:flex-none">[ SOURCE ]</a>
          <a href="/sim" className={`flex flex-1 items-center justify-center bg-white py-3 font-bold text-black md:flex-none ${NEON}`}>
            [ INITIALIZE LINK ]
          </a>
        </nav>
      </motion.header>

      {/* B. HERO */}
      <section ref={hero} className="relative flex min-h-[calc(100svh-49px)] flex-col justify-end overflow-hidden border-b border-white">
        <motion.video
          ref={video}
          src={VIDEO_SRC}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover opacity-60"
          style={{ scale: videoScale }}
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black" />

        <motion.div className="relative z-10 w-full" style={{ y: textY, opacity: textFade }}>
          <div className="flex justify-between px-4 pb-4 font-mono text-[10px] uppercase text-white/70 md:px-8 md:text-xs">
            <Decode text="LIVE FEED // CAM_01" play={ready} delay={1.2} />
            <Decode text="CONNECTOME + CORTEX" play={ready} delay={1.35} />
          </div>
          <h1 className="border-t border-white px-4 pt-6 pb-4 text-[15vw] font-black uppercase leading-[0.82] tracking-normal md:px-8 md:text-[11vw]">
            <SplitText text="FLYER: HYBRID" play={ready} delay={0.7} />
            <br />
            <SplitText text="WETWARE" play={ready} delay={1.0} />
          </h1>
          <div className="grid grid-cols-1 border-t border-white md:grid-cols-[1fr_auto]">
            <motion.p
              className="border-b border-white px-4 py-5 font-mono text-sm md:border-r md:border-b-0 md:px-8 md:text-base"
              initial={{ opacity: 0, y: 20, filter: 'blur(8px)' }}
              animate={ready ? { opacity: 1, y: 0, filter: 'blur(0px)' } : {}}
              transition={{ duration: 1.1, ease: EASE, delay: 1.5 }}
            >
              A living 3D organism driven by a simulated fruit fly connectome, fused directly with a real human brain.
            </motion.p>
            <motion.div
              className="flex items-center justify-center p-4 md:p-6"
              initial={{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }}
              animate={ready ? { opacity: 1, clipPath: 'inset(0 0% 0 0)' } : {}}
              transition={{ duration: 1, ease: EASE, delay: 1.7 }}
            >
              <Button href="/sim" huge>[ ENTER SIMULATION ]</Button>
            </motion.div>
          </div>
        </motion.div>
      </section>

      {/* STATS */}
      <section className="grid grid-cols-2 gap-px border-b border-white bg-white md:grid-cols-4">
        {STATS.map((s, i) => (
          <div key={s.label} className="bg-black px-4 py-6 md:px-6 md:py-8">
            <div className="text-4xl font-black leading-none tracking-normal md:text-6xl">
              <Count to={s.to} decimals={s.decimals} suffix={s.suffix} />
            </div>
            <div className="mt-3 font-mono text-[10px] uppercase text-white/60 md:text-xs">
              <Decode text={s.label} delay={i * 0.1} />
            </div>
          </div>
        ))}
      </section>

      {/* C. THE ORGANISM */}
      <section className="border-b border-white">
        <div className="border-b border-white px-4 py-3 font-mono text-xs uppercase md:px-6"><Decode text="// THE ORGANISM" /></div>
        <div className="grid grid-cols-1 gap-px bg-white md:grid-cols-3">
          {ORGANISM.map((c, i) => (
            <article key={c.title} className="flex flex-col gap-6 bg-black p-6 md:p-8">
              <h2 className="text-2xl font-black uppercase leading-none tracking-normal md:text-3xl">
                <SplitText text={c.title} delay={i * 0.12} />
              </h2>
              <Rise delay={0.2 + i * 0.12}>
                <p className="font-mono text-sm leading-relaxed text-white/80">{c.body}</p>
              </Rise>
            </article>
          ))}
        </div>
      </section>

      {/* D. DAILY EXPERIMENTS */}
      <section className="border-b border-white">
        <div className="flex flex-col gap-3 border-b border-white px-4 py-8 md:flex-row md:items-end md:justify-between md:px-6">
          <h2 className="text-4xl font-black uppercase leading-none tracking-normal md:text-7xl">
            <SplitText text="PHASE IV: INTERNAL LAB ROADMAP" stagger={0.018} />
          </h2>
          <div className="shrink-0 whitespace-nowrap font-mono text-xs uppercase text-white/60"><Decode text="// PLANNED PIPELINE" /></div>
        </div>
        {/* ACTIVE EXPERIMENT */}
        <div className="border-b border-white bg-[#E6FF00] text-black">
          <div className="flex items-center justify-between border-b border-black px-4 py-3 font-mono text-xs font-bold uppercase md:px-6">
            <span className="flex items-center gap-2">
              <motion.span
                className="h-2.5 w-2.5 bg-[#FF1A1A]"
                animate={{ opacity: [1, 1, 0, 0] }}
                transition={{ duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1], ease: 'linear' }}
              />
              <Decode text="ACTIVE EXPERIMENT" />
            </span>
            <Decode text="DAY 01" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr]">
            <div className="flex flex-col gap-6 border-b border-black p-4 md:p-8 lg:border-r lg:border-b-0">
              <h3 className="text-[8vw] font-black uppercase leading-[0.9] tracking-normal md:text-6xl">
                <SplitText text="[ DAY 01: BASELINE CALIBRATION ]" stagger={0.016} />
              </h3>
              <Rise delay={0.2}>
                <p className="max-w-2xl font-mono text-sm leading-relaxed">
                  The organism is currently exploring a sterile digital enclosure to calibrate its spatial awareness and motor
                  functions. The live feed translates raw neural spikes into plain English (e.g., &lsquo;Smelling Target&rsquo;,
                  &lsquo;Flinching&rsquo;, &lsquo;Cortex Override&rsquo;) so observers can understand the biological state in
                  real-time.
                </p>
              </Rise>
            </div>
            <div className="flex flex-col justify-between gap-6 p-4 md:p-8">
              <div className="font-mono text-xs font-bold uppercase">Next environment deployment:</div>
              <motion.div
                id="countdown"
                className="font-mono text-[clamp(3rem,6vw,6rem)] font-bold leading-none tabular-nums tracking-normal"
                animate={{ opacity: [1, 1, 0.25, 1] }}
                transition={{ duration: 1, repeat: Infinity, times: [0, 0.6, 0.8, 1] }}
              >
                <Countdown />
              </motion.div>
              <a
                href="/sim"
                className="block rounded-none border-2 border-black bg-black px-6 py-5 text-center font-mono text-lg uppercase text-[#E6FF00] transition-colors duration-75 hover:bg-transparent hover:text-black md:text-xl"
              >
                [ WATCH LIVE FEED ]
              </a>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-px bg-white md:grid-cols-3">
          {TRIALS.map((t, i) => <TrialCard key={t.tag} t={t} i={i} />)}
        </div>
        <div className="border-t border-white p-4 md:p-6">
          <div className="grid grid-cols-1 border border-white md:grid-cols-[auto_1fr]">
            <div className="flex items-start border-b border-white px-4 py-4 font-mono text-xs uppercase md:border-r md:border-b-0 md:px-6 md:py-8">
              <span>[ <Decode text="X / TWITTER EXPERIMENT" /> ]</span>
            </div>
            <div className="flex flex-col gap-5 px-4 py-6 md:px-8 md:py-8">
              <h3 className="text-[7vw] font-black uppercase leading-none tracking-normal md:text-6xl">
                <SplitText text="OPEN SOURCE OVERRIDE" stagger={0.016} />
              </h3>
              <Rise delay={0.2}>
                <p className="max-w-3xl font-mono text-sm leading-relaxed text-white/80">
                  The above pipeline represents our planned clinical trials, but we are handing the keys to the internet. If a community vote on X (Twitter) gets enough traction, your environments will override our roadmap. The winning scenario gets built in 3D, the organism is dropped inside, and the results are posted daily.
                </p>
              </Rise>
            </div>
          </div>
        </div>
      </section>

      {/* E. FOOTER / DOCS */}
      <footer id="docs" className="grid grid-cols-1 gap-px bg-white md:grid-cols-2">
        <div className="flex flex-col gap-6 bg-black p-6 md:p-10">
          <h2 className="text-4xl font-black uppercase leading-none tracking-normal md:text-6xl">
            <SplitText text="HARDWARE & PROTOCOLS" />
          </h2>
          <Rise delay={0.2}>
            <p className="max-w-xl font-mono text-sm leading-relaxed text-white/80">
              For engineers and researchers: dive into the technical specs of the LIF neural engine, the cortical API gateway,
              and the WebAudio spike synthesizer.
            </p>
          </Rise>
        </div>
        <div className="flex flex-col items-stretch justify-center gap-4 bg-black p-6 sm:flex-row sm:items-center md:p-10">
          <Button href="/docs">[ READ THE DOCS ]</Button>
          <Button href="https://github.com/h5nlol/Flyer">[ VIEW REPOSITORY ]</Button>
        </div>
      </footer>
      <div className="border-t border-white px-4 py-3 font-mono text-[10px] uppercase md:px-6">
        CONNECTOME DATA: FLYWIRE FAFB V783 // CC BY-NC 4.0
      </div>
    </main>
  )
}