const BRIDGE_URL = 'http://127.0.0.1:5000';
const RECONNECT_MS = 2500;
const DISPATCH_RETRY_MS = 1500;
const MAX_DISPATCH_ATTEMPTS = 12;
const KEEPALIVE_ALARM = 'openbrowser-keepalive';

const AI_URL_PATTERNS = [
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://gemini.google.com/*',
  'https://chat.deepseek.com/*',
  'https://claude.ai/*',
  'https://www.perplexity.ai/*',
  'https://perplexity.ai/*',
  'https://chat.z.ai/*',
  'https://glm.ai/*',
  'https://open.bigmodel.cn/*',
  'https://grok.com/*',
  'https://x.com/*',
];

let streamAbort = null;
let sseConnected = false;
let connecting = false;
let reconnectTimer = null;
let lastStreamActivity = 0;
let pulsing = false;
let readyPageCount = 0;
const dispatching = new Set();
const clientIdPromise = chrome.storage.local.get('bridgeClientId').then(async (saved) => {
  if (saved.bridgeClientId) return saved.bridgeClientId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ bridgeClientId: id });
  return id;
});

/** @type {Map<number, { host: string, lastSeen: number }>} */
const readyTabs = new Map();

/** @type {Array<{ job: object, attempts: number, nextTry: number }>} */
const pendingDispatches = [];

/** @type {Set<string>} */
const dispatchedSessionIds = new Set();

chrome.runtime.onInstalled.addListener(() => {
  setupKeepalive();
  void connectBridgeStream();
});

chrome.runtime.onStartup.addListener(() => {
  setupKeepalive();
  void connectBridgeStream();
});

setupKeepalive();
void connectBridgeStream();
void pulse();
setInterval(() => { void pulse(); }, 10_000);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) {
    return;
  }

  void pulse();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OPENBROWSER_REGISTER') {
    registerTab(sender.tab);
    void pulse();
    sendResponse({ ok: true, sseConnected, readyTabs: readyPageCount, identityReporting: true });
    return false;
  }

  if (message?.type === 'OPENBROWSER_PING') {
    void pulse();
    if (!sseConnected) {
      void connectBridgeStream();
    }
    sendResponse({ ok: true, sseConnected, readyTabs: readyPageCount, identityReporting: true });
    return false;
  }

  if (message?.type === 'BRIDGE_REQUEST') {
    const init = { ...(message.init ?? {}) };
    const request = async () => {
      if (['/browser/claim', '/browser/response', '/browser/chunk'].includes(message.path) && sender.tab?.url) {
        init.body = JSON.stringify({ ...JSON.parse(init.body ?? '{}'), providerHost: new URL(sender.tab.url).hostname,
          clientId: await clientIdPromise, tabId: sender.tab.id });
      }
      return bridgeRequest(message.path, init);
    };
    request()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

function setupKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

async function pulse() {
  if (pulsing) return;
  pulsing = true;
  try {
    if (sseConnected && Date.now() - lastStreamActivity > 40_000) streamAbort?.abort();
    if (!sseConnected && !connecting) void connectBridgeStream();
    const tabs = await getCandidateTabs();
    const results = await Promise.all(tabs.map(async (tab) => {
      try {
        return await Promise.race([
          chrome.tabs.sendMessage(tab.id, { type: 'OPENBROWSER_STATUS' }),
          new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
      } catch { readyTabs.delete(tab.id); return null; }
    }));
    const ready = tabs.filter((_tab, index) => results[index]?.ready);
    const count = ready.length;
    const readyHosts = ready.map((tab) => { try { return new URL(tab.url).hostname; } catch { return ''; } }).filter(Boolean).slice(0, 100);
    readyPageCount = count;
    const readyPages = ready.slice(0, 100).map((tab) => ({ tabId: tab.id, host: new URL(tab.url).hostname }));
    await bridgeRequest('/browser/heartbeat', { method: 'POST', body: JSON.stringify({ clientId: await clientIdPromise, readyTabs: Math.min(count, 100), readyHosts, readyPages }), signal: AbortSignal.timeout(5000) });
    await flushPendingDispatches();
  } catch { /* Local bridge may be starting; next pulse reconnects, no AI resend. */ }
  finally { pulsing = false; }
}

function registerTab(tab) {
  if (!tab?.id || !tab.url) {
    return;
  }

  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch {
    return;
  }

  readyTabs.set(tab.id, { host, lastSeen: Date.now() });
}

async function bridgeRequest(path, init) {
  const headers = {
    ...(init.headers ?? {}),
  };

  if (init.body && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers,
    // A stalled local response must not keep a content tab's job running
    // forever and prevent every later turn from reaching its editor.
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Bridge ${response.status}${text ? `: ${text}` : ''}`);
  }

  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectBridgeStream();
  }, RECONNECT_MS);
}

async function connectBridgeStream() {
  if (connecting || sseConnected) {
    return;
  }

  connecting = true;
  streamAbort?.abort();
  streamAbort = new AbortController();
  const connectionAbort = streamAbort;
  const headerTimeout = setTimeout(() => connectionAbort.abort(), 10_000);

  try {
    const response = await fetch(`${BRIDGE_URL}/browser/events?clientId=${encodeURIComponent(await clientIdPromise)}`, {
      signal: streamAbort.signal,
      headers: { Accept: 'text/event-stream' },
    });
    clearTimeout(headerTimeout);

    if (!response.ok || !response.body) {
      throw new Error(`SSE failed (${response.status})`);
    }

    sseConnected = true;
    lastStreamActivity = Date.now();
    console.info('[openbrowser] Bridge SSE connected');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      lastStreamActivity = Date.now();

      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSse(buffer, (event, data) => {
        if (event === 'job') {
          void dispatchJob(data);
        }
      });
    }

    throw new Error('SSE stream ended');
  } catch (error) {
    sseConnected = false;

    console.warn('[openbrowser] Bridge SSE disconnected, retrying...', error);
    scheduleReconnect();
  } finally {
    clearTimeout(headerTimeout);
    connecting = false;
  }
}

function consumeSse(buffer, onEvent) {
  const chunks = buffer.split('\n\n');
  const remainder = chunks.pop() ?? '';

  for (const chunk of chunks) {
    if (!chunk.trim() || chunk.startsWith(':')) {
      continue;
    }

    let event = 'message';
    let dataLine = '';

    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLine = line.slice(5).trim();
      }
    }

    if (!dataLine) {
      continue;
    }

    try {
      onEvent(event, JSON.parse(dataLine));
    } catch {
      // Ignore malformed SSE payloads.
    }
  }

  return remainder;
}

async function dispatchJob(job) {
  if (!job?.sessionId) {
    return;
  }
  if (job.target && job.target.clientId !== await clientIdPromise) return;

  if (dispatchedSessionIds.has(job.sessionId) || dispatching.has(job.sessionId)) {
    return;
  }
  dispatching.add(job.sessionId);
  let delivered;
  try { delivered = await tryDispatchJob(job); }
  finally { dispatching.delete(job.sessionId); }
  if (delivered) {
    dispatchedSessionIds.add(job.sessionId);
    return;
  }

  queuePendingDispatch(job);
}

function queuePendingDispatch(job) {
  const exists = pendingDispatches.some((entry) => entry.job.sessionId === job.sessionId);
  if (exists) {
    return;
  }

  pendingDispatches.push({
    job,
    attempts: 0,
    nextTry: Date.now() + DISPATCH_RETRY_MS,
  });
}

async function flushPendingDispatches() {
  const now = Date.now();

  for (let index = pendingDispatches.length - 1; index >= 0; index -= 1) {
    const entry = pendingDispatches[index];
    if (entry.nextTry > now) {
      continue;
    }

    const delivered = await tryDispatchJob(entry.job);
    if (delivered) {
      dispatchedSessionIds.add(entry.job.sessionId);
      pendingDispatches.splice(index, 1);
      continue;
    }

    entry.attempts += 1;
    entry.nextTry = now + DISPATCH_RETRY_MS;

    if (entry.attempts >= MAX_DISPATCH_ATTEMPTS) {
      console.warn('[openbrowser] Gave up dispatching job', entry.job.sessionId);
      pendingDispatches.splice(index, 1);
      await bridgeRequest('/browser/response', { method: 'POST', body: JSON.stringify({ sessionId: entry.job.sessionId, ...entry.job.target, error: '没有找到指定的就绪 AI 页面，请打开并登录该网页、刷新后继续，或改用手动传递。' }) });
    }
  }
}

async function tryDispatchJob(job) {
  const tabs = await getCandidateTabs();

  for (const tab of tabs) {
    if (job.target && (job.target.clientId !== await clientIdPromise || job.target.tabId !== tab.id)) continue;
    if (!tab.id) {
      continue;
    }

    try {
      const status = await chrome.tabs.sendMessage(tab.id, { type: 'OPENBROWSER_STATUS' });
      if (!status?.ready) continue;
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'OPENBROWSER_JOB',
        job,
      });

      if (response?.ok === true) {
        return true;
      }
    } catch {
      readyTabs.delete(tab.id);
    }
  }

  return false;
}

async function getCandidateTabs() {
  const [aiTabs, activeTabs] = await Promise.all([
    chrome.tabs.query({ url: AI_URL_PATTERNS }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  const active = activeTabs[0];
  const activeAi = active?.id && aiTabs.some((tab) => tab.id === active.id) ? active : null;

  const registered = aiTabs
    .filter((tab) => tab.id && readyTabs.has(tab.id))
    .sort((left, right) => {
      const leftSeen = readyTabs.get(left.id)?.lastSeen ?? 0;
      const rightSeen = readyTabs.get(right.id)?.lastSeen ?? 0;
      return rightSeen - leftSeen;
    });

  const ordered = [];
  const seen = new Set();

  const push = (tab) => {
    if (!tab?.id || seen.has(tab.id)) {
      return;
    }
    seen.add(tab.id);
    ordered.push(tab);
  };

  push(activeAi);
  for (const tab of registered) {
    push(tab);
  }
  for (const tab of aiTabs) {
    push(tab);
  }

  return ordered;
}
