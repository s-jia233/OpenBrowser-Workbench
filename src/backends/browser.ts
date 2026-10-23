import {
  submitPrompt,
  waitForSessionResponse,
  type SubmitPromptInput,
} from '../client/bridge-client.js';
import type { ModelBackend } from './types.js';

export function createBrowserBackend(port: number): ModelBackend {
  return {
    id: 'browser',
    submit(input: SubmitPromptInput) {
      return submitPrompt(input, port);
    },
    waitForResponse(sessionId: string) {
      return waitForSessionResponse(sessionId, { port });
    },
  };
}
