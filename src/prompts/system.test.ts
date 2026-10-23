import { describe, expect, it } from 'vitest';
import { buildAgentSystemPrompt, buildAgentCompactRetryMessage, buildFullMessage } from './system.js';
import { formatAgentContextJson } from '../context/file-context.js';

const id = '36dea616-9ff2-40b5-9228-bbcfa05683f4';
const envelope = (message: string) => JSON.parse(message.split('--- End System Instructions ---\n').at(-1)!);

describe('compact communication protocol', () => {
  it('keeps a single short protocol without framework-specific scaffolding', () => {
    const prompt = buildAgentSystemPrompt(id);
    expect(prompt.length).toBeLessThan(2600);
    expect(prompt).toContain(id);
    expect(prompt).not.toContain('OB_FILE_BEGIN');
    expect(prompt).not.toContain('Express');
  });
  it('embeds context once, preserves task text and marks truncated source', () => {
    const context = formatAgentContextJson([{ path: 'a.ts', language: 'typescript', content: 'hello\nworld', truncated: true }]);
    const message = buildFullMessage('agent', buildAgentSystemPrompt(id), '仅删除最后一行', context);
    const data = envelope(message);
    expect(data.task).toBe('仅删除最后一行');
    expect(data.context.contextFiles[0].numberedContent).toContain('   2| world');
    expect(data.context.contextFiles[0].truncated).toBe(true);
    expect(data.context.editingRules).toBeUndefined();
  });
  it('bounds history as complete records and does not resend old agent code', () => {
    const history = Array.from({ length: 20 }, (_, n) => ({ prompt: 'user'.repeat(2000), response: 'old-code'.repeat(10000), status: n === 19 ? 'review' : 'complete', mode: 'agent', changes: ['a.ts'] }));
    const data = envelope(buildFullMessage('agent', 'rules', 'current task', undefined, { history, validationError: 'x'.repeat(20000) }));
    expect(JSON.stringify(data.history).length).toBeLessThanOrEqual(12000);
    expect(data.history.length).toBeLessThanOrEqual(6);
    expect(data.history.at(-1).applied).toBe(false);
    expect(JSON.stringify(data.history)).not.toContain('old-code');
    expect(data.validationError.length).toBe(2000);
    expect(data.task).toBe('current task');
  });
  it('keeps previous ask answers for follow-up questions', () => {
    const data = envelope(buildFullMessage('ask', 'rules', '为什么？', undefined, { history: [{ prompt: '问题', response: '上次回答', status: 'complete', mode: 'ask', changes: [] }] }));
    expect(data.history[0].answer).toBe('上次回答');
    expect(data.history[0].applied).toBe(false);
  });
  it('bounds retry diagnostics without repeating the protocol', () => {
    const data = JSON.parse(buildAgentCompactRetryMessage('x'.repeat(10000), id, 'fix it'));
    expect(data.validationError.length).toBe(2000);
    expect(data.task).toBe('fix it');
    expect(data.conversationId).toBe(id);
  });
});
