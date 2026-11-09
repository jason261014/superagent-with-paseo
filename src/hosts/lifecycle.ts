/** Waiting budgets describe the caller's wait, never ownership of live resources. */
export interface HostStatus {
  phase: 'starting' | 'needs_setup' | 'ready' | 'stopping' | 'stopped' | 'error'
  detail?: string
}
export type HostStop = { closed: true } | { closed: false; reason: 'deadline' }
export interface PaseoHost {
  ready: Promise<void>
  status(): HostStatus
  /** Loopback URL of the read-only flow canvas when flowWeb is enabled. */
  flowWeb?(): string | undefined
  stop(budgetMs?: number): Promise<HostStop>
}
export async function waitForHostStop(stopped: Promise<void>, budgetMs: number): Promise<HostStop> {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('Invalid shutdown budget')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      stopped.then(() => ({ closed: true as const })),
      new Promise<HostStop>(resolve => { timer = setTimeout(() => resolve({ closed: false, reason: 'deadline' }), budgetMs) }),
    ])
  } finally { clearTimeout(timer) }
}
