import { describe, expect, it } from 'vitest';
import { targetChoices, validateBrowserTarget } from './browser-targets.js';
const targets = [{ id: 'browser:1', name: 'ChatGPT', tabId: 1 }, { id: 'browser:2', name: 'DeepSeek', tabId: 2 }];

describe('single-model page selection', () => {
  it('allows auto-selection only when at most one known page is ready', () => {
    expect(validateBrowserTarget([])).toBeUndefined();
    expect(validateBrowserTarget(targets.slice(0, 1))).toBeUndefined();
    expect(() => validateBrowserTarget(targets)).toThrow('请选择');
    expect(validateBrowserTarget(targets, 'browser:2')).toBe('browser:2');
  });
  it('keeps an offline selection visible and rejects it instead of silently falling back', () => {
    const options = targetChoices(targets, 'old-browser:9');
    expect(options.at(-1)).toEqual({ value: 'old-browser:9', label: '已离线，请重选', disabled: true });
    expect(() => validateBrowserTarget(targets, 'old-browser:9')).toThrow('已离线');
    expect(options[1].label).toContain('ChatGPT'); expect(options[2].label).toContain('标签页 2');
  });
});
