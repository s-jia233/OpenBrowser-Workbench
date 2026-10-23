const RESPONSE_TIMEOUT_MS = 180_000;
const STABLE_MS = 2_000;
const ASK_STABLE_MS = 3_000;
const ASK_DRAFT_STABLE_MS = 5_000;
const POLL_MS = 400;
const CHUNK_MIN_CHARS = 24;
const CHUNK_MIN_MS = 250;
const SEND_RETRY_MS = 250;
const SEND_MAX_RETRIES = 20;
const SEND_CONFIRM_TIMEOUT_MS = 5_000;
const FILE_UPLOAD_SEND_WAIT_MS = 5_000;
const FILE_UPLOAD_SEND_RETRY_WAIT_MS = 8_000;
const FINISH_RECHECK_MS = 600;

let running = false;
let activeJob = null;
const processedSessionIds = new Set();
const jobQueue = [];
let apiCapture = null;

const provider = getProviderForHost(location.hostname);
const isChatGpt = provider?.name === 'ChatGPT';
const isGemini = provider?.name === 'Gemini';
const isDeepSeek = provider?.name === 'DeepSeek';
const usesApiCapture = isChatGpt || isGemini || isDeepSeek;

void registerWithBackground();
// A page heartbeat also wakes a suspended MV3 worker while a supported AI tab
// is open. It does not send prompts or bypass provider limits.
setInterval(() => { void registerWithBackground(); void reconcileActiveJob(); }, 10_000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void registerWithBackground();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'OPENBROWSER_STATUS') {
    sendResponse({ ready: Boolean(provider && findPromptInput()), running, providerHost: location.hostname });
    return false;
  }
  if (message?.type === 'OPENBROWSER_JOB' || message?.type === 'OPENBROWSER_RUN_JOB') {
    if (!provider || !findPromptInput()) { sendResponse({ ok: false, error: 'AI page is not ready' }); return false; }
    // Acknowledge receipt now; claiming remains atomic on the server. Do not
    // hold a runtime message open for the entire model generation.
    sendResponse({ ok: true });
    void handleIncomingJob(message.job)
      .catch((error) => console.warn('[openbrowser] Job failed', error));
    return false;
  }

  return false;
});

const API_CAPTURE_SOURCES = [
  'openbrowser-chatgpt-api',
  'openbrowser-gemini-api',
  'openbrowser-deepseek-api',
];

window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data;
  if (!data || !API_CAPTURE_SOURCES.includes(data.source)) {
    return;
  }
  handleApiCaptureMessage(data);
});

function beginApiCapture(mode, sessionId) {
  if (apiCapture?.timer) {
    clearTimeout(apiCapture.timer);
  }
  apiCapture = {
    mode,
    sessionId,
    candidates: new Map(),
    startedAt: Date.now(),
    resolve: null,
    reject: null,
    timer: null,
    lastChunkText: '',
    lastChunkAt: 0,
    failure: null,
  };
}

function endApiCapture() {
  if (apiCapture?.timer) {
    clearTimeout(apiCapture.timer);
  }
  apiCapture = null;
}

function waitForApiCapturedResponse() {
  return new Promise((resolve, reject) => {
    if (activeJob?.cancelled) { reject(activeJob.reason); return; }
    if (!apiCapture) {
      reject(new Error('AI API capture was not started.'));
      return;
    }
    apiCapture.resolve = resolve;
    apiCapture.reject = reject;
    if (apiCapture.failure && !apiCapture.candidates.size) { const failure = apiCapture.failure; endApiCapture(); reject(failure); return; }
    apiCapture.timer = setTimeout(() => {
      const capture = apiCapture;
      apiCapture = null;
      if (capture) {
        reject(new Error('Timed out waiting for the AI provider API response.'));
      }
    }, RESPONSE_TIMEOUT_MS);
    finishApiCapture();
  });
}

function finishApiCapture() {
  if (!apiCapture?.resolve) return;
  const candidate = [...apiCapture.candidates.values()].find((entry) => entry.done && entry.text);
  if (!candidate) return;
  const resolve = apiCapture.resolve;
  const text = candidate.text;
  apiCapture.replyMessageId = candidate.messageId ?? null;
  endApiCapture(); resolve(text);
}

function bestApiCaptureText() {
  let best = '';
  for (const candidate of apiCapture.candidates.values()) {
    if (candidate.text.length > best.length) {
      best = candidate.text;
    }
  }
  return best;
}

function postBestApiChunk() {
  if (apiCapture.mode !== 'ask') {
    return;
  }
  const text = bestApiCaptureText();
  if (!text || text === apiCapture.lastChunkText) {
    return;
  }
  if (
    text.length - apiCapture.lastChunkText.length >= CHUNK_MIN_CHARS ||
    Date.now() - apiCapture.lastChunkAt >= CHUNK_MIN_MS
  ) {
    apiCapture.lastChunkText = text;
    apiCapture.lastChunkAt = Date.now();
    void postBrowserChunk({ sessionId: apiCapture.sessionId, text });
  }
}

function handleApiCaptureMessage(data) {
  if (!apiCapture) {
    return;
  }

  if (data.type === 'capture-begin') {
    if ((data.at ?? 0) >= apiCapture.startedAt && !apiCapture.candidates.has(data.captureId)) {
      apiCapture.candidates.set(data.captureId, { text: '', done: false });
      apiCapture.failure = null;
    }
    return;
  }

  const candidate = apiCapture.candidates.get(data.captureId);
  if (!candidate) {
    return;
  }
  // Only metadata from a capture begun in this local turn may bind a DOM
  // reply. A conversation ID alone cannot distinguish consecutive turns.
  if (isChatGpt && ['capture-chunk', 'capture-done'].includes(data.type)
    && Object.prototype.hasOwnProperty.call(data, 'messageId')) {
    candidate.messageId = typeof data.messageId === 'string' && data.messageId.length > 0 && data.messageId.length <= 200
      ? data.messageId : null;
  }

  if (data.type === 'capture-chunk') {
    if (typeof data.text === 'string') {
      candidate.text = data.text;
    }
    postBestApiChunk();
    return;
  }

  if (data.type === 'capture-done') {
    // Final text is authoritative even if shorter than an earlier snapshot.
    candidate.text = typeof data.text === 'string' ? data.text : '';
    candidate.done = true;
    if (!candidate.text) {
      if (apiCapture.candidates.size === 1) apiCapture.replyMessageId = candidate.messageId ?? null;
      apiCapture.candidates.delete(data.captureId);
      if (!apiCapture.candidates.size) {
        apiCapture.failure = new Error('网页回复已经结束，但扩展未识别到回复正文，已释放本轮等待。请保存网页完整回复，可改用手动传递；不会自动重发。');
        apiCapture.failure.captureCompleted = true;
        if (apiCapture.reject) { const reject = apiCapture.reject, failure = apiCapture.failure; endApiCapture(); reject(failure); }
      }
      return;
    }
    finishApiCapture();
    return;
  }

  if (data.type === 'capture-error') {
    apiCapture.candidates.delete(data.captureId);
    if (!apiCapture.candidates.size) {
      apiCapture.failure = new Error('模型回复流中断，未将不完整内容视为最终回复。请检查 AI 网页或手动粘贴完整回复。');
      if (apiCapture.reject) { const reject = apiCapture.reject, failure = apiCapture.failure; endApiCapture(); reject(failure); }
    }
  }
}

async function handleIncomingJob(job) {
  if (!job?.sessionId || processedSessionIds.has(job.sessionId)) {
    return;
  }

  if (running) {
    if (!jobQueue.some((entry) => entry.sessionId === job.sessionId)) jobQueue.push(job);
    // A manually stopped/replied-to task can be terminal locally while this
    // tab still waits for an uncaptured answer. Do not strand the follow-up.
    await reconcileActiveJob();
    return;
  }

  try { await runJob(job); }
  finally { await drainJobQueue(); }
}

async function reconcileActiveJob() {
  const active = activeJob;
  if (!active || active.checking || active.cancelled) return;
  active.checking = true;
  try {
    const state = await bridgeRequest(`/session/${encodeURIComponent(active.sessionId)}/status`);
    if (activeJob !== active || !['complete', 'error'].includes(state?.status)) return;
    active.cancelled = true;
    active.reason = new Error('本地上一轮任务已结束，已停止扩展等待；没有停止 AI 网页中的生成。');
    for (const cancel of [...active.waiters]) cancel();
    if (apiCapture?.sessionId === active.sessionId) {
      const reject = apiCapture.reject;
      endApiCapture();
      reject?.(active.reason);
    }
  } catch {
    // A disconnected bridge is not proof a live AI request was cancelled.
  } finally { active.checking = false; }
}

async function drainJobQueue() {
  while (!running && jobQueue.length > 0) {
    const next = jobQueue.shift();
    if (!next || processedSessionIds.has(next.sessionId)) {
      continue;
    }
    await runJob(next);
  }
}

async function runJob(job) {
  if (!provider) {
    return;
  }

  running = true;
  const active = { sessionId: job.sessionId, cancelled: false, reason: null, checking: false, waiters: new Set() };
  activeJob = active;
  try {
    let claim = await claimJob(job.sessionId);

    if (!claim.claimed || !claim.job || active.cancelled) {
      // Duplicate replay or another tab already claimed it. Never fail a job
      // owned by that tab, and never submit its prompt a second time.
      return;
    }

    processedSessionIds.add(job.sessionId);
    await processJob(claim.job);
  } catch (error) {
    if (!active.cancelled) {
      try { await postBrowserResponse({ sessionId: job.sessionId, error: String(error) }); }
      catch (reportError) { console.warn('[openbrowser] Could not report job failure; releasing tab queue', reportError); }
    }
  } finally {
    endApiCapture();
    if (activeJob === active) activeJob = null;
    running = false;
  }
}

async function registerWithBackground() {
  if (!provider) {
    return;
  }

  try {
    await sendRuntimeMessage({ type: 'OPENBROWSER_REGISTER' });
  } catch {
    setTimeout(registerWithBackground, 2000);
  }
}

async function sendRuntimeMessage(message) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      lastError = error;
      await sleep(250 * (attempt + 1));
    }
  }

  throw lastError ?? new Error('Extension background is not available');
}

async function bridgeRequest(path, init = {}) {
  const result = await sendRuntimeMessage({
    type: 'BRIDGE_REQUEST',
    path,
    init,
  });

  if (!result?.ok) {
    throw new Error(result?.error ?? 'Bridge request failed');
  }

  return result.data;
}

async function claimJob(sessionId) {
  return bridgeRequest('/browser/claim', {
    method: 'POST',
    body: JSON.stringify({ sessionId, providerHost: location.hostname }),
  });
}

async function processJob(job) {
  await waitForComposerReady();
  const beforeCount = countAssistantMessages();
  const threadIsEmpty = beforeCount === 0;
  const chatGptTurn = isChatGpt ? snapshotChatGptTurn() : null;

  if (usesApiCapture) {
    beginApiCapture(job.mode, job.sessionId);
  }

  if (job.delivery === 'file') {
    const composerMessage = job.composerMessage ?? job.message;
    const attached = await attachPromptFile(job);
    if (!attached) {
      const filePayload = await bridgeRequest(`/browser/prompt-file/${job.sessionId}`);
      const fullMessage = String(filePayload?.content ?? '');
      if (!fullMessage) {
        throw new Error('Prompt file from bridge server was empty.');
      }
      await injectPrompt(fullMessage);
      if (chatGptTurn) chatGptTurn.expectedPrompt = fullMessage;
      await sleep(150);
      await clickSendWhenReady(fullMessage);
    } else {
      if (chatGptTurn) chatGptTurn.expectedPrompt = composerMessage;
      await clickSendAfterFileAttach(composerMessage);
    }
  } else {
    const outboundMessage = buildOutboundMessageForThread(job, threadIsEmpty);
    if (chatGptTurn) chatGptTurn.expectedPrompt = outboundMessage;
    await injectPrompt(outboundMessage);
    await sleep(150);
    await clickSendWhenReady(outboundMessage);
  }

  const text = isChatGpt
    ? await receiveChatGptReply(job, chatGptTurn)
    : usesApiCapture
    ? await waitForApiCapturedResponse()
    : await waitForPlainResponse(beforeCount, job.mode, job.sessionId, {
        markdownDraft: job.markdownDraft,
      });
  if (isChatGpt && job.mode === 'agent' && chatGptCaptureIsIncomplete(text)) {
    throw new Error('ChatGPT 回复捕获不完整，未将未闭合的 JSON 残片当成模型方案，也不会自动重发。请查看并保存网页完整回复，更新扩展后继续，或改用手动传递。');
  }
  if (job.mode === 'ask' && job.sessionId) {
    await postBrowserChunk({ sessionId: job.sessionId, text });
  }

  await postBrowserResponse({ sessionId: job.sessionId, text });
}

function chatGptExplicitMessageId(node) {
  // Both classic messages and the inspected DIL renderer expose stable IDs.
  // Never use CSS class hashes, text fragments or the conversation ID as a
  // substitute. Conflicting selection/source IDs are deliberately ambiguous.
  const ids = new Set();
  const add = (element, names) => {
    for (const name of names) {
      const value = element?.getAttribute?.(name);
      if (value) ids.add(value);
    }
  };
  add(node, ['data-message-id', 'data-chatgpt-selection-message-id', 'data-dil-message-id', 'data-dil-source-message-id']);
  add(node.closest?.('[data-chatgpt-selection-message-id]'), ['data-chatgpt-selection-message-id']);
  for (const child of node.querySelectorAll?.('[data-dil-message-id], [data-dil-source-message-id]') ?? []) {
    add(child, ['data-dil-message-id', 'data-dil-source-message-id']);
    if (ids.size > 1) return null;
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function chatGptMessageId(node) {
  const article = node.closest?.('article');
  const testId = article?.getAttribute?.('data-testid');
  return chatGptExplicitMessageId(node) || node.getAttribute?.('data-turn-id')
    || article?.getAttribute?.('data-turn-id') || (/^conversation-turn-\d+$/.test(testId ?? '') ? testId : null);
}

function collectChatGptMessages(role) {
  // Unlike generic provider fallback selectors, these are complementary:
  // old and new turn markup can coexist after SPA rendering. Never stop at
  // the first nonempty selector, and do not count a wrapper and its child twice.
  const selectors = [`[data-message-author-role="${role}"]`, `article[data-turn="${role}"]`, `[data-turn="${role}"][data-testid^="conversation-turn-"]`];
  if (role === 'assistant') selectors.push('[data-markdown-text-style="assistant-message"]');
  const nodes = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
  return nodes.filter((node) => !nodes.some((other) => other !== node && node.contains?.(other)))
    .sort((a, b) => {
      const position = a.compareDocumentPosition?.(b) ?? 0;
      return position & 1 ? 0 : position & 4 ? -1 : position & 2 ? 1 : 0;
    });
}

function collectChatGptUsers() {
  return collectChatGptMessages('user');
}

function chatGptPromptText(node) {
  return String(node?.innerText ?? node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function snapshotChatGptTurn() {
  const assistants = collectAssistantNodes(), users = collectChatGptUsers();
  return {
    assistants: new Set(assistants), assistantIds: new Set(assistants.map(chatGptMessageId).filter(Boolean)),
    users: new Set(users), userIds: new Set(users.map(chatGptMessageId).filter(Boolean)),
    assistantSnapshots: new Map(assistants.map((node) => [node, { id: chatGptMessageId(node) }])),
    userSnapshots: new Map(users.map((node) => [node, { id: chatGptMessageId(node), text: chatGptPromptText(node) }])),
  };
}

function chatGptNodeIsNew(node, nodes, ids, snapshots) {
  const id = chatGptMessageId(node);
  if (id && ids.has(id)) return false; // Includes remounted history.
  return !nodes.has(node) || Boolean(id && snapshots.get(node)?.id !== id);
}

function currentChatGptEnvelope(text, conversationId) {
  if (!conversationId || text.length > 700_000) return null;
  const found = new Map();
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (depth && char === '"') { inString = true; continue; }
    if (char === '{') { if (!depth) start = index; depth += 1; }
    else if (char === '}' && depth) {
      depth -= 1;
      if (!depth) {
        const candidate = text.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed.conversationId === conversationId && (Array.isArray(parsed.operations)
            || Array.isArray(parsed.toolRequests) || Array.isArray(parsed.contextRequests) || typeof parsed.error === 'string')) {
            found.set(JSON.stringify(parsed), candidate);
          }
        } catch { /* Never repair a damaged envelope or infer its source. */ }
      }
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

function readCurrentChatGptReply(job, baseline, capturedMessageId = null) {
  const allUsers = collectChatGptUsers(), assistants = collectAssistantNodes();
  const expected = baseline.expectedPrompt ? chatGptPromptText({ innerText: baseline.expectedPrompt }) : '';
  const users = allUsers.filter((node) => {
    if (chatGptNodeIsNew(node, baseline.users, baseline.userIds, baseline.userSnapshots)) return true;
    // React may reuse a message element. Only a changed, exact match to the
    // prompt actually sent can rebind it; arbitrary edits of history cannot.
    const previous = baseline.userSnapshots.get(node)
      ?? [...baseline.userSnapshots.values()].find((entry) => entry.id && entry.id === chatGptMessageId(node));
    return Boolean(expected && previous && previous.text !== expected && chatGptPromptText(node) === expected);
  });
  const counts = `用户节点 ${allUsers.length}，本轮提问 ${users.length}，助手节点 ${assistants.length}`;
  const matchedBy = users.length === 1 ? 'user' : 'none';
  const metrics = { users: allUsers.length, currentUsers: users.length, assistants: assistants.length, matchedBy };
  const empty = (reason, code, chars = 0) => ({ text: '', node: null, chars, reason, code, counts, metrics, busy: Boolean(findStopButton()), finished: false });
  if (users.length > 1) return empty('本轮提问节点不唯一', 'ambiguous_turn');
  const fresh = assistants.filter((node) => isElementVisible(node)
    && chatGptNodeIsNew(node, baseline.assistants, baseline.assistantIds, baseline.assistantSnapshots));
  const nodes = users.length === 1 ? fresh.filter((node) => {
    const position = users[0].compareDocumentPosition?.(node) ?? 0;
    return !(position & 1) && Boolean(position & 4);
  }) : fresh.filter((node) => capturedMessageId && chatGptExplicitMessageId(node) === capturedMessageId);
  // If no user anchor survives virtualization, require the exact assistant
  // message ID from this turn's completed passive capture, never just the CI.
  if (!users.length && nodes.length !== 1) return empty('未定位到本轮提问，且没有唯一匹配的本轮捕获消息编号', 'awaiting_turn');
  if (!users.length) metrics.matchedBy = 'stream_id';
  const node = nodes.at(-1);
  if (!node) return empty('未定位到本轮新回复', 'awaiting_answer');
  if (node.getAttribute?.('data-message-channel') === 'analysis' || node.getAttribute?.('data-channel') === 'analysis'
    || node.closest?.('details, [data-testid="reasoning"]')) return empty('未定位到本轮最终正文', 'analysis');
  const owner = node.closest?.('article') ?? node.closest?.('[data-chatgpt-selection-message-id]') ?? node;
  const streaming = [node, owner].some((entry) => ['true', ''].includes(entry.getAttribute?.('data-is-streaming')))
    || [...(owner.querySelectorAll?.('[data-is-streaming="true"], [data-is-streaming=""]') ?? [])].some(isElementVisible);
  const busy = Boolean(findStopButton() || streaming);
  // Read only the current assistant message. Do not scroll, copy to clipboard,
  // remove UI nodes, rewrite code fences, or reconstruct file source.
  // Read the complete semantic assistant root, never its first DIL word span.
  // The word spans are inline pieces of one reply, not separate messages.
  const root = node.getAttribute?.('data-markdown-text-style') === 'assistant-message' ? node
    : node.querySelector?.('[data-markdown-text-style="assistant-message"], .markdown, .markdown-new-styling, .prose') ?? node;
  if (root.closest?.('details, [data-testid="reasoning"], [data-message-channel="analysis"], [data-channel="analysis"]')) {
    return empty('未定位到独立的本轮最终正文', 'analysis');
  }
  if (root === node && node.querySelector?.('details, [data-testid="reasoning"], [data-message-channel="analysis"], [data-channel="analysis"]')) {
    return empty('最终正文与思考区域未能可靠区分', 'mixed_analysis');
  }
  const enabled = (button) => isElementVisible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  const actionFinished = [...(owner.querySelectorAll?.('button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"], button[data-testid="bad-response-turn-action-button"]') ?? [])].some(enabled);
  // Localized action buttons may not have test IDs. Only accept exact footer
  // labels outside the answer body; a code block's Copy button is not an end signal.
  const footerFinished = root !== owner && [...(owner.querySelectorAll?.('button[aria-label], button[title]') ?? [])].some((button) =>
    !root.contains?.(button) && !button.closest?.('pre, code, [data-testid="reasoning"], details') && enabled(button)
    && ['Copy', 'Copy response', '复制', '复制回复', '复制回答', '複製', '複製回覆'].some((label) =>
      [button.getAttribute('aria-label'), button.getAttribute('title')].includes(label)));
  const explicitlyFinished = [node, owner].some((entry) => entry.getAttribute?.('data-is-streaming') === 'false');
  const finished = !busy && (actionFinished || footerFinished || explicitlyFinished);
  const raw = root.innerText ?? root.textContent ?? '';
  const text = job.mode === 'agent' ? currentChatGptEnvelope(raw, job.conversationId) : raw.trim();
  return { text: text ?? '', node, chars: raw.length, reason: text ? '' : '正文尚未形成唯一的本会话完整 JSON', code: text ? null : 'invalid_json', counts, metrics, busy, finished };
}

async function receiveChatGptReply(job, baseline, options = {}) {
  const capture = apiCapture; // Retain only this turn's metadata after waiter cleanup.
  const stream = { state: 'pending', text: '', error: null };
  void waitForApiCapturedResponse().then((text) => {
    stream.state = 'done'; stream.text = text;
  }, (error) => {
    stream.state = 'error'; stream.error = error;
  });
  const startedAt = Date.now(), deadline = startedAt + (options.timeoutMs ?? RESPONSE_TIMEOUT_MS);
  let stableSince = 0, lastText = '', lastNode = null, lastPage = { chars: 0, reason: '未取得本轮正文' };
  let lastReportAt = -Infinity, lastReportState = '';
  const report = (page, reason) => {
    const now = Date.now(), signature = `${reason}|${stream.state}`;
    if (now - lastReportAt < 1000 || (signature === lastReportState && now - lastReportAt < 5000)) return;
    if (activeJob?.cancelled) return;
    lastReportAt = now; lastReportState = signature;
    const clamp = (value, limit) => Math.max(0, Math.min(limit, Math.floor(value ?? 0)));
    const reception = {
      version: chrome.runtime.getManifest?.().version ?? '0.0.0',
      elapsedMs: clamp(now - startedAt, 3_600_000), stream: stream.state,
      streamChars: clamp(Math.max(stream.text.length, ...[...(capture?.candidates.values() ?? [])].map((entry) => entry.text.length)), 10_000_000), pageChars: clamp(page.chars, 10_000_000),
      users: clamp(page.metrics?.users, 100_000), currentUsers: clamp(page.metrics?.currentUsers, 100_000),
      assistants: clamp(page.metrics?.assistants, 100_000), matchedBy: page.metrics?.matchedBy ?? 'none',
      reason, busy: Boolean(page.busy), finished: Boolean(page.finished),
    };
    // Metadata only, best effort. Diagnostic failures must not block receiving
    // or send another model request. Existing source-tab checks still apply.
    void bridgeRequest('/browser/chunk', { method: 'POST', body: JSON.stringify({ sessionId: job.sessionId, reception }) }).catch(() => {});
  };
  try {
    while (Date.now() < deadline) {
      if (activeJob?.cancelled) throw activeJob.reason;
      // A complete, matching stream envelope is independent of DOM layout.
      const validStream = stream.state === 'done' && stream.text.trim() && (job.mode === 'agent'
        ? currentChatGptEnvelope(stream.text, job.conversationId) : !chatGptCaptureIsIncomplete(stream.text));
      if (validStream && job.mode === 'agent') { report({}, 'returning'); return stream.text; }
      let page;
      try { page = readCurrentChatGptReply(job, baseline, capture?.replyMessageId); }
      catch {
        page = { text: '', node: null, chars: 0, reason: '未识别到本轮网页正文结构', code: 'structure_unknown', busy: Boolean(findStopButton()), finished: false };
      }
      lastPage = page;
      if (validStream && !page.text) { report(page, 'returning'); return stream.text; }
      report(page, page.busy ? 'generating' : page.code ?? (stream.state === 'done' || stream.error?.captureCompleted || page.finished ? 'settling' : 'awaiting_completion'));
      if (page.text && !page.busy && (stream.state === 'done' || stream.error?.captureCompleted || page.finished)) {
        if (page.text !== lastText || page.node !== lastNode) {
          lastText = page.text; lastNode = page.node; stableSince = Date.now();
        } else if (Date.now() - stableSince >= STABLE_MS) {
          console.info('[openbrowser] Reply recovered from current page', { streamChars: stream.text.length, pageChars: page.chars });
          return page.text;
        }
      } else { lastText = ''; lastNode = null; stableSince = 0; }
      // A partial capture ending is not evidence that the page has finished
      // rendering. Keep the bounded 3-minute wait even when its user anchor or
      // localized generation control is temporarily unavailable.
      await sleep(POLL_MS);
    }
    throw new Error(`ChatGPT 回复捕获不完整：已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒，流式片段 ${stream.text.length} 字，本轮网页正文 ${lastPage.chars} 字；${lastPage.reason || '未确认正文稳定且生成结束'}；${lastPage.counts ?? '消息节点统计不可用'}。未猜补内容，也不会自动重发。请保存完整回复，或改用手动传递。`);
  } finally {
    const pending = apiCapture;
    if (pending?.sessionId === job.sessionId) {
      endApiCapture();
      // Settle the unused waiter on page recovery/timeout so its timer and
      // closures cannot hold the tab's previous turn alive.
      pending.resolve?.('');
    }
  }
}

function chatGptCaptureIsIncomplete(text) {
  const candidate = String(text).trim().replace(/^<escape>\s*/, '').replace(/^```(?:json)?\s*/i, '');
  if (!candidate.startsWith('{')) return false;
  let depth = 0, inString = false, escaped = false;
  for (const char of candidate) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') { depth -= 1; if (depth <= 0) return false; }
  }
  // This check never repairs or executes a proposal. All complete replies
  // still go through the server's protocol/path/Diff approval validation.
  return depth > 0 || inString;
}

function buildOutboundMessageForThread(job, threadIsEmpty) {
  const message = String(job?.message ?? '');
  if (!threadIsEmpty || !job?.systemPrompt) {
    return message;
  }

  if (message.includes('--- OpenBrowser System Instructions ---')) {
    return message;
  }

  return [
    '--- OpenBrowser System Instructions ---',
    String(job.systemPrompt),
    '--- End System Instructions ---',
    '',
    message,
  ].join('\n');
}

const MAX_ATTACH_ATTEMPTS = 2;
const ATTACH_PREVIEW_POLL_MS = 300;
const ATTACH_PREVIEW_TIMEOUT_MS = 2_500;
const ATTACH_SHADOW_MAX_DEPTH = 4;

let attachShadowRoots = null;

function clearAttachDomCache() {
  attachShadowRoots = null;
}

function getAttachShadowRoots() {
  if (attachShadowRoots) {
    return attachShadowRoots;
  }

  const roots = [];
  const queue = [{ root: document, depth: 0 }];

  while (queue.length > 0) {
    const { root, depth } = queue.shift();
    if (depth >= ATTACH_SHADOW_MAX_DEPTH) {
      continue;
    }

    const elements = root.querySelectorAll?.('*') ?? [];
    for (const element of elements) {
      if (!element.shadowRoot) {
        continue;
      }

      roots.push(element.shadowRoot);
      queue.push({ root: element.shadowRoot, depth: depth + 1 });
    }
  }

  attachShadowRoots = roots;
  return roots;
}

function queryFirstForAttach(selectors, root = document) {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];

  for (const selector of selectorList) {
    const node = root.querySelector?.(selector);
    if (node) {
      return node;
    }
  }

  for (const shadowRoot of getAttachShadowRoots()) {
    for (const selector of selectorList) {
      const node = shadowRoot.querySelector?.(selector);
      if (node) {
        return node;
      }
    }
  }

  return null;
}

function isPromptAlreadyAttached(fileName) {
  return hasUploadUiSignal(fileName);
}

async function attachPromptFile(job) {
  clearAttachDomCache();

  const fileName = job.promptFileName ?? 'openbrowser-prompt.txt';
  const filePayload = await bridgeRequest(`/browser/prompt-file/${job.sessionId}`);
  const content = String(filePayload?.content ?? '');

  if (!content) {
    throw new Error('Prompt file from bridge server was empty.');
  }

  if (isPromptAlreadyAttached(fileName)) {
    return true;
  }

  const file = new File([content], fileName, { type: 'text/plain' });
  const fileSelectors = provider?.selectors?.fileInput ?? ['input[type="file"]'];

  if (await tryAttachOnBestInput(file, fileName, fileSelectors)) {
    return true;
  }

  for (let attempt = 1; attempt < MAX_ATTACH_ATTEMPTS; attempt += 1) {
    if (isPromptAlreadyAttached(fileName)) {
      return true;
    }

    await openUploadMenuForProvider(fileName);
    await sleep(700);

    if (await tryAttachOnBestInput(file, fileName, fileSelectors)) {
      return true;
    }
  }

  return waitForAttachComplete(fileName);
}

async function tryAttachOnBestInput(file, fileName, fileSelectors) {
  if (isPromptAlreadyAttached(fileName)) {
    return true;
  }

  const fileInput = findBestFileInput(fileSelectors);
  if (!fileInput) {
    return false;
  }

  return trySetFileAndConfirm(fileInput, file, fileName);
}

function findBestFileInput(selectors) {
  for (const selector of selectors) {
    const node = queryFirstForAttach(selector);
    if (node instanceof HTMLInputElement && node.type === 'file' && !node.disabled) {
      return node;
    }
  }

  return null;
}

async function openUploadMenuForProvider(fileName) {
  if (isPromptAlreadyAttached(fileName)) {
    return;
  }

  const host = location.hostname;

  if (host.includes('chatgpt.com') || host.includes('openai.com')) {
    clickElement(
      queryFirstForAttach([
        'button[data-testid="composer-plus-btn"]',
        'button[aria-label="Add files and more"]',
        'button.composer-btn[data-testid="composer-plus-btn"]',
      ]),
    );
    await sleep(500);
    clickElement(
      findClickableByText([
        'add photos & files',
        'add photos and files',
        'upload file',
        'attach file',
        'add files',
      ]),
    );
    return;
  }

  if (host.includes('gemini.google.com')) {
    const existingInput = findBestFileInput([
      'images-files-uploader input[type="file"]',
      ...(provider?.selectors?.fileInput ?? ['input[type="file"]']),
    ]);
    if (existingInput) {
      return;
    }

    clickElement(
      queryFirstForAttach([
        'button[aria-label="Open upload file menu"]',
        'button.upload-card-button',
        'button[aria-label*="Upload" i]',
        'button[aria-label*="Attach" i]',
        '.leading-actions-wrapper button',
      ]),
    );
    await sleep(500);

    if (isPromptAlreadyAttached(fileName)) {
      return;
    }

    clickElement(
      queryFirstForAttach(provider?.selectors?.attachMenuSelectors ?? []) ??
        findClickableByText(['files', 'upload file', 'add file']),
    );
    return;
  }

  if (host.includes('deepseek.com')) {
    clickElement(
      queryFirstForAttach([
        'div.ds-button.ds-button--iconLabelPrimary.ds-button--icon.ds-button--capsule[role="button"]',
        'div.ds-button.ds-button--icon.ds-button--capsule.ds-button--s[role="button"]',
        'input[type="file"] + div[role="button"]',
      ]),
    );
    return;
  }

  if (host.includes('perplexity.ai')) {
    clickElement(queryFirstForAttach(provider?.selectors?.attachButton ?? []));
    await sleep(500);

    if (isPromptAlreadyAttached(fileName)) {
      return;
    }

    clickElement(
      findClickableByText([
        'upload files or images',
        'upload files',
        'upload file',
        'attach file',
      ]),
    );
    return;
  }

  clickElement(queryFirstForAttach(provider?.selectors?.attachButton ?? []));
  await sleep(500);

  if (isPromptAlreadyAttached(fileName)) {
    return;
  }

  clickElement(findClickableByText(provider?.selectors?.attachMenuText ?? ['upload', 'file']));
}

async function trySetFileAndConfirm(fileInput, file, fileName) {
  if (isPromptAlreadyAttached(fileName)) {
    return true;
  }

  if (!(await setFileOnInput(fileInput, file))) {
    return false;
  }

  const deadline = Date.now() + ATTACH_PREVIEW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isPromptAlreadyAttached(fileName)) {
      return true;
    }

    if (fileInput.files?.length > 0) {
      return true;
    }

    await sleep(ATTACH_PREVIEW_POLL_MS);
  }

  return isPromptAlreadyAttached(fileName);
}

function hasUploadUiSignal(fileName) {
  if (hasAttachmentPreview(fileName)) {
    return true;
  }

  const composerRoot =
    findPromptInput()?.closest(
      'form, [class*="composer"], [class*="input-area"], [class*="chat-input"], uploader-file-preview',
    ) ?? null;

  if (!composerRoot) {
    return false;
  }

  const text = (composerRoot.textContent ?? '').toLowerCase();
  const baseName = fileName.replace(/\.[^.]+$/, '').toLowerCase();

  return (
    text.includes('openbrowser-prompt') ||
    text.includes(baseName) ||
    text.includes('.txt')
  );
}

async function setFileOnInput(fileInput, file) {
  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;

    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertFromPaste',
        dataTransfer,
      }),
    );
    await sleep(400);
    return fileInput.files?.length > 0;
  } catch {
    return false;
  }
}

function hasAttachmentPreview(fileName) {
  const previewSelectors = provider?.selectors?.attachmentPreview ?? [
    'gem-attachment',
    'uploader-file-preview',
    '.f3a54b52',
    '._76cd190',
    '[data-testid="file-name"]',
  ];

  if (queryFirstForAttach(previewSelectors)) {
    return true;
  }

  const composerRoot =
    findPromptInput()?.closest(
      'form, [class*="composer"], [class*="input-area"], [class*="chat-input"], uploader-file-preview',
    ) ?? null;

  if (!composerRoot) {
    return false;
  }

  const baseName = fileName.replace(/\.[^.]+$/, '').toLowerCase();
  const previewNode = composerRoot.querySelector?.(
    '.gem-attachment-text, .f3a54b52, [data-testid="file-name"], .gem-attachment-extension-label, gem-attachment, uploader-file-preview',
  );

  if (!previewNode) {
    return false;
  }

  const text = (previewNode.textContent ?? '').trim().toLowerCase();
  return (
    text.includes(baseName) ||
    text.includes('txt') ||
    text.includes('openbrowser-prompt') ||
    text.includes('.txt')
  );
}

async function waitForAttachComplete(fileName) {
  const deadline = Date.now() + ATTACH_PREVIEW_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (isPromptAlreadyAttached(fileName)) {
      return true;
    }
    await sleep(ATTACH_PREVIEW_POLL_MS);
  }

  return isPromptAlreadyAttached(fileName);
}

async function injectPrompt(message, options = {}) {
  const preserveAttachments = options.preserveAttachments === true;
  const input = findPromptInput();
  if (!input) {
    throw new Error('未找到可编辑的 AI 输入框。请打开已登录的聊天页，刷新页面后重试。');
  }
  if (findStopButton()) {
    throw new Error('AI 网页仍在生成回复，本次未发送。请等待回复结束后手动重试。');
  }
  if (hasComposerContent(input) && !hasInjectedContent(input, message)) {
    throw new Error('AI 输入框已有其他草稿，本次未覆盖、未发送。请先保存或清空网页草稿后重试。');
  }

  input.focus();
  await sleep(100);
  // Focus can mount a new editor; also recheck for user edits during the wait.
  if (findPromptInput() !== input || (hasComposerContent(input) && !hasInjectedContent(input, message))) {
    throw new Error('AI 输入框或草稿发生变化，本次未覆盖、未发送。请检查网页后手动重试。');
  }

  const method = provider?.inject ?? (input instanceof HTMLTextAreaElement ? 'textarea' : 'prose-mirror');

  if (method === 'textarea' || input instanceof HTMLTextAreaElement) {
    await injectTextarea(input, message, { preserveAttachments });
    return;
  }

  if (method === 'lexical' || input.getAttribute('data-lexical-editor') === 'true') {
    await injectLexical(input, message, { preserveAttachments });
    return;
  }

  if (input.isContentEditable) {
    await injectProseMirror(input, message, { preserveAttachments });
    return;
  }

  throw new Error('Unsupported chat input element.');
}

async function injectTextarea(element, text, options = {}) {
  element.focus();
  if (options.preserveAttachments && hasInjectedContent(element, text)) {
    return;
  }
  // Do not assign element.value again: that can mark a controlled input's
  // tracker as current before its input event and leave Send disabled.
  const prototype = window.HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (!descriptor?.set) {
    throw new Error('无法写入网页输入框。请刷新 AI 页面，或使用手动发送。');
  }
  descriptor.set.call(element, text);
  dispatchInput(element, text);
  await sleep(50);
  assertInjectedContent(element, text);
}

async function injectLexical(element, text, options = {}) {
  const preserveAttachments = options.preserveAttachments === true;
  element.focus();
  if (preserveAttachments && hasInjectedContent(element, text)) {
    return;
  }
  if (!preserveAttachments) {
    clearComposer(element);
    await sleep(50);
  } else {
    moveCaretToEnd(element);
    await sleep(50);
  }

  dispatchPaste(element, text);
  await sleep(100);

  if (!hasInjectedContent(element, text)) {
    selectAll(element);
    document.execCommand('insertText', false, text);
    await sleep(100);
  }

  assertInjectedContent(element, text);
}

async function injectProseMirror(element, text, options = {}) {
  const preserveAttachments = options.preserveAttachments === true;
  element.focus();
  if (preserveAttachments && hasInjectedContent(element, text)) {
    return;
  }
  if (!preserveAttachments) {
    clearComposer(element);
    await sleep(50);
  } else {
    moveCaretToEnd(element);
    await sleep(50);
  }

  document.execCommand('insertText', false, text);
  await sleep(100);

  if (hasInjectedContent(element, text)) {
    return;
  }

  clearComposer(element);
  dispatchPaste(element, text);
  await sleep(150);

  // DOM-only writes can display text without updating the editor's document.
  // Use native editor insertion/paste only, and fail closed if not accepted.
  assertInjectedContent(element, text);
}

function assertInjectedContent(element, text) {
  if (!hasInjectedContent(element, text)) {
    throw new Error('AI 网页未完整接收提示词，本次未发送。请刷新 AI 页面后重试，或使用手动发送；不会用截断或重复的文本继续提交。');
  }
}

function clearComposer(element) {
  element.focus();
  selectAll(element);
  document.execCommand('delete', false);
}

function moveCaretToEnd(element) {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const length = element.value?.length ?? 0;
    element.setSelectionRange(length, length);
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function hasInjectedContent(element, text) {
  const actual = normalizeComposerText(readComposerText(element));
  const expected = normalizeComposerText(text);
  return Boolean(expected) && actual === expected;
}

function readComposerText(element) {
  if (!element) return '';
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value ?? '';
  // innerText inserts CSS paragraph spacing as extra blank lines in some
  // editors; textContent loses block/BR line breaks. Serialize editor blocks
  // instead, keeping real empty paragraphs and excluding placeholder BRs.
  if (element.childNodes) return readEditorChildren(element);
  return element.innerText ?? element.textContent ?? '';
}

function readEditorChildren(element) {
  const children = [...element.childNodes];
  const blocks = new Set(['P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'UL', 'OL']);
  if (blocks.has(element.tagName) && children.length === 1 && children[0].tagName === 'BR') return '';
  let text = '', previousBlock = false;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.nodeType !== 1 && child.nodeType !== 3) continue;
    const block = blocks.has(child.tagName);
    if (index > 0 && (previousBlock || block)) text += '\n';
    if (child.nodeType === 3) text += child.textContent ?? '';
    else if (child.tagName === 'BR') {
      if (!child.classList.contains('ProseMirror-trailingBreak')) text += '\n';
    } else text += readEditorChildren(child);
    previousBlock = block;
  }
  return text;
}

function normalizeComposerText(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
}

function dispatchPaste(element, text) {
  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  } catch {
    // Native editor insertion is the only fallback; no DOM-only mutation.
  }
}

function selectAll(element) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    element.setSelectionRange(0, element.value.length);
    return;
  }
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function dispatchInput(element, text) {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function assertComposerAvailable() {
  if (findStopButton()) {
    throw new Error('AI 网页仍在生成回复，本次未发送。请等待回复结束后手动重试。');
  }
  const input = findPromptInput();
  if (!input) {
    throw new Error('未找到可编辑的 AI 输入框。请打开已登录的聊天页，刷新页面后重试。');
  }
  if (hasComposerContent(input)) {
    throw new Error('AI 输入框已有草稿，本次未覆盖、未发送。请先保存或清空网页草稿后重试。');
  }
}

async function waitForComposerReady() {
  // Stream completion can precede the site's UI transition to an editable
  // composer. Briefly wait for that transition, never bypass a busy page.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (findPromptInput() && !findStopButton()) { assertComposerAvailable(); return; }
    await sleep(SEND_RETRY_MS);
  }
  assertComposerAvailable();
}

async function clickSendAfterFileAttach(composerMessage) {
  // ChatGPT keeps send disabled while the file is still uploading.
  await sleep(FILE_UPLOAD_SEND_WAIT_MS);

  await injectPrompt(composerMessage, { preserveAttachments: true });
  await sleep(300);

  if (await trySubmitSend(composerMessage)) {
    return;
  }

  await sleep(FILE_UPLOAD_SEND_RETRY_WAIT_MS);

  await injectPrompt(composerMessage, { preserveAttachments: true });
  await sleep(300);

  if (await trySubmitSend(composerMessage)) {
    return;
  }

  throw sendUnavailableError(true);
}

async function trySubmitSend(expected) {
  const input = findPromptInput();
  if (!input || !hasComposerContent(input)) return false;
  if (!hasInjectedContent(input, expected)) {
    throw new Error('等待发送时输入框内容发生变化，本次停止提交。请检查 AI 网页草稿后手动重试。');
  }
  if (findStopButton()) {
    throw new Error('AI 网页仍在生成回复，本次未发送。请等待回复结束后手动重试。');
  }
  const button = findSendButton();
  if (!isSendButtonEnabled(button)) return false;
  const before = {
    assistantCount: countAssistantMessages(),
    userCount: countUserMessages(),
    captureIds: new Set(apiCapture?.candidates.keys() ?? []),
  };
  button.click();
  if (await verifyMessageSubmitted(before)) return true;
  // An absent acknowledgement is ambiguous. Do not submit a second time.
  throw new Error('已点击发送，但未确认网页是否接收；为避免重复请求，未再次发送。请先查看 AI 网页，如已有回复请先保存；确认未发送后再重试，或改用手动传递。');
}

async function clickSendWhenReady(expected) {
  for (let attempt = 0; attempt < SEND_MAX_RETRIES; attempt += 1) {
    const input = findPromptInput();
    if (!input || !hasInjectedContent(input, expected)) {
      throw new Error('等待发送时输入框内容发生变化，本次停止提交。请检查 AI 网页草稿后手动重试。');
    }
    if (await trySubmitSend(expected)) return;
    await sleep(SEND_RETRY_MS);
  }
  throw sendUnavailableError();
}

function sendUnavailableError(afterUpload = false) {
  const button = findSendButton();
  if (!button) {
    return new Error('未找到当前聊天输入区的发送按钮，可能是网页结构或语言发生变化，并不表示网页已禁用发送。本次未点击；请重新加载最新版扩展并刷新 AI 页面，或改用手动传递。');
  }
  if (isSendButtonEnabled(button)) {
    return new Error('发送按钮状态在等待结束时发生变化，本次未点击。请先检查网页草稿和聊天记录，确认未发送后再手动重试。');
  }
  return new Error(`已找到发送按钮，但${afterUpload ? '附件上传后仍' : '持续'}不可用，本次未强制提交。请查看网页的${afterUpload ? '上传状态、' : ''}登录、额度或忙碌提示，再手动重试。`);
}

function countUserMessages() {
  return document.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"], [data-testid="user-turn"]').length;
}

async function verifyMessageSubmitted(before) {
  const deadline = Date.now() + SEND_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (findStopButton() || countAssistantMessages() > before.assistantCount || countUserMessages() > before.userCount) return true;
    if ([...(apiCapture?.candidates.keys() ?? [])].some((id) => !before.captureIds.has(id))) return true;
    await sleep(100);
  }
  // Disabled buttons and empty composers alone are not submission receipts.
  return false;
}

function findStopButton() {
  if (!provider?.selectors?.stop) {
    return null;
  }

  for (const selector of provider.selectors.stop) {
    const node = [...document.querySelectorAll(selector)].find(isElementVisible);
    if (node) return node;
  }

  return null;
}

function isElementVisible(element) {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

function isSendButtonEnabled(button) {
  if (!button) {
    return false;
  }

  if (!isElementVisible(button)) {
    return false;
  }

  if (button.disabled === true) {
    return false;
  }

  if (button.getAttribute('aria-disabled') === 'true') {
    return false;
  }

  if (button.classList?.contains('ds-button--disabled')) {
    return false;
  }

  const style = window.getComputedStyle(button);
  if (style.pointerEvents === 'none') {
    return false;
  }

  return true;
}

function hasComposerContent(input) {
  return normalizeComposerText(readComposerText(input)).length > 0;
}

function findSendButton() {
  const input = findPromptInput();
  if (!provider || !input) {
    return null;
  }

  const seen = new Set();
  const candidates = [];

  for (const selector of provider.selectors.send) {
    for (const node of document.querySelectorAll(selector)) {
      if (!seen.has(node)) {
        seen.add(node);
        candidates.push(node);
      }
    }
  }

  const form = input.closest('form');
  const scope = form ?? input.closest('[data-testid="composer"], [data-type="unified-composer"], .composer-parent');
  const visible = candidates.filter((button) => isElementVisible(button)
    && (form ? form.contains(button) || button.form === form : scope ? scope.contains(button) : !button.closest('form'))
    && !provider.selectors.stop?.some((selector) => button.matches(selector)));

  const enabled = visible.filter(isSendButtonEnabled);
  // Outside a known composer boundary, do not guess between several controls.
  if (!scope && (enabled.length > 1 || (!enabled.length && visible.length > 1))) return null;
  return enabled[0] ?? visible[0] ?? null;
}

async function waitForPlainResponse(beforeCount, mode, sessionId, options = {}) {
  const text = await waitForAssistantText(beforeCount, mode, sessionId, options);
  if (!text) {
    throw new Error('No assistant response detected.');
  }
  return text;
}

async function waitForAssistantText(beforeCount, mode, sessionId, options = {}) {
  const markdownDraft = options.markdownDraft === true;
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  let lastText = '';
  let stableSince = 0;
  let lastChunkText = '';
  let lastChunkAt = 0;
  let lastPreLength = 0;

  while (Date.now() < deadline) {
    const text = getLatestAssistantText(beforeCount, mode === 'agent', { markdownDraft });
    if (text) {
      const preLength = markdownDraft ? measureMarkdownPreLength(beforeCount) : 0;
      if (markdownDraft && preLength > lastPreLength) {
        lastPreLength = preLength;
        stableSince = Date.now();
      }

      if (mode === 'ask' && sessionId && shouldPostChunk(text, lastChunkText, lastChunkAt)) {
        await postBrowserChunk({ sessionId, text });
        lastChunkText = text;
        lastChunkAt = Date.now();
      }

      const stableMs = getStableMs(text, mode, markdownDraft);
      if (text === lastText) {
        if (Date.now() - stableSince >= stableMs && canFinishResponse()) {
          await sleep(FINISH_RECHECK_MS);
          const recheck = getLatestAssistantText(beforeCount, mode === 'agent', { markdownDraft });
          if (recheck && recheck.length >= text.length && canFinishResponse()) {
            if (mode === 'ask' && sessionId && recheck !== lastChunkText) {
              await postBrowserChunk({ sessionId, text: recheck });
            }
            return recheck;
          }
          if (recheck && recheck !== text) {
            lastText = recheck;
            stableSince = Date.now();
          }
        }
      } else {
        lastText = text;
        stableSince = Date.now();
      }
    }
    await sleep(POLL_MS);
  }

  const finalText = getLatestAssistantText(beforeCount, mode === 'agent', { markdownDraft });
  if (finalText && canFinishResponse()) {
    return finalText;
  }

  return finalText || lastText || null;
}

function shouldPostChunk(text, lastChunkText, lastChunkAt) {
  if (text === lastChunkText) {
    return false;
  }

  if (text.length - lastChunkText.length >= CHUNK_MIN_CHARS) {
    return true;
  }

  return Date.now() - lastChunkAt >= CHUNK_MIN_MS;
}

function canFinishResponse() {
  return !isStillGenerating();
}

function isStillGenerating() {
  if (!provider) {
    return false;
  }

  if (queryFirst(provider.selectors.stop)) {
    return true;
  }

  const streamingNode = document.querySelector('[data-is-streaming="true"], [data-is-streaming=""]');
  if (streamingNode) {
    return true;
  }

  return false;
}

function getStableMs(text, mode, markdownDraft = false) {
  if (mode === 'ask' && markdownDraft) {
    return ASK_DRAFT_STABLE_MS;
  }

  if (mode !== 'agent') {
    return ASK_STABLE_MS;
  }

  if (agentResponseNeedsMoreContent(text)) {
    return STABLE_MS * 3;
  }

  return STABLE_MS;
}

function agentResponseNeedsMoreContent(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    return false;
  }

  try {
    const parsed = JSON.parse(extractJsonObject(trimmed));
    const operations = parsed?.operations;
    if (!Array.isArray(operations)) {
      return false;
    }

    const fileOps = operations.filter(
      (operation) =>
        operation?.action === 'CREATE_FILE' || operation?.action === 'EDIT_FILE',
    );
    if (fileOps.length === 0) {
      return false;
    }

    const blocks = extractDomFileBlocksFromText(text);
    for (const operation of fileOps) {
      const path = normalizeCapturePath(operation.path ?? '');
      if (!path) {
        continue;
      }

      const hasBlock =
        blocks.some((block) => block.path === path) ||
        new RegExp(`---OB_FILE_BEGIN:\\s*${escapeRegex(path)}---`, 'i').test(text) ||
        (/\.md$/i.test(path) &&
          (/```(?:markdown|md)\s*\n/i.test(text) ||
            /```\n#\s/m.test(text) ||
            /"operations"\s*:\s*\[/.test(text))) ||
        new RegExp(`\`\`\`file:${escapeRegex(path)}`, 'i').test(text) ||
        new RegExp(`\`\`\`${escapeRegex(path)}`, 'i').test(text);

      if (!hasBlock && /\.md$/i.test(path) && !/"operations"\s*:\s*\[/.test(text)) {
        return true;
      }

      if (!hasBlock) {
        return true;
      }
    }
  } catch {
    // Keep waiting while JSON is still streaming.
    if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
      return true;
    }
  }

  return false;
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) {
    return text;
  }

  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return text.slice(start);
}

function getCaptureRoot(node) {
  return (
    node.querySelector?.('.prose[data-renderer="lm"]') ??
    (node.classList?.contains('prose') ? node : null) ??
    node
  );
}

function collectMarkdownPreContents(captureRoot) {
  const blocks = [];
  for (const pre of captureRoot.querySelectorAll('pre')) {
    const code = pre.querySelector('code') ?? pre;
    const content = (code.textContent ?? '').replace(/\n$/, '').trim();
    if (!content || looksLikeOperationsJson(content)) {
      continue;
    }
    if (looksLikeMarkdownPre(pre, content) || /^#\s/m.test(content)) {
      blocks.push(content);
    }
  }
  return blocks;
}

function measureMarkdownPreLength(beforeCount) {
  const nodes = collectAssistantNodes().slice(beforeCount);
  let total = 0;
  for (const node of nodes) {
    for (const content of collectMarkdownPreContents(getCaptureRoot(node))) {
      total += content.length;
    }
  }
  return total;
}

function extractOperationsJsonFromNode(captureRoot, fullText) {
  for (const pre of captureRoot.querySelectorAll('pre')) {
    const code = pre.querySelector('code') ?? pre;
    const content = (code.textContent ?? '').trim();
    if (content && looksLikeOperationsJson(content)) {
      return content;
    }
  }

  const fromText = extractJsonObject(fullText ?? '');
  if (fromText && looksLikeOperationsJson(fromText)) {
    return fromText.trim();
  }

  return null;
}

function buildAskCaptureText(node) {
  const captureRoot = getCaptureRoot(node);
  const markdownBlocks = collectMarkdownPreContents(captureRoot);

  if (markdownBlocks.length > 0) {
    const best = [...markdownBlocks].sort((a, b) => b.length - a.length)[0];
    return `\`\`\`markdown\n${best}\n\`\`\``;
  }

  return extractMessageText(node) ?? '';
}

function getLatestAssistantText(beforeCount, agentMode = false, options = {}) {
  const responseNodes = collectAssistantNodes();
  if (responseNodes.length <= beforeCount) {
    return null;
  }

  const newNodes = responseNodes.slice(beforeCount);
  const latest = newNodes[newNodes.length - 1];
  latest.scrollIntoView({ block: 'end', behavior: 'instant' });

  if (!agentMode) {
    const captured = newNodes.map((node) => buildAskCaptureText(node)).filter(Boolean).join('\n\n');
    return captured || mergeAssistantTexts(newNodes);
  }

  const withObMarker = [...newNodes]
    .reverse()
    .find((node) => /---OB_FILE_BEGIN:/i.test(extractMessageText(node) ?? ''));

  if (withObMarker) {
    return buildAgentCaptureText(withObMarker);
  }

  if (newNodes.length > 1) {
    const merged = mergeAssistantTexts(newNodes);
    if (merged && /---OB_FILE_BEGIN:/i.test(merged)) {
      return normalizeObFileCaptureText(merged);
    }
  }

  return buildAgentCaptureText(latest);
}

function mergeAssistantTexts(nodes) {
  return nodes
    .map((node) => extractMessageText(node))
    .filter(Boolean)
    .join('\n\n');
}

const OB_FILE_BLOCK_CAPTURE_RE =
  /---OB_FILE_BEGIN:\s*([^\n]+?)---\s*([\s\S]*?)---OB_FILE_END---/gi;

function extractPreCodeText(element) {
  const html = element.innerHTML ?? '';
  if (/<br\s*\/?>/i.test(html)) {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n$/, '');
  }

  return (element.textContent ?? '').replace(/\n$/, '');
}

function normalizeYamlCaptureText(content) {
  let text = content.replace(/\r\n/g, '\n').replace(/\\n/g, '\n').trim();
  if ((text.match(/\n/g) ?? []).length >= 3) {
    return text;
  }

  if (!/\w\s*:/.test(text)) {
    return text;
  }

  const rawParts = text.split(/\s+(?=[A-Za-z_][\w-]*:(?:\s|$|"|'|-))/);
  if (rawParts.length <= 1) {
    return text;
  }

  const lines = [];
  let section = 'root';

  for (let part of rawParts) {
    part = part.trim();
    if (!part) {
      continue;
    }

    const listInline = /^([A-Za-z_][\w-]*):\s+(-\s.+)$/i.exec(part);
    if (listInline) {
      const indent = section === 'service' ? 4 : section === 'services' ? 2 : 0;
      lines.push(`${' '.repeat(indent)}${listInline[1]}:`);
      lines.push(`${' '.repeat(indent + 2)}${listInline[2]}`);
      continue;
    }

    if (/^version:/i.test(part)) {
      lines.push(part);
      section = 'root';
    } else if (/^services:/i.test(part)) {
      lines.push(part);
      section = 'services';
    } else if (section === 'services' && /^[a-z][\w_-]*:/i.test(part)) {
      lines.push(`  ${part}`);
      section = 'service';
    } else if (section === 'service') {
      lines.push(`    ${part}`);
    } else {
      lines.push(part);
    }
  }

  return lines.join('\n');
}

function normalizeObFileCaptureText(text) {
  const blocks = [];
  for (const match of text.matchAll(OB_FILE_BLOCK_CAPTURE_RE)) {
    const path = normalizeCapturePath((match[1] ?? '').trim());
    let content = (match[2] ?? '').trim();
    if (path && /\.ya?ml$/i.test(path)) {
      content = normalizeYamlCaptureText(content);
    }
    if (path && content) {
      blocks.push({ path, content });
    }
  }

  if (blocks.length === 0) {
    return text;
  }

  const beginIndex = text.search(/---OB_FILE_BEGIN:/i);
  const prefix = beginIndex > 0 ? text.slice(0, beginIndex).trim() : '';
  const serialized = blocks.map(
    (block) => `---OB_FILE_BEGIN: ${block.path}---\n${block.content}\n---OB_FILE_END---`,
  );

  return [prefix, ...serialized].filter(Boolean).join('\n\n');
}

function buildAgentCaptureText(node) {
  const captureRoot = getCaptureRoot(node);
  let fullText = extractMessageText(captureRoot) ?? extractMessageText(node);

  if (fullText && /---OB_FILE_BEGIN:/i.test(fullText)) {
    return normalizeObFileCaptureText(fullText);
  }

  const parts = [];
  const jsonParts = [];
  const markdownPres = [];
  const pres = [...captureRoot.querySelectorAll('pre')];

  const opsFromNode = extractOperationsJsonFromNode(captureRoot, fullText);
  if (opsFromNode) {
    jsonParts.push(opsFromNode);
  }

  for (const pre of pres) {
    const code = pre.querySelector('code') ?? pre;
    const content = extractPreCodeText(code);
    if (!content.trim()) {
      continue;
    }

    if (looksLikeOperationsJson(content)) {
      const trimmed = content.trim();
      if (!jsonParts.includes(trimmed)) {
        parts.push(trimmed);
        jsonParts.push(trimmed);
      }
      continue;
    }

    if (looksLikeMarkdownPre(pre, content)) {
      markdownPres.push(content.trim());
      continue;
    }

    const path = findPathForPre(pre) ?? inferPathFromContent(content);
    if (path && /\.md$/i.test(path)) {
      markdownPres.push(content.trim());
      continue;
    }

    if (path) {
      const fileContent =
        /\.ya?ml$/i.test(path) ? normalizeYamlCaptureText(content.trim()) : content.trim();
      parts.push(`---OB_FILE_BEGIN: ${path}---\n${fileContent}\n---OB_FILE_END---`);
    } else {
      parts.push(`\`\`\`\n${content.trim()}\n\`\`\``);
    }
  }

  if (jsonParts.length > 0 && markdownPres.length > 0 && jsonCreatesMdFile(jsonParts.join('\n'))) {
    const mdContent = [...markdownPres].sort((a, b) => b.length - a.length)[0];
    return `${jsonParts.join('\n\n')}\n\n\`\`\`markdown\n${mdContent}\n\`\`\``;
  }

  if (jsonParts.length > 0 && markdownPres.length === 0 && jsonCreatesMdFile(jsonParts.join('\n'))) {
    return jsonParts.join('\n\n');
  }

  if (parts.length > 0) {
    return parts.join('\n\n');
  }

  if (fullText && /```(?:markdown|md)\s*\n/i.test(fullText)) {
    return fullText;
  }

  if (fullText && looksLikeOperationsJson(extractJsonObject(fullText))) {
    return fullText;
  }

  return fullText;
}

function looksLikeMarkdownPre(pre, content) {
  const code = pre.querySelector('code') ?? pre;
  const className = code.className ?? '';
  if (/language-(markdown|md)\b/i.test(className)) {
    return true;
  }

  const text = content.trim();
  return /^#\s/m.test(text) || (text.includes('## ') && text.includes('\n- '));
}

function jsonCreatesMdFile(jsonText) {
  try {
    const parsed = JSON.parse(extractJsonObject(jsonText));
    return (
      Array.isArray(parsed?.operations) &&
      parsed.operations.some(
        (operation) =>
          operation?.action === 'CREATE_FILE' && /\.md$/i.test(operation.path ?? ''),
      )
    );
  } catch {
    return false;
  }
}

function inferPathFromContent(content) {
  const text = content.trim();
  if (!text) {
    return null;
  }

  if (/express\.Router|router\.get|router\.post|module\.exports\s*=\s*router/i.test(text)) {
    return 'src/routes/userRoutes.js';
  }

  if (/app\.listen|app\.use\(\s*['"]\/api/i.test(text) && /userRoutes|require\(['"]\.\/routes/i.test(text)) {
    return 'src/server.js';
  }

  if (/getUsers|listUsers|module\.exports\s*=\s*\{/i.test(text) && /res\.(status|json)/i.test(text)) {
    return 'src/controllers/userController.js';
  }

  if (text.startsWith('{') && text.includes('"name"') && text.includes('"version"')) {
    return 'package.json';
  }

  return null;
}

function extractDomFileBlocks(node) {
  const blocks = new Map();
  const pres = node.querySelectorAll('pre');

  for (const pre of pres) {
    const code = pre.querySelector('code') ?? pre;
    const content = (code.textContent ?? '').trim();
    if (!content || looksLikeOperationsJson(content)) {
      continue;
    }

    const path = findPathForPre(pre);
    if (!path) {
      continue;
    }

    blocks.set(path, content);
  }

  return [...blocks.entries()].map(([path, content]) => ({ path, content }));
}

function extractDomFileBlocksFromText(text) {
  const blocks = [];
  for (const match of text.matchAll(OB_FILE_BLOCK_CAPTURE_RE)) {
    const path = normalizeCapturePath(match[1] ?? '');
    const content = (match[2] ?? '').trim();
    if (path && content) {
      blocks.push({ path, content });
    }
  }

  for (const match of text.matchAll(/```file:([^\n`]+\.md)\s*\n([\s\S]*?)```/gi)) {
    const path = normalizeCapturePath(match[1] ?? '');
    const content = (match[2] ?? '').trim();
    if (path && content) {
      blocks.push({ path, content });
    }
  }

  for (const match of text.matchAll(/```(?:markdown|md)\s*\n([\s\S]*?)```/gi)) {
    const content = (match[1] ?? '').trim();
    if (content) {
      blocks.push({ path: '', content });
    }
  }

  const pattern = /```file:([^\n`]+)\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(pattern)) {
    const path = normalizeCapturePath(match[1] ?? '');
    const content = (match[2] ?? '').trim();
    if (path && content) {
      blocks.push({ path, content });
    }
  }
  return blocks;
}

function findPathForPre(pre) {
  const fromLabel = findNearestFileLabelBefore(pre);
  if (fromLabel) {
    return fromLabel;
  }

  let sibling = pre.previousElementSibling;
  for (let step = 0; step < 6 && sibling; step += 1) {
    const path = extractPathFromLabel(sibling.textContent ?? '');
    if (path) {
      return path;
    }
    sibling = sibling.previousElementSibling;
  }

  const parent = pre.parentElement;
  if (parent) {
    const parentPath = extractPathFromLabel(parent.textContent ?? '');
    if (parentPath && parent.textContent?.length && parent.textContent.length < 120) {
      return parentPath;
    }
  }

  const container = pre.closest('[data-message-author-role="assistant"], article');
  if (container) {
    let previous = pre.previousElementSibling;
    while (previous) {
      const path = extractPathFromLabel(previous.textContent ?? '');
      if (path) {
        return path;
      }
      previous = previous.previousElementSibling;
    }

    const headers = container.querySelectorAll('h1, h2, h3, h4, h5, h6, strong, span, button, a');
    for (const header of headers) {
      if (header.contains(pre)) {
        continue;
      }
      const path = extractPathFromLabel(header.textContent ?? '');
      if (path) {
        return path;
      }
    }
  }

  const code = pre.querySelector('code');
  const className = code?.className ?? '';
  const langMatch = /language-([^\s]+)/.exec(className);
  if (langMatch?.[1]?.includes('.')) {
    return normalizeCapturePath(langMatch[1]);
  }

  return null;
}

function findNearestFileLabelBefore(pre) {
  const container = pre.closest('[data-message-author-role="assistant"], article');
  if (!container) {
    return null;
  }

  const elements = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    elements.push(node);
    node = walker.nextNode();
  }

  const preIndex = elements.indexOf(pre);
  if (preIndex <= 0) {
    return null;
  }

  for (let i = preIndex - 1; i >= 0; i -= 1) {
    const el = elements[i];
    if (!el || el === pre || pre.contains(el) || el.contains(pre)) {
      continue;
    }

    const otherPre = el.closest('pre');
    if (otherPre && otherPre !== pre) {
      continue;
    }

    const text = (el.textContent ?? '').trim();
    if (!text || text.length > 160) {
      continue;
    }

    const path = extractPathFromLabel(text);
    if (!path) {
      continue;
    }

    if (/^file:\s*\S+/i.test(text) || isPathOnlyLabel(text, path)) {
      return path;
    }
  }

  return null;
}

function isPathOnlyLabel(text, path) {
  const compact = text.replace(/\s+/g, '');
  const normalized = path.replace(/^\.\//, '');
  return compact === `file:${normalized}` || compact === normalized || compact.endsWith(normalized);
}

function extractPathFromLabel(text) {
  const trimmed = text.trim();
  const filePrefix = /^file:\s*(\S+)/i.exec(trimmed);
  if (filePrefix?.[1]) {
    return normalizeCapturePath(filePrefix[1]);
  }

  const match = /([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/.exec(trimmed);
  return match ? normalizeCapturePath(match[1]) : null;
}

function normalizeCapturePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function looksLikeOperationsJson(content) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed?.operations);
  } catch {
    return trimmed.includes('"operations"');
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMessageText(node) {
  if (!provider) {
    return node.textContent?.trim() ?? null;
  }

  const clone = node.cloneNode(true);
  for (const selector of provider.selectors.exclude ?? []) {
    clone.querySelectorAll(selector).forEach((el) => el.remove());
  }

  for (const selector of provider.selectors.markdown) {
    const markdown = clone.querySelector(selector);
    if (markdown) {
      const text = (markdown.innerText ?? markdown.textContent ?? '').trim();
      if (text) {
        return text;
      }
    }
  }

  const text = (clone.innerText ?? clone.textContent ?? '').trim();
  return text || null;
}

function collectAssistantNodes() {
  if (!provider) {
    return [];
  }
  return isChatGpt ? collectChatGptMessages('assistant') : queryAll(provider.selectors.assistant);
}

function countAssistantMessages() {
  return collectAssistantNodes().length;
}

function findPromptInput() {
  if (!provider) {
    return null;
  }
  const findIn = (root) => {
    for (const selector of provider.selectors.input) {
      const input = [...root.querySelectorAll(selector)].find((node) =>
        isElementVisible(node) && !node.disabled && !node.readOnly
        && node.getAttribute('aria-disabled') !== 'true'
        && !node.matches(':disabled')
        && (node instanceof HTMLTextAreaElement || node.isContentEditable));
      if (input) return input;
    }
    return null;
  };
  const input = findIn(document);
  if (input) return input;
  for (const root of collectSearchRoots(document)) {
    if (root === document) continue;
    const shadowInput = findIn(root);
    if (shadowInput) return shadowInput;
  }
  return null;
}

async function handleJob(job) {
  const claim = await claimJob(job.sessionId);
  if (!claim.claimed || !claim.job) {
    throw new Error('Job already claimed by another tab');
  }

  await processJob(claim.job);
}

async function postBrowserChunk(body) {
  try {
    await bridgeRequest('/browser/chunk', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch {
    // Chunk delivery is best-effort.
  }
}

async function postBrowserResponse(body) {
  await bridgeRequest('/browser/response', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sleep(ms) {
  const active = activeJob;
  if (!active) return new Promise((resolve) => setTimeout(resolve, ms));
  if (active.cancelled) return Promise.reject(active.reason);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); active.waiters.delete(cancel); reject(active.reason); };
    const timer = setTimeout(() => {
      active.waiters.delete(cancel);
      if (active.cancelled) reject(active.reason); else resolve();
    }, ms);
    active.waiters.add(cancel);
  });
}
