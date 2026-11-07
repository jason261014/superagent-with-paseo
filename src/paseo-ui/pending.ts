/** Private, crash-durable transport intents. Never reads the host database. */
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ConversationInput, conversationRequestId, type ConversationBinding } from '../local/protocol.ts'

export interface PendingInputs {
  put(input: ConversationInput): void
  list(binding: ConversationBinding): ConversationInput[]
  remove(input: ConversationInput): void
}
export function pendingInputs(stateDir: string): PendingInputs {
  const directory = join(stateDir, 'paseo-ui-pending')
  const safe = (path: string, isDirectory: boolean) => {
    const stat = lstatSync(path)
    if ((isDirectory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.() || (stat.mode & (isDirectory ? 0o077 : 0o177)))
      throw new Error('LOCAL_UNSAFE_UI_JOURNAL')
  }
  const root = lstatSync(stateDir)
  if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o022)) throw new Error('LOCAL_UNSAFE_DIRECTORY')
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  safe(directory, true)
  const sync = () => { const fd = openSync(directory, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
  const file = (input: ConversationInput) => join(directory, conversationRequestId(input.binding, input.clientMessageId) + '.json')
  const read = (path: string) => { safe(path, false); return ConversationInput.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  return {
    put(value) {
      const input = ConversationInput.parse(value), path = file(input)
      safe(directory, true)
      const temporary = join(directory, 'pending-' + randomUUID()), fd = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(input)); fsyncSync(fd)
        try { linkSync(temporary, path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          if (JSON.stringify(read(path)) !== JSON.stringify(input)) throw new Error('LOCAL_REQUEST_CONFLICT')
        }
        sync()
      } finally { closeSync(fd); unlinkSync(temporary) }
    },
    list(binding) {
      safe(directory, true)
      const paths = readdirSync(directory)
      if (paths.length > 1000) throw new Error('LOCAL_UI_JOURNAL_LIMIT')
      return paths.filter(name => /^paseo-[a-f0-9]{64}\.json$/.test(name)).map(name => read(join(directory, name))).filter(input => {
        if (input.binding.hostId !== binding.hostId || input.binding.conversationId !== binding.conversationId) throw new Error('LOCAL_CONVERSATION_MISMATCH')
        return true
      })
    },
    remove(input) { try { unlinkSync(file(input)); sync() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } },
  }
}
