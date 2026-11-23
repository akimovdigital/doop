export function nearestRank(values: readonly number[], percentile: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((percentile * sorted.length) / 100) - 1)] ?? null
}

export function frameIntervals(timestamps: readonly number[]): number[] {
  return timestamps.slice(1).map((time, index) => time - timestamps[index]!)
}

export function intervalStats(timestamps: readonly number[]) {
  const intervals = frameIntervals(timestamps)
  return {
    p50: nearestRank(intervals, 50),
    p95: nearestRank(intervals, 95),
    max: intervals.length ? Math.max(...intervals) : null,
    longFrames: intervals.filter((ms) => ms >= 50).length,
    intervals: intervals.length,
  }
}
