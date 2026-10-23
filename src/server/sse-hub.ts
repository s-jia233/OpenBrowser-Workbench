import type { ServerResponse } from 'node:http';
import { getSession, type PromptSession, type BrowserTarget } from './session-store.js';
import { identifyAi, type AiIdentity } from '../shared/ai-identity.js';
import type { PromptDelivery } from '../shared/prompt-delivery.js';

export interface BrowserJobEvent {
  target?: BrowserTarget;
  sessionId: string;
  mode: PromptSession['mode'];
  message: string;
  composerMessage: string;
  delivery: PromptDelivery;
  promptFileName?: string;
  systemPrompt: string;
  conversationId: string;
  markdownDraft?: boolean;
}

interface SseClient {
  write: (chunk: string) => void;
  close: () => void;
}

const browserClients = new Set<SseClient>();
const browserClientIds = new Map<SseClient, string>();
const bridges = new Map<string, { lastSeen: number; readyTabs: number; readyHosts?: string[]; readyPages?: { tabId: number; host: string }[] }>();
const BRIDGE_TTL = 45_000;
const sessionClients = new Map<string, Set<SseClient>>();
const pendingBrowserJobs = new Map<string, BrowserJobEvent>();

export function browserConnectionCount(): number {
  return browserConnectionStatus().browserConnections;
}

export function recordBrowserHeartbeat(clientId: string, readyTabs: number, readyHosts?: string[], readyPages?: { tabId: number; host: string }[]): void {
  bridges.set(clientId, { lastSeen: Date.now(), readyTabs, readyHosts: readyHosts?.slice(0, readyTabs), readyPages: readyPages?.slice(0, readyTabs) });
  for (const [id, bridge] of bridges) if (Date.now() - bridge.lastSeen > BRIDGE_TTL) bridges.delete(id);
}

export function browserConnectionStatus() {
  const live = [...bridges.values()].filter((bridge) => Date.now() - bridge.lastSeen <= BRIDGE_TTL);
  const legacy = [...browserClients].filter((client) => !browserClientIds.has(client)).length;
  const providers = new Map<string, AiIdentity>();
  for (const bridge of live) for (const host of bridge.readyHosts ?? []) {
    const identity = identifyAi(host);
    if (identity) providers.set(identity.id, identity);
  }
  return { browserConnections: live.length + legacy, transportConnections: browserClients.size, targets: browserTargets(),
    providers: [...providers.values()], identityReported: live.some((bridge) => bridge.readyHosts !== undefined),
    readyTabs: live.length ? live.reduce((total, bridge) => total + bridge.readyTabs, 0) : null,
    state: live.length ? (live.some((bridge) => bridge.readyTabs > 0) ? 'ready' : 'no_tab') : legacy ? 'legacy' : 'disconnected' };
}

export function browserTargets() {
  return [...bridges].filter(([, bridge]) => Date.now() - bridge.lastSeen <= BRIDGE_TTL)
    .flatMap(([clientId, bridge]) => (bridge.readyPages ?? []).flatMap((page) => {
      const ai = identifyAi(page.host);
      return ai ? [{ id: `${clientId}:${page.tabId}`, clientId, tabId: page.tabId, host: ai.host, name: ai.name }] : [];
    }));
}

export function isTrustedBridgeOrigin(origin?: string): boolean {
  if (!origin) {
    return true;
  }

  try {
    return new URL(origin).protocol === 'chrome-extension:';
  } catch {
    return false;
  }
}

export function applyCorsHeaders(
  raw: ServerResponse,
  origin?: string,
): void {
  if (origin && isTrustedBridgeOrigin(origin)) {
    raw.setHeader('Access-Control-Allow-Origin', origin);
    raw.setHeader('Vary', 'Origin');
  } else if (!origin) {
    raw.setHeader('Access-Control-Allow-Origin', '*');
  }

  raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  raw.setHeader('Access-Control-Allow-Private-Network', 'true');
}

export function writeCorsPreflight(raw: ServerResponse, origin?: string): void {
  if (!isTrustedBridgeOrigin(origin)) {
    raw.writeHead(403);
    raw.end();
    return;
  }
  applyCorsHeaders(raw, origin);
  raw.writeHead(204);
  raw.end();
}

export function sendSseEvent(
  raw: ServerResponse,
  event: string,
  data: unknown,
): void {
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createSseStream(
  raw: ServerResponse,
  onClose: (client: SseClient) => void,
  origin?: string,
): SseClient {
  applyCorsHeaders(raw, origin);
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const client: SseClient = {
    write: (chunk) => raw.write(chunk),
    close: () => raw.end(),
  };

  raw.on('close', () => onClose(client));
  return client;
}

export function addBrowserClient(client: SseClient, clientId?: string): void {
  browserClients.add(client);
  if (clientId) {
    // Only one stream per extension instance. A reconnect replaces a half-open one.
    for (const [old, id] of browserClientIds) if (id === clientId) { removeBrowserClient(old); old.close(); }
    browserClientIds.set(client, clientId);
  }
  client.write('event: connected\n');
  client.write('data: {"ok":true}\n\n');

  for (const [sessionId, job] of pendingBrowserJobs) {
    if (getSession(sessionId)?.status !== 'pending') { pendingBrowserJobs.delete(sessionId); continue; }
    if (job.target && job.target.clientId !== clientId) continue;
    client.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
  }
}

export function removeBrowserClient(client: SseClient): void {
  browserClients.delete(client);
  browserClientIds.delete(client);
}

export function broadcastBrowserJob(job: BrowserJobEvent): void {
  const payload = `event: job\ndata: ${JSON.stringify(job)}\n\n`;

  // Retain until claim, not until write: an extension can sleep between receipt
  // and claim. Replaying pending jobs is safe because claiming is atomic.
  for (const id of pendingBrowserJobs.keys()) if (getSession(id)?.status !== 'pending') pendingBrowserJobs.delete(id);
  pendingBrowserJobs.set(job.sessionId, job);
  if (pendingBrowserJobs.size > 100) pendingBrowserJobs.delete(pendingBrowserJobs.keys().next().value!);

  for (const client of browserClients) {
    if (job.target && job.target.clientId !== browserClientIds.get(client)) continue;
    client.write(payload);
  }
}

export function addSessionClient(sessionId: string, client: SseClient): void {
  const clients = sessionClients.get(sessionId) ?? new Set();
  clients.add(client);
  sessionClients.set(sessionId, clients);
}

export function removeSessionClient(sessionId: string, client: SseClient): void {
  const clients = sessionClients.get(sessionId);
  if (!clients) {
    return;
  }

  clients.delete(client);
  if (clients.size === 0) {
    sessionClients.delete(sessionId);
  }
}

export function notifySessionComplete(
  sessionId: string,
  payload: { response: string },
): void {
  notifySession(sessionId, 'complete', payload);
}

export function notifySessionError(
  sessionId: string,
  payload: { error: string },
): void {
  notifySession(sessionId, 'error', payload);
}

export function notifySessionChunk(
  sessionId: string,
  payload: { text: string },
): void {
  const clients = sessionClients.get(sessionId);
  if (!clients) {
    return;
  }

  const message = `event: chunk\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

function notifySession(
  sessionId: string,
  event: string,
  data: unknown,
): void {
  const clients = sessionClients.get(sessionId);
  if (!clients) {
    return;
  }

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
    client.close();
  }

  sessionClients.delete(sessionId);
}

export function startSessionHeartbeat(
  _sessionId: string,
  client: SseClient,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    client.write(': heartbeat\n\n');
  }, 15_000);
}

export function clearSseHub(): void {
  browserClients.clear();
  browserClientIds.clear();
  bridges.clear();
  sessionClients.clear();
  pendingBrowserJobs.clear();
}
