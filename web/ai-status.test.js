import { describe, expect, it } from 'vitest';
import { connectionAiDisplay, taskAiLabel } from './ai-status.js';

describe('visible AI identity', () => {
  it('names a single ready platform, not a guessed model version', () => {
    const result = connectionAiDisplay({ browserConnections: 1, state: 'ready', readyTabs: 1, providers: [{ name: 'DeepSeek' }] });
    expect(result.label).toBe('当前 AI：DeepSeek');
    expect(result.detail).toContain('模型版本未识别');
    expect(result.label).not.toContain('R1');
  });
  it('shows multiple candidates and confirms neither as the task provider', () => {
    const result = connectionAiDisplay({ browserConnections: 1, state: 'ready', readyTabs: 2, providers: [{ name: 'DeepSeek' }, { name: 'ChatGPT' }] });
    expect(result.label).toBe('就绪 AI：DeepSeek、ChatGPT'); expect(result.detail).toContain('实际接单');
    expect(connectionAiDisplay({ browserConnections: 1, state: 'ready', readyTabs: 2, providers: [{ name: 'DeepSeek' }] }).detail).toContain('2 个页面');
  });
  it('distinguishes manual, offline, not-ready and old-extension cases', () => {
    expect(connectionAiDisplay({}, true).label).toContain('手动传递');
    expect(connectionAiDisplay({}, false, false).label).toContain('服务未连接');
    expect(connectionAiDisplay({ browserConnections: 0 }).label).toContain('未连接');
    expect(connectionAiDisplay({ browserConnections: 1, state: 'no_tab', readyTabs: 0 }).label).toContain('无就绪页面');
    expect(connectionAiDisplay({ browserConnections: 1, state: 'ready', readyTabs: 1 }).detail).toContain('0.8.5');
  });
  it('uses actual task identity, while manual pasted replies and old records remain unknown', () => {
    expect(taskAiLabel({ delivery: 'browser', ai: { name: 'DeepSeek' } })).toContain('DeepSeek');
    expect(taskAiLabel({ delivery: 'browser', aiPending: true })).toContain('等待实际接单');
    expect(taskAiLabel({ delivery: 'browser' })).toContain('未识别');
    expect(taskAiLabel({ delivery: 'browser', ai: { name: 'DeepSeek' }, manualResponse: true })).not.toContain('DeepSeek');
    expect(taskAiLabel({ delivery: 'manual' })).toContain('无法自动识别');
  });
});
