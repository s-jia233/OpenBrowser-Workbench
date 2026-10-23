const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const slotPattern = new RegExp(`^(new|followup:${uuid}:\\d+|reply:${uuid}:\\d+:\\d+:[a-f0-9]{8})$`, 'i');
const limit = (slot) => slot.startsWith('reply:') ? 700000 : 16000;

export function followupDraftKey(task) { return `followup:${task.id}:${task.turns?.length || 0}`; }

export function replyDraftKey(task) {
  // A tool/context round can change the prompt without changing the attempt.
  // Fingerprint it so an earlier round's JSON is never silently restored here.
  let hash = 2166136261;
  const prompt = task.promptMessage || '';
  for (let index = 0; index < prompt.length; index++) hash = Math.imul(hash ^ prompt.charCodeAt(index), 16777619);
  return `reply:${task.id}:${task.turns?.length || 0}:${task.attempt || 0}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createTaskDraftStore(storage, root) {
  const prefix = `openbrowser.taskDrafts.v1:${encodeURIComponent(root)}:`;
  const memory = new Map();
  return {
    load(slot) {
      if (!slotPattern.test(slot)) return '';
      if (memory.has(slot)) return memory.get(slot);
      try {
        const raw = storage?.getItem(prefix + slot);
        if (!raw || raw.length > limit(slot) * 6 + 100) return '';
        const value = JSON.parse(raw);
        if (value?.version !== 1 || typeof value.text !== 'string' || value.text.length > limit(slot)) return '';
        memory.set(slot, value.text); return value.text;
      } catch { return ''; }
    },
    save(slot, text) {
      if (!slotPattern.test(slot) || typeof text !== 'string' || text.length > limit(slot)) return false;
      memory.set(slot, text);
      try {
        if (!storage) return false;
        if (text) storage.setItem(prefix + slot, JSON.stringify({ version: 1, text }));
        else storage.removeItem(prefix + slot);
        return true;
      } catch { return false; }
    },
    clearTask(id) {
      const belongs = (slot) => slot.startsWith(`followup:${id}:`) || slot.startsWith(`reply:${id}:`);
      for (const slot of memory.keys()) if (belongs(slot)) memory.set(slot, '');
      try {
        if (!storage) return false;
        const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
        for (const key of keys) if (key?.startsWith(prefix) && belongs(key.slice(prefix.length))) storage.removeItem(key);
        return true;
      } catch { return false; }
    },
  };
}
