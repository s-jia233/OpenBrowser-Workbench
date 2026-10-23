import fs from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

async function popup(identityReporting: boolean, version: string) {
  const elements = new Map<string, { textContent: string; className: string; addEventListener(): void; replaceChildren(): void }>();
  const element = () => ({ textContent: '', className: '', addEventListener() {}, replaceChildren() {} });
  const context = vm.createContext({
    URL, performance, AbortSignal, setInterval() {},
    document: { querySelector(selector: string) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); }, createElement: element },
    chrome: { runtime: { getManifest: () => ({ version }), sendMessage: async () => ({ sseConnected: true, readyTabs: 1, identityReporting }) },
      tabs: { query: async () => [{ url: 'https://chat.deepseek.com/a/chat/private-id' }] } },
    fetch: async () => ({ ok: true }),
  });
  vm.runInContext(await fs.readFile(new URL('./src/popup.js', import.meta.url), 'utf8'), context);
  for (let index = 0; index < 30; index++) await Promise.resolve();
  return elements;
}

describe('extension popup identity diagnostics', () => {
  it('shows the installed manifest version rather than a hard-coded version', async () => {
    const elements = await popup(true, '0.8.5');
    expect(elements.get('#extension-version')?.textContent).toBe('v0.8.5');
    expect(elements.get('#page-provider')?.textContent).toBe('DeepSeek detected');
    expect(elements.get('#bridge-meta')?.textContent).toContain('已启用 AI 平台上报');
  });
  it('distinguishes local page detection from an old background worker that needs reloading', async () => {
    const elements = await popup(false, '0.8.4');
    expect(elements.get('#extension-version')?.textContent).toBe('v0.8.4');
    expect(elements.get('#page-provider')?.textContent).toBe('DeepSeek detected');
    expect(elements.get('#bridge-meta')?.textContent).toContain('后台脚本未上报平台');
  });
});
