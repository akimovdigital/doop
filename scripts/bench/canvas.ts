import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, homedir, loadavg, release, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  defaultDuration,
  realReadyTimeout,
  scenarios,
  windowSize,
  type Sample,
  type Scenario,
  type SceneIdentity,
} from '../../tests/perf/protocol'
import { framePresets } from '../../tests/perf/scene'
import {
  median,
  memoryDelta,
  noiseFloor,
  pairRejectionReasons,
  rejectionReasons,
  verdict,
} from '../../tests/perf/judgment'
import { startEngine, type Driver, type Engine } from './engines'
import { loadScene, serve, siteFrom, vmStat } from './site'

const outputRoot = join(homedir(), 'Library/Application Support/Doop Test/bench')
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function options() {
  const { values } = parseArgs({
    options: {
      engine: { type: 'string', default: process.platform === 'darwin' ? 'webkit' : 'chromium' },
      scenario: { type: 'string', default: 'all' },
      frames: { type: 'string', default: '68' },
      pairs: { type: 'string', default: '5' },
      duration: { type: 'string', default: String(defaultDuration) },
      scene: { type: 'string' },
      'diagnose-snapshots': { type: 'boolean' },
      'max-swapouts': { type: 'string', default: '0' },
      'max-swapins': { type: 'string', default: '256' },
      site: { type: 'string' },
      base: { type: 'string' },
      candidate: { type: 'string' },
      out: { type: 'string' },
      noise: { type: 'string' },
      headed: { type: 'boolean' },
      hud: { type: 'boolean' },
      screenshot: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      'bun run bench:canvas [--engine webkit|chromium|both] [--scenario pan|zoom|zoom-wide|drag1|drag10|open|fly-over|all]\n' +
        '  [--frames 20|68|200 | --scene canvas.json] [--pairs N] [--duration ms] [--out dir]\n' +
        '  [--max-swapins pages] [--max-swapouts pages]\n' +
        '  [--site dir | --base worktree-or-site --candidate worktree-or-site] [--noise result.json]\n' +
        '  [--headed] [--hud] [--screenshot path.png] [--diagnose-snapshots]\n' +
        '  fly-over requires a generated scene',
    )
    return null
  }
  const integer = (name: string, value: string, min: number, max: number) => {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
      throw new Error(`--${name} must be an integer from ${min} to ${max}`)
    return parsed
  }
  const engine = values.engine
  if (engine !== 'webkit' && engine !== 'chromium' && engine !== 'both')
    throw new Error('Expected --engine webkit, chromium or both')
  const requestedScenarios = values.scenario.split(',')
  const selectedScenarios = scenarios.filter((item) => requestedScenarios.includes(item))
  if (selectedScenarios.length !== requestedScenarios.length && values.scenario !== 'all')
    throw new Error('Unknown --scenario')
  const frames = framePresets.find((count) => count === Number(values.frames))
  if (!frames) throw new Error('Expected --frames 20, 68 or 200')
  if (!!values.base !== !!values.candidate || (values.base && values.site))
    throw new Error('Provide either --site or both --base and --candidate')
  if (values.scene && selectedScenarios.includes('fly-over'))
    throw new Error('--scenario fly-over currently requires a generated scene')
  if (values.noise && !values.base) throw new Error('--noise requires A/B mode')
  if (values.screenshot && !values.hud) throw new Error('--screenshot requires --hud')
  if (values['diagnose-snapshots'] && (!values.scene || values.scenario !== 'pan' || values.base || values.site))
    throw new Error('--diagnose-snapshots requires a single build with --scene and --scenario pan')
  return {
    engines: (engine === 'both' ? ['webkit', 'chromium'] : [engine]) as Engine[],
    scenarios:
      values.scenario === 'all'
        ? scenarios.filter((scenario) => !values.scene || scenario !== 'fly-over')
        : selectedScenarios,
    frames,
    pairs: integer('pairs', values.pairs, 1, 50),
    duration: integer('duration', values.duration, 400, 30_000),
    scene: values.scene ? resolve(values.scene) : undefined,
    diagnoseSnapshots: !!values['diagnose-snapshots'],
    maxSwapouts: integer('max-swapouts', values['max-swapouts'], 0, Number.MAX_SAFE_INTEGER),
    maxSwapins: integer('max-swapins', values['max-swapins'], 0, Number.MAX_SAFE_INTEGER),
    sourceA: values.base ?? values.site ?? '.',
    sourceB: values.candidate,
    out: resolve(
      values.out ?? join(outputRoot, `${stamp()}-${engine}-${values.scenario}${values.scene ? '-real' : ''}`),
    ),
    headed: !!values.headed,
    hud: !!values.hud,
    screenshot: values.screenshot ? resolve(values.screenshot) : values.hud ? join(outputRoot, 'hud.png') : undefined,
    noise: values.noise,
  }
}

type Options = NonNullable<ReturnType<typeof options>>
type Side = 'A' | 'B'
type Run = {
  side: Side
  sample: Sample | null
  load: { before: number[]; after: number[] }
  swapDelta: ReturnType<typeof memoryDelta> | null
  rejected: boolean
  reasons: string[]
}
type Pair = { pair: number; attempt: number; runs: Run[]; rejected: boolean; reasons: string[] }
type Series = {
  engine: Engine
  version: string
  mode: string
  scenario: Scenario
  kind: 'single' | 'A/A' | 'A/B'
  pairs: Pair[]
  deltas: number[]
  floor: number | null
  verdict: ReturnType<typeof verdict> | null
}
type Build = Awaited<ReturnType<typeof siteFrom>>
type Result = {
  schema: 1
  startedAt: string
  arch: string
  kernel: string
  hostSwap: ReturnType<typeof vmStat>
  window: typeof windowSize
  builds: { A: Build; B?: Build }
  config: Options
  scene?: SceneIdentity
  screenshot: string | null
  series: Series[]
  errors: string[]
}

const number = (value: number | null) => (value === null ? '—' : value.toFixed(2))
const primary = (sample: Sample | null | undefined) => sample?.openMs ?? sample?.frames.p95 ?? null
const accepted = (series: Series) => series.pairs.filter((pair) => !pair.rejected)
const bySide = (pair: Pair, side: Side) => pair.runs.find((run) => run.side === side)?.sample
function pairDeltas(series: Series) {
  return accepted(series).flatMap((pair) => {
    const a = primary(bySide(pair, 'A'))
    const b = primary(bySide(pair, 'B'))
    return a === null || b === null ? [] : [b - a]
  })
}

function summary(result: Result) {
  const rows = [
    '| Движок | Сценарий | Серия | Сторона | Принято | p50, мс | p95, мс | ≥50 мс | Макс., мс | Open, мс | Δ B−A, мс | Порог, мс | Вердикт | Settle max, мс |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ]
  for (const series of result.series) {
    for (const side of series.kind === 'single' ? (['A'] as const) : (['A', 'B'] as const)) {
      const samples = accepted(series).flatMap((pair) => bySide(pair, side) ?? [])
      const column = (pick: (sample: Sample) => number | null) =>
        number(median(samples.flatMap((sample) => pick(sample) ?? [])))
      const total = samples.reduce((sum, sample) => sum + sample.frames.intervals, 0)
      const long = samples.reduce((sum, sample) => sum + sample.frames.longFrames, 0)
      rows.push(
        `| ${series.engine} | ${series.scenario} | ${series.kind} | ${side} | ${samples.length}/${result.config.pairs} | ${column((s) => s.frames.p50)} | ${column((s) => s.frames.p95)} | ${total ? ((100 * long) / total).toFixed(2) + '%' : '—'} | ${column((s) => s.frames.max)} | ${column((s) => s.openMs)} | ${side === 'B' ? number(median(series.deltas)) : '—'} | ${side === 'B' ? number(series.floor) : '—'} | ${side === 'B' ? (series.verdict ?? '—') : '—'} | ${column((s) => s.settle?.maxMs ?? null)} |`,
      )
    }
  }
  return (
    [
      '# Doop Canvas',
      '',
      ...(result.scene ? [`Сцена · ${result.scene.source}`, ''] : []),
      ...rows,
      ...(result.scene
        ? [
            '',
            'Документы (готовые/смонтированные) до → после, дельта swap (чтение/запись в страницах), снимки до жеста и settle по попыткам.',
            ...result.series.flatMap((series) =>
              series.pairs.flatMap((pair) =>
                pair.runs.map(({ side, sample, swapDelta, load }) => {
                  const documents = sample?.live
                  const counts = documents
                    ? `${documents.before.ready}/${documents.before.mounted} → ${documents.after.ready}/${documents.after.mounted}`
                    : '—'
                  const swap = swapDelta ? `${swapDelta.Swapins}/${swapDelta.Swapouts}` : '—'
                  return (
                    `- ${series.engine} / ${series.scenario} / ${series.kind} / ${side} / ${pair.pair}.${pair.attempt} · ` +
                    `${counts} · ${swap}` +
                    (sample?.snapshots ? ` · снимки ${sample.snapshots.ready}` : '') +
                    (sample?.settle ? ` · settle ${number(sample.settle.maxMs)} мс` : '') +
                    (load ? ` · load ${load.before.map(number).join('/')} → ${load.after.map(number).join('/')}` : '')
                  )
                }),
              ),
            ),
          ]
        : []),
      '',
      ...result.series
        .filter((series) => series.kind !== 'single')
        .map(
          (series) =>
            `- ${series.engine} / ${series.scenario} / ${series.kind} · Δ по парам, мс · ${series.deltas.map(number).join(', ') || '—'}`,
        ),
      ...result.errors.map((error) => `- Ошибка · ${error.replaceAll('\n', ' ')}`),
    ].join('\n') + '\n'
  )
}

function errorText(error: unknown) {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
    const exit =
      'signal' in error && error.signal
        ? `signal ${String(error.signal)}`
        : 'code' in error && error.code
          ? `exit ${String(error.code)}`
          : ''
    return [exit, error.stderr.trim()].filter(Boolean).join('\n')
  }
  return String(error)
}

async function collect(
  driver: Driver,
  engine: Engine,
  scenario: Scenario,
  settings: Options,
  a: URL,
  b: URL | undefined,
  kind: Series['kind'],
  scene: SceneIdentity | undefined,
  capture: () => string | undefined,
  checkpoint: () => Promise<void>,
  register: (series: Series) => void,
) {
  const series: Series = {
    engine,
    version: driver.version,
    mode: driver.mode,
    scenario,
    kind,
    pairs: [],
    deltas: [],
    floor: null,
    verdict: null,
  }
  register(series)
  const urls = { A: a, B: b ?? a }
  const attempts = scene && settings.pairs === 1 ? 1 : 3
  for (let index = 0; index < settings.pairs; index++) {
    const sides: Side[] = kind === 'single' ? ['A'] : index % 2 ? ['B', 'A'] : ['A', 'B']
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const runs: Run[] = []
      for (const side of sides) {
        const url = new URL(urls[side])
        url.search = new URLSearchParams({
          scenario,
          frames: String(settings.frames),
          duration: String(settings.duration),
          ...(scene ? { scene: 'real' } : {}),
          ...(settings.diagnoseSnapshots ? { diagnoseSnapshots: '1' } : {}),
          ...(settings.hud ? { perfHud: '1' } : {}),
        }).toString()
        const loadBefore = loadavg()
        const load = () => ({ before: loadBefore, after: loadavg() })
        try {
          const readyTimeout = scene ? realReadyTimeout * (scenario === 'open' ? 1 : 2) : 0
          const timeout = scenario === 'fly-over' ? 150_000 : settings.duration + readyTimeout + 36_000
          const sample = await driver.run(url, timeout, capture())
          const reasons = rejectionReasons(sample, settings.maxSwapins, settings.maxSwapouts)
          if (settings.diagnoseSnapshots) reasons.push('Snapshot diagnostics enabled')
          if (scene && (!('sha256' in sample.scene) || sample.scene.sha256 !== scene.sha256)) {
            reasons.push('Fixture did not load the requested export; both builds must support --scene')
          }
          runs.push({ side, load: load(), sample, swapDelta: memoryDelta(sample), rejected: !!reasons.length, reasons })
        } catch (error) {
          runs.push({ side, load: load(), sample: null, swapDelta: null, rejected: true, reasons: [errorText(error)] })
        }
      }
      const sampleA = runs.find((run) => run.side === 'A')?.sample
      const sampleB = runs.find((run) => run.side === 'B')?.sample
      const cross = sampleA && sampleB ? pairRejectionReasons(sampleA, sampleB) : []
      const reasons = [...runs.flatMap((run) => run.reasons.map((reason) => `${run.side}: ${reason}`)), ...cross]
      const pair = { pair: index + 1, attempt, runs, rejected: !!reasons.length, reasons }
      series.pairs.push(pair)
      series.deltas = pairDeltas(series)
      console.log(
        `${engine} ${scenario} ${kind} ${index + 1}/${settings.pairs} (try ${attempt}) · ` +
          (pair.rejected
            ? reasons.join('; ')
            : runs.map((run) => `${run.side} ${number(primary(run.sample))} ms`).join(' / ')),
      )
      await checkpoint()
      if (!pair.rejected) break
      // A blocked native launch has no measurement window to retry.
      if (runs.every((run) => run.reasons.some((reason) => reason.includes('hiservices-xpcservice')))) return series
    }
  }
  return series
}

async function main() {
  const config = options()
  if (!config) return
  const exportFile = config.scene ? await loadScene(config.scene) : undefined
  const scene = exportFile && { source: exportFile.source, sha256: exportFile.sha256 }
  const hostSwap = vmStat()
  const suppliedNoise = config.noise ? (JSON.parse(await readFile(config.noise, 'utf8')) as Result) : null
  const temporary = await mkdtemp(join(tmpdir(), 'doop-bench-'))
  const servers: Awaited<ReturnType<typeof serve>>[] = []
  try {
    const a = await siteFrom(config.sourceA, join(temporary, 'A'))
    const sameSource = config.sourceB !== undefined && resolve(config.sourceA) === resolve(config.sourceB)
    const b = sameSource ? a : config.sourceB ? await siteFrom(config.sourceB, join(temporary, 'B')) : undefined
    const isAA = !!b && (sameSource || b.dir === a.dir)
    const result: Result = {
      schema: 1,
      startedAt: new Date().toISOString(),
      arch: arch(),
      kernel: release(),
      hostSwap,
      window: windowSize,
      config,
      builds: { A: a, ...(b ? { B: b } : {}) },
      ...(scene ? { scene } : {}),
      screenshot: null,
      series: [],
      errors: [],
    }
    await mkdir(config.out, { recursive: true })
    async function checkpoint() {
      await writeFile(join(config!.out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
      await writeFile(join(config!.out, 'summary.md'), summary(result))
    }
    const serverA = await serve(a.dir, exportFile)
    servers.push(serverA)
    const serverB = b ? await serve(b.dir, exportFile) : undefined
    if (serverB) servers.push(serverB)
    await checkpoint()
    const capture = () => {
      if (result.screenshot || !config.screenshot) return undefined
      // Mark the path only after the driver returns successfully.
      return config.screenshot
    }
    const register = (series: Series) => {
      result.series.push(series)
    }
    for (const engine of config.engines) {
      try {
        const driver = await startEngine(engine, config.headed, join(temporary, 'chrome'), !!scene)
        try {
          const run = driver.run.bind(driver)
          driver.run = async (url, timeout, screenshot) => {
            const sample = await run(url, timeout, screenshot)
            if (screenshot) result.screenshot = screenshot
            return sample
          }
          for (const scenario of config.scenarios) {
            const kind = b ? (isAA ? 'A/A' : 'A/B') : 'single'
            let floor: number | null = null
            if (kind === 'A/B') {
              if (suppliedNoise) {
                const c = suppliedNoise.config
                const noise = suppliedNoise.series.find(
                  (s) =>
                    s.kind === 'A/A' &&
                    s.engine === engine &&
                    s.scenario === scenario &&
                    s.version === driver.version &&
                    s.mode === driver.mode,
                )
                if (
                  suppliedNoise.arch !== result.arch ||
                  suppliedNoise.kernel !== result.kernel ||
                  (scene
                    ? suppliedNoise.scene?.sha256 !== scene.sha256
                    : !!suppliedNoise.scene || c.frames !== config.frames) ||
                  c.duration !== config.duration ||
                  c.hud !== config.hud ||
                  c.maxSwapins !== config.maxSwapins ||
                  (c.maxSwapouts ?? 0) !== config.maxSwapouts ||
                  !noise ||
                  accepted(noise).length < 3
                ) {
                  throw new Error(`No matching A/A calibration for ${engine} ${scenario} in ${config.noise}`)
                }
                floor = noiseFloor(noise.deltas)
              } else {
                const calibration = await collect(
                  driver,
                  engine,
                  scenario,
                  config,
                  serverA.url,
                  serverA.url,
                  'A/A',
                  scene,
                  capture,
                  checkpoint,
                  register,
                )
                calibration.floor = accepted(calibration).length >= 3 ? noiseFloor(calibration.deltas) : null
                floor = calibration.floor
              }
            }
            const series = await collect(
              driver,
              engine,
              scenario,
              config,
              serverA.url,
              serverB?.url,
              kind,
              scene,
              capture,
              checkpoint,
              register,
            )
            series.floor = kind === 'A/A' ? (accepted(series).length >= 3 ? noiseFloor(series.deltas) : null) : floor
            series.verdict = kind === 'A/B' ? verdict(series.deltas, floor, config.pairs) : null
            if (accepted(series).length < config.pairs)
              result.errors.push(
                `${engine} ${scenario} ${kind}: only ${accepted(series).length}/${config.pairs} accepted`,
              )
            if (kind === 'A/B' && series.verdict === 'insufficient data')
              result.errors.push(`${engine} ${scenario}: insufficient data for A/B verdict`)
            await checkpoint()
            if (
              series.pairs.some((pair) =>
                pair.runs.some(
                  (run) => !run.sample && run.reasons.some((reason) => reason.includes('hiservices-xpcservice')),
                ),
              )
            )
              break
          }
        } finally {
          await driver.close()
        }
      } catch (error) {
        result.errors.push(`${engine}: ${errorText(error)}`)
        console.error(result.errors.at(-1))
      }
    }
    await checkpoint()
    console.log(summary(result))
    console.log(config.out)
    if (result.errors.length) process.exitCode = 1
  } finally {
    for (const server of servers) server.close()
    await rm(temporary, { recursive: true, force: true })
  }
  if (scene) {
    // This CLI owns its browser and servers. Once they have closed and the
    // artifacts are written, leftover driver handles must not hold the relay.
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
      ),
    )
    process.exit()
  }
}

await main().catch((error: unknown) => {
  console.error(errorText(error))
  process.exitCode = 1
})
