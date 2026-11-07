import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The daemon reads this when it loads the local plugin. Override it before
 * starting/reloading the daemon when the DSH profile uses another state path.
 */
export const stateDir = process.env.SUPERAGENT_STATE_DIR?.trim()
  || join(homedir(), '.dsh', 'state', 'sa-paseo-check')
