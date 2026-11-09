import { parseArgs } from 'node:util'
import { isAbsolute } from 'node:path'
import { localCall } from '../local/transport.ts'
import { ProjectIdSchema } from './config.ts'

const usage = 'Usage: superagent-project --manager-dir /absolute/manager list | status PROJECT_ID | start PROJECT_ID | stop PROJECT_ID | restart PROJECT_ID'
export async function main(args = process.argv.slice(2), write = (text: string) => { process.stdout.write(text + '\n') }): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'manager-dir': { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) { write(usage); return }
  const directory = values['manager-dir'], command = positionals[0], id = positionals[1]
  if (!directory || !isAbsolute(directory) || !command) throw new Error(usage)
  let method: 'GET' | 'POST', path: string
  if (command === 'list' && positionals.length === 1) { method = 'GET'; path = '/projects' }
  else if (id && ProjectIdSchema.safeParse(id).success && positionals.length === 2 && ['status', 'start', 'stop', 'restart'].includes(command)) {
    method = command === 'status' ? 'GET' : 'POST'
    path = '/projects/' + id + (method === 'POST' ? '/' + command : '')
  } else throw new Error(usage)
  try { write(JSON.stringify(await localCall(directory, method, path, method === 'POST' ? {} : undefined), null, 2)) }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new Error('请检查 Paseo daemon 与 Superagent 插件是否运行')
    throw error
  }
}
