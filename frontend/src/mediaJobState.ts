export type KeyedJob = { key: string; startedAt: string }

export function upsertJob<T extends KeyedJob>(jobs: T[], update: T, limit = 20) {
  return [update, ...jobs.filter(job => job.key !== update.key)]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit)
}

export function progressPercent(progress: number | null) {
  return Math.round(Math.min(1, Math.max(0, progress ?? 0)) * 100)
}
