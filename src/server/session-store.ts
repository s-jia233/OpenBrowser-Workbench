import crypto from 'node:crypto';
import type { AiIdentity } from '../shared/ai-identity.js';
import type { PromptDelivery } from '../shared/prompt-delivery.js';
import type { BrowserReception } from '../shared/browser-reception.js';

export type SessionMode = 'ask' | 'agent';
export interface BrowserTarget { clientId: string; tabId: number }

export type SessionStatus =
  | 'pending'
  | 'claimed'
  | 'complete'
  | 'error';

export interface PromptSession {
  id: string;
  mode: SessionMode;
  prompt: string;
  systemPrompt: string;
  message: string;
  composerMessage: string;
  delivery: PromptDelivery;
  conversationId: string;
  markdownDraft?: boolean;
  status: SessionStatus;
  response?: string;
  partialText?: string;
  error?: string;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  ai?: AiIdentity;
  target?: BrowserTarget;
  claimedBy?: BrowserTarget;
  reception?: BrowserReception;
}

export interface CreateSessionInput {
  target?: BrowserTarget;
  mode: SessionMode;
  prompt: string;
  systemPrompt: string;
  message: string;
  composerMessage: string;
  delivery: PromptDelivery;
  conversationId: string;
  markdownDraft?: boolean;
}

const sessions = new Map<string, PromptSession>();

export function createSession(input: CreateSessionInput): PromptSession {
  const session: PromptSession = {
    id: crypto.randomUUID(),
    target: input.target,
    mode: input.mode,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    message: input.message,
    composerMessage: input.composerMessage,
    delivery: input.delivery,
    conversationId: input.conversationId,
    markdownDraft: input.markdownDraft,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  sessions.set(session.id, session);
  return session;
}

export function claimPendingSession(): PromptSession | null {
  for (const session of sessions.values()) {
    if (session.status !== 'pending' || session.target) {
      continue;
    }

    session.status = 'claimed';
    session.claimedAt = new Date().toISOString();
    return session;
  }

  return null;
}

export function tryClaimSession(sessionId: string, ai?: AiIdentity, claimant?: BrowserTarget): PromptSession | null {
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'pending') {
    return null;
  }
  if (session.target && (!claimant || session.target.clientId !== claimant.clientId || session.target.tabId !== claimant.tabId)) return null;

  session.status = 'claimed';
  session.claimedAt = new Date().toISOString();
  session.ai = ai;
  session.claimedBy = claimant ? { ...claimant } : undefined;
  return session;
}

export function releaseClaim(sessionId: string): PromptSession | undefined {
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'claimed') {
    return session;
  }

  session.status = 'pending';
  session.claimedAt = undefined;
  session.claimedBy = undefined;
  session.ai = undefined;
  session.partialText = undefined;
  session.reception = undefined;
  return session;
}

export function getSession(sessionId: string): PromptSession | undefined {
  return sessions.get(sessionId);
}

export function updateSessionPartial(
  sessionId: string,
  partialText: string,
): PromptSession | undefined {
  const session = sessions.get(sessionId);
  if (!session || !['pending', 'claimed'].includes(session.status)) {
    return undefined;
  }

  session.partialText = partialText;
  return session;
}

export function updateSessionReception(sessionId: string, reception: BrowserReception): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'claimed') return false;
  if (session.reception && session.reception.elapsedMs > reception.elapsedMs) return false;
  session.reception = reception;
  return true;
}

export function completeSession(sessionId: string, response: string): PromptSession | undefined {
  const session = sessions.get(sessionId);
  if (!session || !['pending', 'claimed'].includes(session.status)) {
    return undefined;
  }

  session.status = 'complete';
  session.response = response;
  session.completedAt = new Date().toISOString();
  return session;
}

export function failSession(sessionId: string, error: string): PromptSession | undefined {
  const session = sessions.get(sessionId);
  if (!session || !['pending', 'claimed'].includes(session.status)) {
    return undefined;
  }

  session.status = 'error';
  session.error = error;
  session.completedAt = new Date().toISOString();
  return session;
}

export function clearSessions(): void {
  sessions.clear();
}
