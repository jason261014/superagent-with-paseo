/** Validates the private Host protocol at the provider boundary. */
import { z } from 'zod'
import { localCall } from '../local/transport.ts'
import { ConversationBinding, type ConversationInput, type ConversationReceiptView, type ConversationPage } from '../local/protocol.ts'

const Receipt = z.object({ requestId: z.string(), clientMessageId: z.string(), textHash: z.string(), triggerId: z.string(),
  seq: z.number().int().positive(), at: z.string(), result: z.enum(['stored', 'duplicate', 'filtered']),
  routing: z.enum(['pending', 'routed', 'ignored', 'rejected']), reason: z.string().optional(), ticketId: z.string().optional() }).strict()
const Page = z.object({ binding: ConversationBinding, items: z.array(z.object({ seq: z.number().int().positive(), id: z.string(), at: z.string(),
  type: z.enum(['user', 'assistant', 'status']), text: z.string(), clientMessageId: z.string().optional(), triggerId: z.string().optional(), ticketId: z.string().optional(),
  level: z.enum(['info', 'warning', 'error']).optional(), kind: z.string().optional() }).strict()),
  nextCursor: z.number().int().nonnegative(), highWater: z.number().int().nonnegative(), hasMore: z.boolean() }).strict()
export interface ConversationTransport {
  binding(create: boolean): Promise<ConversationBinding>
  submit(input: ConversationInput): Promise<ConversationReceiptView>
  receipt(requestId: string): Promise<{ binding: ConversationBinding; receipt: ConversationReceiptView | null }>
  events(after: number, through?: number): Promise<ConversationPage>
}
export function conversationTransport(stateDir: string): ConversationTransport {
  return {
    async binding(create) {
      const response = await localCall(stateDir, create ? 'POST' : 'GET', '/paseo/binding')
      const { binding } = z.object({ binding: ConversationBinding.nullable() }).parse(response)
      if (!binding) throw new Error('LOCAL_CONVERSATION_UNBOUND')
      return binding
    },
    async submit(input) { return Receipt.parse(await localCall(stateDir, 'POST', '/paseo/requests', input)) },
    async receipt(requestId) {
      return z.object({ binding: ConversationBinding, receipt: Receipt.nullable() }).parse(await localCall(stateDir, 'GET', '/paseo/requests/' + requestId))
    },
    async events(after, through) {
      return Page.parse(await localCall(stateDir, 'GET', `/paseo/events?after=${after}${through === undefined ? '' : '&through=' + through}`))
    },
  }
}
