import { z } from 'zod';

const operationActions = [
  'CREATE_FILE',
  'EDIT_FILE',
  'DELETE_FILE',
  'RENAME_FILE',
  'CREATE_FOLDER',
  'RUN_COMMAND',
] as const;

const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .transform((value) => value.replace(/\\/g, '/').replace(/^\.\//, ''))
  .refine((value) => !value.startsWith('/'), 'Path must be relative')
  .refine((value) => !/^[a-zA-Z]:\//.test(value), 'Path must not be absolute')
  .refine(
    (value) => !value.split('/').includes('..'),
    'Path must not escape the project root',
  );

export const operationSchema = z.object({
  action: z.enum(operationActions),
  path: relativePathSchema.optional(),
  content: z.string().optional(),
  search: z.string().optional(),
  replace: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  command: z.string().optional(),
}).superRefine((operation, ctx) => {
  if (operation.action === 'RUN_COMMAND') {
    if (!operation.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RUN_COMMAND requires command',
        path: ['command'],
      });
    }
    return;
  }

  if (!operation.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'path is required for file operations',
      path: ['path'],
    });
    return;
  }

  if (
    (operation.action === 'CREATE_FILE' || operation.action === 'EDIT_FILE') &&
    operation.content === undefined
  ) {
    // Hybrid mode: content may arrive in markdown code blocks.
    return;
  }

  if (operation.action === 'RENAME_FILE') {
    const destination = operation.replace;
    if (!destination) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RENAME_FILE requires replace as the destination path',
        path: ['replace'],
      });
      return;
    }

    const normalized = destination.replace(/\\/g, '/').replace(/^\.\//, '');
    if (
      normalized.startsWith('/') ||
      /^[a-zA-Z]:\//.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RENAME_FILE destination must stay inside the project root',
        path: ['replace'],
      });
    }
  }
});

export const fileToolRequestSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('list_files'), path: relativePathSchema.default('.'), depth: z.number().int().min(1).max(4).default(2) }).strict(),
  z.object({ tool: z.literal('search'), path: relativePathSchema.default('.'), query: z.string().min(1).max(200).refine((value) => !!value.trim(), 'Search text cannot be blank'), caseSensitive: z.boolean().default(false) }).strict(),
  z.object({ tool: z.literal('read_file'), path: relativePathSchema, startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict(),
]).superRefine((request, ctx) => {
  if (request.tool === 'read_file' && ((request.startLine === undefined) !== (request.endLine === undefined) ||
    (request.startLine !== undefined && request.endLine !== undefined && (request.endLine < request.startLine || request.endLine - request.startLine >= 200)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Read both startLine/endLine, at most 200 lines; omit both for full text.' });
  }
});
export type FileToolRequest = z.infer<typeof fileToolRequestSchema>;

export const aiResponseSchema = z
  .object({
    operations: z.array(operationSchema).optional(),
    toolRequests: z.array(fileToolRequestSchema).min(1).max(4).optional(),
    contextRequests: z.array(z.object({
      path: relativePathSchema,
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    }).superRefine((request, ctx) => {
      if ((request.startLine === undefined) !== (request.endLine === undefined) ||
        (request.startLine !== undefined && request.endLine !== undefined && (request.endLine < request.startLine || request.endLine - request.startLine >= 200))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use both startLine/endLine, inclusive, at most 200 lines.' });
      }
    })).min(1).max(4).optional(),
    conversationId: z.string().uuid(),
    error: z.string().nullable().optional(),
  })
  .superRefine((payload, ctx) => {
    if (!payload.error && !payload.operations && !payload.contextRequests && !payload.toolRequests) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'operations is required when error is not set',
        path: ['operations'],
      });
    }
    if (payload.contextRequests && (payload.operations?.length || payload.error)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Context requests cannot be mixed with changes or errors.' });
    }
    if (payload.toolRequests && (payload.operations?.length || payload.error || payload.contextRequests)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Read-only tool requests cannot be mixed with changes, errors or contextRequests.' });
    }
  });

export type Operation = z.infer<typeof operationSchema>;
export type AIResponsePayload = z.infer<typeof aiResponseSchema>;

export function validateAIResponse(payload: unknown): AIResponsePayload {
  return aiResponseSchema.parse(payload);
}

export function validateOperations(payload: unknown): Operation[] {
  return z.array(operationSchema).parse(payload);
}

export function formatValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
        return `${issue.message}${path}`;
      })
      .join('; ');
  }

  return error instanceof Error ? error.message : String(error);
}
