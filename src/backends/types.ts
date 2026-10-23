import type { SubmitPromptInput } from '../client/bridge-client.js';

export interface ModelBackend {
  readonly id: string;
  submit(input: SubmitPromptInput): Promise<{ sessionId: string }>;
  waitForResponse(sessionId: string): Promise<string>;
}
