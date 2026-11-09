/** Thin CLI for the existing Runtime's local Source; no separate host, database or scheduler. */
import { parseArgs } from 'node:util'
import { isAbsolute } from 'node:path'
import { localCall } from './transport.ts'

const usage = `Usage:
  superagent-local --state-dir /absolute/state status
  superagent-local --state-dir /absolute/state submit --request-id ID [--thread-id ID] --text TEXT
  superagent-local --state-dir /absolute/state replies --thread-id ID

Use the same request ID and text to retry an uncertain submission. A new request ID
with the same thread ID is a follow-up. Replies are a snapshot; this CLI does not watch
or start a host. Omitting thread-id on submit uses request-id as the thread ID.`

export async function main(args = process.argv.slice(2), write = (text: string) => { process.stdout.write(text + '\n') }): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'state-dir': { type: 'string' }, 'request-id': { type: 'string' }, 'thread-id': { type: 'string' },
    text: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) { write(usage); return }
  const state = values['state-dir'], command = positionals[0]
  if (!state || !isAbsolute(state) || positionals.length !== 1) throw new Error(usage)
  let result: unknown
  if (command === 'status' && !values['request-id'] && !values['thread-id'] && values.text === undefined) {
    result = await localCall(state, 'GET', '/status')
  } else if (command === 'replies' && values['thread-id'] && !values['request-id'] && values.text === undefined) {
    result = await localCall(state, 'GET', `/threads/${encodeURIComponent(values['thread-id'])}`)
  } else if (command === 'submit' && values['request-id'] && values.text) {
    const requestId = values['request-id'], threadId = values['thread-id'] ?? requestId
    const response = await localCall(state, 'POST', '/requests', { requestId, threadId, text: values.text })
    result = { requestId, threadId, ...response as object }
  } else throw new Error(usage)
  write(JSON.stringify(result, null, 2))
}
