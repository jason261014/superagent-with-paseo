/** MCP protocol is handled by the official SDK; all authority and tool execution stay in the host. */
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { privateCall } from '../local/transport.ts'

export async function runMcp(): Promise<void> {
  const socket = process.env.SUPERAGENT_TOOL_SOCKET, token = process.env.SUPERAGENT_TOOL_TOKEN
  if (!socket?.startsWith('/') || !token) throw new Error('Missing Superagent tool binding')
  const instance = randomUUID()
  const server = new Server({ name: 'superagent', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    await privateCall(socket, 'GET', '/tools', undefined, token) as { tools: { name: string; inputSchema: { type: 'object' } }[] })
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const result = await privateCall(socket, 'POST', '/call', { requestId: `${instance}:${extra.requestId}`,
        name: request.params.name, arguments: request.params.arguments ?? {} }, token)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } }
  })
  await server.connect(new StdioServerTransport())
}
