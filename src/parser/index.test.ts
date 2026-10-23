import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAIResponse } from './index.js';

const conversationId = '36dea616-9ff2-40b5-9228-bbcfa05683f4';
const operation = { action: 'EDIT_FILE', path: 'README.md', startLine: 576, endLine: 577, replace: '' };
const complete = JSON.stringify({ operations: [operation], conversationId });

describe('agent response framing', () => {
  it('accepts typed read-only tools and rejects unknown tools, shell requests, invalid ranges and mixed writes', () => {
    const payload = { conversationId, operations: [], toolRequests: [{ tool: 'search', query: 'LOGIN_FAILED', path: 'src' }] };
    const parsed = parseAIResponse(JSON.stringify(payload), { conversationId });
    expect(parsed.operations).toEqual([]); expect(parsed.toolRequests?.[0].tool).toBe('search');
    for (const invalid of [
      { ...payload, operations: [operation] },
      { ...payload, contextRequests: [{ path: 'README.md' }] },
      { ...payload, error: 'mixed' },
      { ...payload, toolRequests: [{ tool: 'RUN_COMMAND', command: 'whoami' }] },
      { ...payload, toolRequests: [{ tool: 'search', query: 'login', regex: true }] },
      { ...payload, toolRequests: [{ tool: 'search', query: '' }] },
      { ...payload, toolRequests: [{ tool: 'list_files', path: '.', depth: 5 }] },
      { ...payload, toolRequests: [{ tool: 'read_file', path: 'x.ts', startLine: 1, endLine: 201 }] },
      { ...payload, toolRequests: [{ tool: 'read_file', path: 'x.ts', startLine: 2 }] },
      { ...payload, toolRequests: Array.from({ length: 5 }, () => ({ tool: 'search', query: 'login' })) },
      { ...payload, toolRequests: [{ tool: 'read_file', path: '../outside' }] },
      { ...payload, conversationId: '46dea616-9ff2-40b5-9228-bbcfa05683f4' },
    ]) expect(() => parseAIResponse(JSON.stringify(invalid), { conversationId })).toThrow();
  });
  it('accepts bounded read requests but rejects mixed edits, oversized ranges and wrong IDs', () => {
    const request = { conversationId, contextRequests: [{ path: 'README.md', startLine: 1, endLine: 100 }] };
    expect(parseAIResponse(JSON.stringify(request), { conversationId }).contextRequests).toEqual(request.contextRequests);
    for (const payload of [
      { ...request, operations: [operation] },
      { ...request, error: 'mixed' },
      { ...request, contextRequests: [{ path: 'README.md', startLine: 1, endLine: 300 }] },
      { ...request, contextRequests: [{ path: 'README.md', startLine: 1 }] },
      { ...request, contextRequests: [{ path: '../outside' }] },
      { ...request, conversationId: '46dea616-9ff2-40b5-9228-bbcfa05683f4' },
    ]) expect(() => parseAIResponse(JSON.stringify(payload), { conversationId })).toThrow();
  });
  it('accepts pure JSON full source for Markdown, YAML and code without changing content', () => {
    for (const [path, content] of [
      ['README.md', '# Title\n\n```bash\necho "hello"\n```\n'],
      ['config.yaml', 'services:\n  web:\n    image: "test"\n'],
      ['code.ts', 'const escaped = "\\n";\n// ---OB_FILE_BEGIN: example---\n'],
      ['page.html', '<analysis>literal user source</analysis>\n<think>not reasoning</think>'],
    ]) {
      const op = { action: 'CREATE_FILE', path, content };
      expect(parseAIResponse(JSON.stringify({ conversationId, operations: [op] }), { conversationId }).operations).toEqual([op]);
    }
  });
  it('accepts clarification without operations and rejects mixed error/actions', () => {
    expect(parseAIResponse(JSON.stringify({ conversationId, error: 'Which file?', operations: [] }), { conversationId }).error).toBe('Which file?');
    expect(() => parseAIResponse(JSON.stringify({ conversationId, error: 'Which file?', operations: [operation] }), { conversationId })).toThrow();
  });
  it('still accepts legacy file blocks', () => {
    const raw = JSON.stringify({ conversationId, operations: [{ action: 'CREATE_FILE', path: 'test.ts' }] }) + '\n---OB_FILE_BEGIN: test.ts---\nconst a = 1;\n---OB_FILE_END---';
    expect(parseAIResponse(raw, { conversationId }).operations?.[0].content).toContain('const a = 1;');
  });
  it('parses the exact saved failed response without changing the requested edit', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/truncated-response.json', import.meta.url), 'utf8'));
    expect(parseAIResponse(fixture.raw, { conversationId: fixture.conversationId }).operations).toEqual([fixture.expected]);
  });
  it('recovers only a missing opening wrapper from the captured failure, preserving empty replacement', () => {
    const events: string[] = [];
    const captured = 'I will provide the JSON clearly.' + complete.slice(2);
    const result = parseAIResponse(captured, { conversationId, onRepair: (message) => events.push(message) });
    expect(result.operations).toEqual([operation]); expect(result.conversationId).toBe(conversationId);
    expect(events).toHaveLength(1);
  });
  it('recovers a missing brace without altering the operation', () => {
    expect(parseAIResponse(complete.slice(1), { conversationId }).operations).toEqual([operation]);
  });
  it('does not repair incomplete arrays, missing values or mismatched task UUIDs', () => {
    for (const raw of [complete.slice(2, -2), complete.slice(2).replace('"replace":""', '"replace":'), complete.slice(2).replace(conversationId, '46dea616-9ff2-40b5-9228-bbcfa05683f4')]) {
      expect(() => parseAIResponse(raw, { conversationId })).toThrow();
    }
  });
  it('rejects malformed full JSON rather than accepting a partial parse', () => {
    expect(() => parseAIResponse(complete.replace('"replace":""', '"replace":'), { conversationId })).toThrow();
  });
  it('does not execute operations quoted inside thinking blocks', () => {
    expect(() => parseAIResponse(`<think>${complete}</think>There is no final answer.`, { conversationId })).toThrow();
    expect(parseAIResponse(`<analysis>example only: ${complete}</analysis>\n${complete}`, { conversationId }).operations).toEqual([operation]);
  });
  it('rejects a complete response from a different task', () => {
    expect(() => parseAIResponse(complete, { conversationId: '46dea616-9ff2-40b5-9228-bbcfa05683f4' })).toThrow('conversationId');
  });
  it('does not bypass path validation when recovering a wrapper', () => {
    expect(() => parseAIResponse(complete.slice(2).replace('README.md', '../outside.txt'), { conversationId })).toThrow();
  });
});
