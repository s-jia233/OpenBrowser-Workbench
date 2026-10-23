import crypto from 'node:crypto';
import { identifyAi } from '../shared/ai-identity.js';
import { browserReceptionSchema } from '../shared/browser-reception.js';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateContext } from '../context/index.js';
import { writePromptFile, readPromptFile } from '../memory/index.js';
import { executeOperations, planOperations } from '../operations/index.js';
import { validateOperations } from '../protocol/index.js';
import { logger } from '../shared/index.js';
import { registerWorkbench } from '../workbench/routes.js';
import {
  PROMPT_FILE_COMPOSER_NOTE,
  PROMPT_FILE_NAME,
  shouldDeliverPromptAsFile,
} from '../shared/prompt-delivery.js';
import {
  addBrowserClient,
  broadcastBrowserJob,
  createSseStream,
  writeCorsPreflight,
  addSessionClient,
  notifySessionComplete,
  notifySessionChunk,
  notifySessionError,
  removeBrowserClient,
  removeSessionClient,
  sendSseEvent,
  startSessionHeartbeat,
  isTrustedBridgeOrigin,
  recordBrowserHeartbeat,
} from './sse-hub.js';
import {
  completeSession,
  createSession,
  failSession,
  getSession,
  tryClaimSession,
  updateSessionPartial,
  updateSessionReception,
} from './session-store.js';

const PORT = Number(process.env.PORT ?? 5000);

interface ServerOptions {
  port?: number;
  host?: string;
}

export async function createBridgeServer(options: { workspaceRoot?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, isTrustedBridgeOrigin(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Access-Control-Allow-Private-Network', 'true');
  });

  app.options('/browser/events', async (request, reply) => {
    reply.hijack();
    writeCorsPreflight(reply.raw, request.headers.origin);
  });

  app.options('/browser/claim', async (request, reply) => {
    reply.hijack();
    writeCorsPreflight(reply.raw, request.headers.origin);
  });

  app.options('/browser/chunk', async (request, reply) => {
    reply.hijack();
    writeCorsPreflight(reply.raw, request.headers.origin);
  });

  app.options('/browser/response', async (request, reply) => {
    reply.hijack();
    writeCorsPreflight(reply.raw, request.headers.origin);
  });

  app.options('/browser/prompt-file/:sessionId', async (request, reply) => {
    reply.hijack();
    writeCorsPreflight(reply.raw, request.headers.origin);
  });

  app.addHook('preHandler', async (request) => {
    const sameOrigin = request.headers.origin === `http://${request.headers.host}`
      && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host || '');
    if (!sameOrigin && !isTrustedBridgeOrigin(request.headers.origin)) {
      const error = new Error('Untrusted browser origin') as Error & { statusCode: number };
      error.statusCode = 403;
      throw error;
    }
    authenticate(request);
  });

  await registerWorkbench(app, options.workspaceRoot ?? process.cwd());

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/summary', async () => ({
    context: await generateContext(process.cwd()),
  }));

  app.post('/operations/preview', async (request) => {
    const operations = validateOperations((request.body as { operations?: unknown }).operations);
    return { operations: await planOperations(operations, process.cwd()) };
  });

  app.post('/operations/apply', async (request) => {
    const body = request.body as {
      operations?: unknown;
      conversationId?: string;
    };
    const operations = validateOperations(body.operations);
    return {
      operations: await executeOperations(operations, process.cwd(), {
        conversationId: body.conversationId,
      }),
    };
  });

  app.post('/session', async () => ({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }));

  app.post('/session/prompt', async (request) => {
    const body = request.body as {
      mode?: 'ask' | 'agent';
      prompt?: string;
      systemPrompt?: string;
      message?: string;
      conversationId?: string;
      markdownDraft?: boolean;
    };

    if (!body.mode || !body.prompt || !body.systemPrompt || !body.message || !body.conversationId) {
      throw new Error('mode, prompt, systemPrompt, message, and conversationId are required');
    }

    const delivery = shouldDeliverPromptAsFile(body.message) ? 'file' : 'text';
    const composerMessage =
      delivery === 'file' ? PROMPT_FILE_COMPOSER_NOTE : body.message;

    const session = createSession({
      mode: body.mode,
      prompt: body.prompt,
      systemPrompt: body.systemPrompt,
      message: body.message,
      composerMessage,
      delivery,
      conversationId: body.conversationId,
      markdownDraft: body.markdownDraft,
    });

    if (delivery === 'file') {
      await writePromptFile(process.cwd(), session.id, body.message);
      logger.info(
        { sessionId: session.id, chars: body.message.length },
        'Prompt saved as attachment file (exceeds injection limit)',
      );
    }

    logger.info({ sessionId: session.id, mode: session.mode, delivery }, 'Prompt session queued');

    broadcastBrowserJob({
      sessionId: session.id,
      mode: session.mode,
      message: composerMessage,
      composerMessage,
      delivery,
      promptFileName: delivery === 'file' ? PROMPT_FILE_NAME : undefined,
      systemPrompt: session.systemPrompt,
      conversationId: session.conversationId,
      markdownDraft: session.markdownDraft,
    });

    return { sessionId: session.id, status: session.status };
  });

  app.get('/session/:sessionId/status', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = getSession(sessionId);

    if (!session) {
      throw new Error('Session not found');
    }

    return {
      sessionId: session.id,
      status: session.status,
      mode: session.mode,
      response: session.response,
      partialText: session.partialText,
      error: session.error,
      reception: session.reception,
    };
  });

  app.get('/session/:sessionId/events', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = getSession(sessionId);

    if (!session) {
      throw new Error('Session not found');
    }

    reply.hijack();
    const raw = reply.raw;
    const origin = request.headers.origin;

    let heartbeat: ReturnType<typeof setInterval>;
    const client = createSseStream(raw, (closedClient) => {
      clearInterval(heartbeat);
      removeSessionClient(sessionId, closedClient);
    }, origin);

    if (session.status === 'complete') {
      sendSseEvent(raw, 'complete', { response: session.response });
      raw.end();
      return;
    }

    if (session.status === 'error') {
      sendSseEvent(raw, 'error', { error: session.error });
      raw.end();
      return;
    }

    addSessionClient(sessionId, client);
    heartbeat = startSessionHeartbeat(sessionId, client);

    if (session.partialText) {
      sendSseEvent(raw, 'chunk', { text: session.partialText });
    }
  });

  app.get('/browser/events', async (request, reply) => {
    const { clientId } = z.object({ clientId: z.string().min(8).max(128).optional() }).parse(request.query);
    reply.hijack();
    const raw = reply.raw;
    const origin = request.headers.origin;

    const client = createSseStream(raw, (closedClient) => {
      clearInterval(heartbeat);
      removeBrowserClient(closedClient);
    }, origin);

    addBrowserClient(client, clientId);
    const heartbeat = setInterval(() => {
      client.write(': heartbeat\n\n');
    }, 15_000);

    // IncomingMessage.close means the GET request completed, not that this
    // long-lived response closed. Cleanup is attached to reply.raw above.
  });

  app.post('/browser/heartbeat', async (request) => {
    const { clientId, readyTabs, readyHosts, readyPages } = z.object({ clientId: z.string().min(8).max(128), readyTabs: z.number().int().min(0).max(100), readyHosts: z.array(z.string().max(253)).max(100).optional(), readyPages: z.array(z.object({ tabId: z.number().int().positive(), host: z.string().max(253) })).max(100).optional() }).parse(request.body);
    recordBrowserHeartbeat(clientId, readyTabs, readyHosts, readyPages);
    return { ok: true };
  });

  app.post('/browser/claim', async (request) => {
    const body = z.object({ sessionId: z.string().uuid(), providerHost: z.string().max(253).optional(), clientId: z.string().min(8).max(128).optional(), tabId: z.number().int().positive().optional() }).parse(request.body);
    if (!body.sessionId) {
      throw new Error('sessionId is required');
    }

    const session = tryClaimSession(body.sessionId, identifyAi(body.providerHost), body.clientId && body.tabId ? { clientId: body.clientId, tabId: body.tabId } : undefined);
    if (!session) {
      return { claimed: false };
    }

    return {
      claimed: true,
      job: {
        sessionId: session.id,
        mode: session.mode,
        message: session.composerMessage,
        composerMessage: session.composerMessage,
        delivery: session.delivery,
        promptFileName: session.delivery === 'file' ? PROMPT_FILE_NAME : undefined,
        systemPrompt: session.systemPrompt,
        conversationId: session.conversationId,
        markdownDraft: session.markdownDraft,
      },
    };
  });

  app.get('/browser/prompt-file/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = getSession(sessionId);

    if (!session || session.delivery !== 'file') {
      throw new Error('Prompt file not found');
    }

    const content = await readPromptFile(process.cwd(), sessionId);
    return {
      fileName: PROMPT_FILE_NAME,
      content,
    };
  });

  app.post('/browser/chunk', async (request) => {
    const parsed = z.object({ sessionId: z.string().uuid(), text: z.string().max(700_000).optional(),
      reception: browserReceptionSchema.optional(), clientId: z.string().max(128).optional(),
      tabId: z.number().int().positive().optional(), providerHost: z.string().max(253).optional(),
    }).refine((body) => body.text !== undefined || body.reception !== undefined).safeParse(request.body);
    if (!parsed.success) throw Object.assign(new Error('Invalid chunk or reception metadata'), { statusCode: 400 });
    const body = parsed.data;

    const session = getSession(body.sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    requireBrowserSource(body.sessionId, body);

    let accepted = false;
    if (body.reception) accepted = updateSessionReception(body.sessionId, body.reception);
    if (body.text !== undefined && updateSessionPartial(body.sessionId, body.text)) {
      notifySessionChunk(body.sessionId, { text: body.text }); accepted = true;
    }
    return { accepted };
  });

  app.post('/browser/response', async (request) => {
    const parsed = z.object({
      sessionId: z.string().uuid(),
      text: z.string().min(1).max(700_000).optional(),
      error: z.string().min(1).max(700_000).optional(),
      clientId: z.string().min(8).max(128).optional(),
      tabId: z.number().int().positive().optional(),
    }).refine((body) => (body.text !== undefined) !== (body.error !== undefined)).safeParse(request.body);
    if (!parsed.success) throw Object.assign(new Error('Provide either reply text or an error string'), { statusCode: 400 });
    const body = parsed.data;
    const session = requireBrowserSource(body.sessionId, body);

    if (body.error) {
      if (!failSession(body.sessionId, body.error)) return { accepted: false, status: session.status };
      notifySessionError(body.sessionId, { error: body.error });
      logger.warn({ sessionId: body.sessionId, error: body.error }, 'Browser session failed');
      return { accepted: true, status: 'error' };
    }

    const text = body.text!;
    if (!completeSession(body.sessionId, text)) return { accepted: false, status: session.status };
    notifySessionComplete(body.sessionId, { response: text });
    logger.info({ sessionId: body.sessionId }, 'Browser response received');

    return { accepted: true, status: 'complete' };
  });

  app.post('/browser/message', async (request) => {
    return {
      accepted: true,
      receivedAt: new Date().toISOString(),
      body: request.body,
    };
  });

  return app;
}

export async function startServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = await createBridgeServer();
  const port = options.port ?? PORT;
  const host = options.host ?? '127.0.0.1';
  await app.listen({ port, host });
  logger.info({ port, host }, 'Bridge server listening');
  return app;
}

function requireBrowserSource(sessionId: string, source: { clientId?: string; tabId?: number }) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 });
  // Untargeted jobs still belong to the tab that won the atomic claim.
  // Legacy clients without claim metadata retain their existing behavior.
  const expected = session.target ?? session.claimedBy;
  if (expected && (expected.clientId !== source.clientId || expected.tabId !== source.tabId)) {
    throw Object.assign(new Error('回复不是来自指定标签页'), { statusCode: 403 });
  }
  return session;
}

function authenticate(request: FastifyRequest): void {
  if (request.method === 'OPTIONS') {
    return;
  }

  const url = request.url.split('?')[0] ?? request.url;

  if (
    url === '/' || url === '/workbench.css' || url === '/workbench.js' || url === '/ai-status.js' || url === '/composer-controls.js' || url === '/conversation-menu.js' || url === '/collaboration.js' || url === '/collaboration-report.js' || url === '/collaboration-drafts.js' || url === '/execution-status.js' || url === '/browser-targets.js' || url === '/task-drafts.js' || url === '/favicon.svg' ||
    url.startsWith('/api/ui/') ||
    url === '/health' ||
    url.startsWith('/browser/') ||
    /^\/session\/[^/]+\/(status|events)$/.test(url)
  ) {
    return;
  }

  const token = process.env.BRIDGE_TOKEN;
  if (!token) {
    return;
  }

  const header = request.headers.authorization;
  if (header !== `Bearer ${token}`) {
    throw new Error('Unauthorized bridge request');
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  startServer().catch((err) => {
    logger.error(err, 'Failed to start bridge server');
    process.exit(1);
  });
}
