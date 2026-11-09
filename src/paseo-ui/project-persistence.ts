import { z } from 'zod'
import { ConversationBinding } from '../local/protocol.ts'
import { ProjectIdSchema } from '../projects/config.ts'

export const ProjectPersistenceSchema = z.strictObject({
  version: z.literal(2),
  data: z.strictObject({ projectId: ProjectIdSchema, binding: ConversationBinding }),
})
