import { listenPrivate } from '../local/transport.ts'
import type { ProjectManager } from './manager.ts'
import type { ProjectAction } from './protocol.ts'

export function listenProjectManagement(manager: ProjectManager, managerDir: string): Promise<{ close(): Promise<void> }> {
  return listenPrivate(managerDir, 'local-ipc', async (request, response) => {
    const reply = (code: number, value: unknown) => {
      response.writeHead(code, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify(value))
    }
    try {
      if (request.method === 'GET' && request.url === '/projects') { reply(200, { projects: manager.list() }); return }
      const match = /^\/projects\/([a-z][a-z0-9-]{0,63})(?:\/(start|stop|restart))?$/.exec(request.url ?? '')
      if (!match) { reply(404, { error: 'PROJECT_ROUTE_NOT_FOUND' }); return }
      if (request.method === 'GET' && !match[2]) { reply(200, manager.status(match[1]!)); return }
      if (request.method !== 'POST' || !match[2]) { reply(404, { error: 'PROJECT_ROUTE_NOT_FOUND' }); return }
      let size = 0
      const buffers: Buffer[] = []
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk); size += buffer.length
        if (size > 1024) { reply(413, { error: 'PROJECT_REQUEST_TOO_LARGE' }); return }
        buffers.push(buffer)
      }
      const value = JSON.parse(Buffer.concat(buffers).toString('utf8'))
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length) throw new Error('PROJECT_INVALID_REQUEST')
      reply(200, await manager.act(match[1]!, match[2] as ProjectAction))
    } catch (error) {
      const message = error instanceof Error && /^PROJECT_[A-Z_]+$/.test(error.message) ? error.message : 'PROJECT_INVALID_REQUEST'
      reply(message === 'PROJECT_NOT_REGISTERED' ? 404 : 409, { error: message })
    }
  })
}
