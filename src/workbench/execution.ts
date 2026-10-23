import { z } from 'zod';

/** Observed execution facts only; never inferred from model replies or log text. */
export const executionRunSchema = z.object({
  attempt: z.number().int().min(1).max(3), startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
  changes: z.enum(['in_progress', 'applied', 'rolled_back', 'rollback_failed', 'not_applied', 'unknown']),
  verification: z.enum(['not_run', 'running', 'passed', 'skipped', 'failed', 'setup_failed', 'unknown']),
  requested: z.array(z.string().max(80)).max(4), passed: z.array(z.string().max(80)).max(4),
  detail: z.string().max(6000).optional(),
});
export type ExecutionRun = z.infer<typeof executionRunSchema>;
