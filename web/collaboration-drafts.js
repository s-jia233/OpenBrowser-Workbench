const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.length <= limit;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const config = (value) => plain(value) && text(value.label, 60) && text(value.value, 400) && /^(manual$|[bo]:)/.test(value.value);
const empty = () => ({ version: 1, form: null, rounds: {} });

export function normalizeDrafts(value) {
  const result = empty();
  if (!plain(value) || value.version !== 1) return result;
  const form = value.form;
  if (plain(form) && text(form.prompt, 8000) && Array.isArray(form.proposers) && form.proposers.length >= 2 && form.proposers.length <= 4 && form.proposers.every(config) && config(form.reviewer)) {
    result.form = { prompt: form.prompt, proposers: form.proposers.map((item) => ({ label: item.label, value: item.value })), reviewer: { label: form.reviewer.label, value: form.reviewer.value } };
  }
  if (plain(value.rounds)) for (const [id, draft] of Object.entries(value.rounds).slice(-20)) {
    if (!uuid.test(id) || !plain(draft) || !text(draft.feedback, 4000) || !text(draft.executor, 100)) continue;
    const replies = {};
    if (plain(draft.replies)) for (const [jobId, reply] of Object.entries(draft.replies).slice(0, 7)) if (uuid.test(jobId) && text(reply, 16000)) replies[jobId] = reply;
    result.rounds[id] = { feedback: draft.feedback, executor: draft.executor,
      selected: Array.isArray(draft.selected) ? [...new Set(draft.selected.filter((id) => typeof id === 'string' && uuid.test(id)))].slice(0, 4) : [], replies };
  }
  return result;
}

export function createDraftStore(storage, root) {
  const key = `openbrowser.collaborationDrafts.v1:${encodeURIComponent(root)}`;
  return {
    load() {
      try { const raw = storage?.getItem(key); return raw && raw.length <= 2500000 ? normalizeDrafts(JSON.parse(raw)) : empty(); }
      catch { return empty(); }
    },
    save(value) {
      try {
        if (!storage) return false;
        const data = JSON.stringify(normalizeDrafts(value));
        if (data.length > 2500000) return false;
        storage.setItem(key, data); return true;
      } catch { return false; }
    },
  };
}
