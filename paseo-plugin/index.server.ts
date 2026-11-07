import { createSuperagentProvider } from './server/provider.mjs'
import { stateDir } from './shared/local-config.ts'

export default function contribute(server) {
  server.registerProvider(createSuperagentProvider({ stateDir }))
  return () => {}
}
