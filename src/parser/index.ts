import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { validateAIResponse, formatValidationError, type AIResponsePayload, type Operation } from '../protocol/index.js';
import {
  detectCopyPasteBlocks,
  detectCommandInMarkdownBlocks,
  extractFileBlocks,
  mergeFileBlocksIntoOperations,
  mergeMarkdownFencesIntoOperations,
  mergeYamlFencesIntoOperations,
  normalizeObFileCaptureText,
  normalizeOperationTextFields,
  operationsNeedMarkdownContent,
  validateMergedFileOperations,
} from './markdown-agent.js';
import { FileOperation } from '../core/types/index.js';
import { expandMkdirOperations } from '../operations/mkdir-normalize.js';
import { sortOperationsByExecutionOrder } from '../operations/operation-order.js';

export interface ParseAIResponseOptions {
  conversationId?: string;
  onRepair?: (message: string) => void;
}

export function parseAIResponse(
  raw: string,
  options: ParseAIResponseOptions = {},
): AIResponsePayload {
  let isJsonReply = false;
  try {
    const candidate = parseCompleteJson(stripJsonFence(raw).trim()) as { operations?: unknown; error?: unknown; contextRequests?: unknown; toolRequests?: unknown } | null;
    isJsonReply = !!candidate && typeof candidate === 'object' && (Array.isArray(candidate.operations) || Array.isArray(candidate.contextRequests) || Array.isArray(candidate.toolRequests) || typeof candidate.error === 'string');
  } catch { /* Legacy replies may contain reasoning outside the JSON envelope. */ }
  const answerText = isJsonReply ? raw : raw.replace(/<(think|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<(?:think|analysis)\b[^>]*>[\s\S]*$/gi, '');
  const operationsJson = extractOperationsJsonFromText(answerText, options);
  const parsed = parseAgentJson(operationsJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Response is not a JSON object');
  }

  const payload = { ...(parsed as Record<string, unknown>) };
  if ((!Array.isArray(payload.operations) || payload.operations.length === 0) && !payload.error && !payload.contextRequests && !payload.toolRequests) {
    throw new Error(
      'Return one complete JSON object with conversationId and operations. Put full file source in each operation content string.',
    );
  }

  if (options.conversationId) {
    if (payload.conversationId && payload.conversationId !== options.conversationId) throw new Error('模型回复的 conversationId 与当前任务不符，请勿使用其他会话的回复');
    payload.conversationId = options.conversationId;
  }

  let validated: AIResponsePayload;
  try {
    validated = validateAIResponse(payload);
  } catch (error) {
    throw new Error(formatValidationError(error));
  }

  if (validated.contextRequests || validated.toolRequests) return { ...validated, operations: [] };

  if (validated.error) {
    if (validated.operations?.length) throw new Error('Return either operations or an error question, not both.');
    return { ...validated, operations: [] };
  }

  // JSON strings have already been decoded exactly once. Never run legacy
  // fence extraction, newline repair or YAML rewriting over literal source.
  const inlineOperations = validated.operations ?? [];
  if (inlineOperations.every((op) => {
    if (op.action === 'CREATE_FILE') return op.content !== undefined;
    if (op.action !== 'EDIT_FILE') return true;
    return op.content !== undefined || (op.replace !== undefined &&
      (op.search !== undefined || (op.startLine !== undefined && op.endLine !== undefined)));
  })) {
    validateMergedFileOperations(inlineOperations);
    return { ...validated, operations: sortOperationsByExecutionOrder(expandMkdirOperations(inlineOperations)) };
  }

  const rawText = /---OB_FILE_BEGIN:/i.test(answerText) ? normalizeObFileCaptureText(answerText) : answerText;
  const operations = (validated.operations ?? []) as unknown as FileOperation[];

  const copyPasteError = detectCopyPasteBlocks(rawText, {
    allowMarkdownFences: operationsNeedMarkdownContent(operations),
  });
  if (copyPasteError) {
    throw new Error(copyPasteError);
  }

  const commandBlockError = detectCommandInMarkdownBlocks(rawText, operations);
  if (commandBlockError) {
    throw new Error(commandBlockError);
  }

  const fileBlocks = extractFileBlocks(rawText);
  const mergedOps = sortOperationsByExecutionOrder(
    expandMkdirOperations(
      normalizeOperationTextFields(
        mergeYamlFencesIntoOperations(
          mergeMarkdownFencesIntoOperations(
            mergeFileBlocksIntoOperations(operations, fileBlocks, rawText),
            rawText,
          ),
          rawText,
        ),
      ),
    ),
  );
  validateMergedFileOperations(mergedOps);

  return {
    ...validated,
    operations: mergedOps as Operation[],
  };
}

function parseAgentJson(extracted: string): unknown {
  return parseCompleteJson(extracted);
}

function parseCompleteJson(text: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('JSON is incomplete or malformed');
  return parsed;
}

function extractOperationsJsonFromText(raw: string, options: ParseAIResponseOptions): string {
  const trimmed = stripJsonFence(raw).trim();
  const candidates = findAllJsonObjects(trimmed);

  let best: string | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = scoreOperationsJson(candidate, trimmed);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (best) {
    return best;
  }

  // Older stream capture sometimes lost only the opening { and/or quote.
  // Repair that wrapper ONLY: never invent paths, actions, contents or closing
  // brackets. A complete tail and matching task UUID are mandatory.
  const markers = [...trimmed.matchAll(/(?<![\w])"?operations"\s*:\s*\[/g)];
  if (options.conversationId && markers.length === 1) {
    const tail = trimmed.slice(markers[0].index!).replace(/\s*```\s*$/, '').trim();
    const repaired = (tail.startsWith('"') ? '{' : '{"') + tail;
    try {
      const candidate = parseCompleteJson(repaired) as { operations?: unknown[]; conversationId?: string };
      if (Array.isArray(candidate.operations) && candidate.operations.length && candidate.conversationId === options.conversationId) {
        options.onRepair?.('已恢复捕获时丢失的 JSON 外层开头；文件路径、操作和内容未改动，仍需审核 Diff。');
        return repaired;
      }
    } catch { /* Incomplete or ambiguous operations must be rejected. */ }
  }

  throw new Error(
    'Return one complete JSON object with conversationId and operations. Put full file source in each operation content string.',
  );
}

function findAllJsonObjects(text: string): string[] {
  const objects: string[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') {
      continue;
    }

    const json = extractBalancedJson(text, index);
    if (!json) {
      continue;
    }

    objects.push(json);
    index += json.length - 1;
  }

  return objects;
}

function scoreOperationsJson(candidate: string, fullText: string): number {
  try {
    const parsed = parseCompleteJson(candidate) as {
      operations?: unknown[];
      conversationId?: string;
      error?: string;
      contextRequests?: unknown[];
      toolRequests?: unknown[];
    };

    if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) {
      if (Array.isArray(parsed.toolRequests) && parsed.toolRequests.length && parsed.conversationId) return 100;
      if (Array.isArray(parsed.contextRequests) && parsed.contextRequests.length && parsed.conversationId) return 100;
      if (typeof parsed.error === 'string' && parsed.error.trim() && parsed.conversationId) return 100;
      return -1;
    }

    const validCount = parsed.operations.filter(
      (operation) =>
        operation &&
        typeof operation === 'object' &&
        typeof (operation as { action?: unknown }).action === 'string',
    ).length;

    if (validCount === 0) {
      return -1;
    }

    let score = validCount * 100;
    if (parsed.conversationId) {
      score += 10;
    }

    const position = fullText.lastIndexOf(candidate);
    if (position >= 0) {
      score += Math.min(50, Math.floor(position / 100));
    }

    return score;
  } catch {
    return -1;
  }
}

function extractBalancedJson(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const jsonOnly = /^```json\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (jsonOnly?.[1]) {
    return jsonOnly[1].trim();
  }
  return trimmed;
}
