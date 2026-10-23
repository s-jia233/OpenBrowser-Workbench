import { z } from 'zod';

// Strict metadata only: never accept prompt, reply, URL, selector or source text.
export const browserReceptionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/).max(24),
  elapsedMs: z.number().int().min(0).max(3_600_000),
  stream: z.enum(['pending', 'done', 'error']),
  streamChars: z.number().int().min(0).max(10_000_000),
  pageChars: z.number().int().min(0).max(10_000_000),
  users: z.number().int().min(0).max(100_000),
  currentUsers: z.number().int().min(0).max(100_000),
  assistants: z.number().int().min(0).max(100_000),
  matchedBy: z.enum(['none', 'user', 'stream_id']),
  reason: z.enum(['awaiting_turn', 'ambiguous_turn', 'awaiting_answer', 'analysis', 'mixed_analysis', 'invalid_json', 'structure_unknown', 'generating', 'awaiting_completion', 'settling', 'returning']),
  busy: z.boolean(),
  finished: z.boolean(),
}).strict();

export type BrowserReception = z.infer<typeof browserReceptionSchema>;
