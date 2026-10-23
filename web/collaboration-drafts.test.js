import { describe, expect, it } from 'vitest';
import { normalizeDrafts, createDraftStore } from './collaboration-drafts.js';
const id = '11111111-1111-4111-8111-111111111111';
const job = '22222222-2222-4222-8222-222222222222';
const fixture = () => ({ version: 1, consent: true, form: { prompt: 'unsent task', consent: true,
  proposers: [{ label: 'A', value: 'manual' }, { label: 'B', value: 'o:local' }], reviewer: { label: 'Judge', value: 'manual' } },
  rounds: { [id]: { feedback: 'unsent feedback', executor: 'reviewer', selected: [job, job, 'bad'], replies: { [job]: 'unsent answer' }, consent: true } } });
describe('project-scoped local unsent drafts', () => {
  it('restores text and selections but never consent or unknown fields', () => {
    const value = normalizeDrafts(fixture());
    expect(value.form.prompt).toBe('unsent task'); expect(value.rounds[id].replies[job]).toBe('unsent answer');
    expect(value.rounds[id].selected).toEqual([job]); expect(JSON.stringify(value)).not.toContain('consent');
  });
  it('isolates projects and does not mutate the input', () => {
    const entries = new Map(), storage = { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value) };
    const a = createDraftStore(storage, 'C:\\a'), b = createDraftStore(storage, 'C:\\b');
    const input = fixture(); expect(a.save(input)).toBe(true); expect(a.load().form.prompt).toBe('unsent task');
    expect(b.load().form).toBeNull(); expect(input.form.consent).toBe(true);
  });
  it('fails safely with corrupt, blocked, oversized or missing browser storage', () => {
    for (const raw of ['{broken', 'x'.repeat(2500001), 'null', '{"version":2}']) expect(createDraftStore({ getItem: () => raw }, 'a').load().form).toBeNull();
    expect(createDraftStore(null, 'a').save(fixture())).toBe(false);
    expect(createDraftStore({ getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } }, 'a').load().form).toBeNull();
    expect(createDraftStore({ setItem() { throw Error('quota'); } }, 'a').save(fixture())).toBe(false);
  });
  it('drops invalid or excessive data and ignores prototype-style keys', () => {
    const value = fixture(); value.form.prompt = 'x'.repeat(8001); value.rounds[id].replies[job] = 'x'.repeat(16001);
    value.rounds['__proto__'] = { feedback: 'bad' };
    const result = normalizeDrafts(value); expect(result.form).toBeNull(); expect(result.rounds[id].replies).toEqual({});
    expect(Object.keys(result.rounds)).toEqual([id]);
  });
});
