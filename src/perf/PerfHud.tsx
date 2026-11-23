import { Profiler, useEffect, useRef, useState, type ProfilerOnRenderCallback, type ReactNode } from 'react'
import { liveDocuments } from './documents'
import { intervalStats } from './metrics'
import './PerfHud.css'

export function PerfHud({ children, onRender }: { children: ReactNode; onRender?: ProfilerOnRenderCallback }) {
  const commits = useRef<number[]>([])
  return (
    <>
      <Profiler
        id="root"
        onRender={(...args) => {
          commits.current.push(args[5])
          onRender?.(...args)
        }}
      >
        {children}
      </Profiler>
      <Readout commits={commits} />
    </>
  )
}

function Readout({ commits }: { commits: { current: number[] } }) {
  const [stats, setStats] = useState({ fps: 0, p95: 0, max: 0, longFrames: 0, mounted: 0, ready: 0, commits: 0 })
  useEffect(() => {
    let handle = 0
    let refreshAt = 0
    const times: number[] = []
    function tick(time: number) {
      times.push(time)
      if (time >= refreshAt) {
        while (times.length > 1 && times[1]! < time - 2000) times.shift()
        while (commits.current.length && commits.current[0]! < time - 1000) commits.current.shift()
        const recent = times.filter((stamp) => stamp >= time - 1000)
        const span = time - (recent[0] ?? time)
        const frames = intervalStats(times)
        setStats({
          fps: span ? Math.round(((recent.length - 1) * 1000) / span) : 0,
          p95: frames.p95 ?? 0,
          max: frames.max ?? 0,
          longFrames: frames.longFrames,
          ...liveDocuments(),
          commits: commits.current.length,
        })
        refreshAt = time + 250
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [commits])

  return (
    <aside aria-label="Performance" className="doop-perf-hud">
      <span>{stats.fps} FPS</span>
      <span>{stats.commits} commits/s</span>
      <span>p95 {stats.p95.toFixed(1)} ms</span>
      <span>max {stats.max.toFixed(1)} ms</span>
      <span>≥50 ms {stats.longFrames}</span>
      <span>
        iframes {stats.mounted}/{stats.ready}
      </span>
    </aside>
  )
}
