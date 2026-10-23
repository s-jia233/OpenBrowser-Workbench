import { z } from 'zod';

const providers = [
  { id: 'chatgpt', name: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'] },
  { id: 'claude', name: 'Claude', hosts: ['claude.ai'] },
  { id: 'gemini', name: 'Gemini', hosts: ['gemini.google.com'] },
  { id: 'deepseek', name: 'DeepSeek', hosts: ['chat.deepseek.com'] },
  { id: 'perplexity', name: 'Perplexity', hosts: ['www.perplexity.ai', 'perplexity.ai'] },
  { id: 'glm', name: 'GLM', hosts: ['chat.z.ai', 'glm.ai', 'open.bigmodel.cn'] },
  { id: 'grok', name: 'Grok', hosts: ['grok.com', 'x.com'] },
];

export interface AiIdentity { id: string; name: string; host: string }
export function identifyAi(host?: string): AiIdentity | undefined {
  const hostname = host?.trim().toLowerCase();
  const provider = providers.find((entry) => entry.hosts.includes(hostname ?? ''));
  return provider && hostname ? { id: provider.id, name: provider.name, host: hostname } : undefined;
}

export const aiIdentitySchema = z.object({ id: z.string().max(30), name: z.string().max(40), host: z.string().max(253) }).refine((value) => {
  const expected = identifyAi(value.host);
  return expected?.id === value.id && expected.name === value.name;
}, 'AI identity must match a supported hostname');
