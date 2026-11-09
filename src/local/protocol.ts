/** Shared wire contract for the private Paseo conversation entry. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const Id = z.string().regex(/^[a-f0-9]{32}$/)
export const ConversationBinding = z.object({ version: z.literal(1), hostId: Id, conversationId: Id }).strict()
export type ConversationBinding = z.infer<typeof ConversationBinding>
export const ConversationInput = z.object({ binding: ConversationBinding,
  clientMessageId: z.string().min(1).max(160),
  text: z.string().trim().min(1).refine(text => Buffer.byteLength(text, 'utf8') <= 65_536, 'Request too large'),
}).strict()
export type ConversationInput = z.infer<typeof ConversationInput>
export function conversationRequestId(binding: ConversationBinding, clientMessageId: string): string {
  return 'paseo-' + createHash('sha256').update(JSON.stringify([binding.hostId, binding.conversationId, clientMessageId])).digest('hex')
}
export const conversationTextHash = (text: string): string => createHash('sha256').update(text.trim()).digest('hex')
export interface ConversationReceipt {
  requestId: string; clientMessageId: string; textHash: string; triggerId: string; seq: number; at: string; result: 'stored' | 'duplicate' | 'filtered'
}
export interface ConversationReceiptView extends ConversationReceipt {
  routing: 'pending' | 'routed' | 'ignored' | 'rejected'; reason?: string; ticketId?: string
}
export interface ConversationEvent {
  seq: number; id: string; at: string; type: 'user' | 'assistant' | 'status'; text: string
  clientMessageId?: string; triggerId?: string; ticketId?: string
  level?: 'info' | 'warning' | 'error'; kind?: string
}
export interface ConversationStatus { id: string; at: string; text: string; level: 'info' | 'warning' | 'error'; kind: string; ticketId?: string }
export interface ConversationPage {
  binding: ConversationBinding; items: ConversationEvent[]; nextCursor: number; highWater: number; hasMore: boolean
}
