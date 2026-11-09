import type { PaseoAdapter } from '../../src/paseo/client.ts'

/** A complete in-memory adapter for host tests that must not contact the daily Paseo daemon. */
export function fakePaseoAdapter(): PaseoAdapter {
  return {
    create: async input => ({ agentId: 'agent-orchestrator', cwd: input.cwd }),
    send: async () => {},
    findByLabels: async () => ({ kind: 'complete', matches: [] }),
    findMessage: async () => ({ kind: 'absent_confirmed', epoch: 'test' }),
    timeline: async () => ({ kind: 'complete', epoch: 'test', entries: [] }),
    snapshot: async agentId => ({ agentId, cwd: null, status: 'idle', activeTurn: null, pendingPermissions: [],
      observedAt: new Date().toISOString(), unknownChildren: true }),
    interrupt: async () => ({ requestSent: true, runtime: null }),
    archive: async () => ({ archivedAt: new Date().toISOString() }),
    close: async () => {},
  }
}
