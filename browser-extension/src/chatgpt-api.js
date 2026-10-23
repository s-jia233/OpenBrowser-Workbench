(() => {
  const HOSTS = ['chatgpt.com', 'chat.openai.com'];
  const CAPTURE_PATHS = ['/backend-api/f/conversation', '/backend-api/conversation'];
  const CAPTURE_METHOD = 'POST';
  const CHUNK_POST_MIN_MS = 120;

  if (!HOSTS.includes(window.location.hostname)) return;
  if (window.__openbrowserChatGptApiCaptureInstalled) return;
  window.__openbrowserChatGptApiCaptureInstalled = true;

  const originalFetch = window.fetch.bind(window);

  function post(payload) {
    window.postMessage({ source: 'openbrowser-chatgpt-api', ...payload }, '*');
  }

  function partIndexFromPath(path) {
    const match = /^\/message\/content\/parts\/(\d+)$/.exec(path ?? '');
    return match ? Number(match[1]) : null;
  }

  function textFromState(state) {
    const keys = [...state.fragments.keys()].sort((a, b) => a - b);
    return keys.map((key) => state.fragments.get(key)).join('\n\n');
  }

  function acceptMessageSnapshot(message, state) {
    if (!message || typeof message !== 'object') return;
    const channel = message.channel ?? message.metadata?.channel;
    state.role = message.author?.role;
    state.messageId = state.role === 'assistant' && typeof message.id === 'string' ? message.id : null;
    state.status = message.status;
    state.endTurn = message.end_turn === true;
    state.accepting = state.role === 'assistant' && (!channel || channel === 'final');
    state.currentPath = null;
    state.done = false;
    if (!state.accepting) return;
    if (message.content?.content_type === 'text' && Array.isArray(message.content.parts)) {
      // Full snapshots are authoritative, including shorter final answers.
      state.fragments = new Map(message.content.parts.flatMap((part, index) => typeof part === 'string' ? [[index, part]] : []));
      state.currentPath = '/message/content/parts/0';
      state.currentOperation = 'append';
    }
    if (state.status === 'finished_successfully' && state.endTurn) state.done = true;
  }

  function handleDelta(data, state, basePath = '') {
    if (Array.isArray(data)) { for (const patch of data) handleDelta(patch, state, basePath); return; }
    if (!data || typeof data !== 'object') return;
    const value = data.v;
    const explicit = typeof data.p === 'string' ? data.p : null;
    const path = explicit === null ? state.currentPath
      : explicit.startsWith('/') ? explicit : `${basePath}/${explicit}`.replace(/\/$/, '');
    const operation = String(data.o ?? state.currentOperation).toLowerCase();
    if (Array.isArray(value) && ['patch', 'batch'].includes(operation)) {
      for (const patch of value) handleDelta(patch, state, path ?? basePath);
      return;
    }
    const snapshot = data.message ?? value?.message ?? (path === '/message' ? value : null);
    if (snapshot) { acceptMessageSnapshot(snapshot, state); return; }
    if (explicit !== null) state.currentPath = path;
    if (data.o) state.currentOperation = operation;
    if (path === '/message/channel' && typeof value === 'string') {
      state.accepting = state.role === 'assistant' && value === 'final';
      state.fragments.clear();
      state.currentPath = null;
      state.done = false;
      return;
    }
    if (!state.accepting) return;
    if (path === '/message/status') state.status = value;
    if (path === '/message/end_turn') state.endTurn = value === true;
    if (['/message/status', '/message/end_turn'].includes(path)
      && state.status === 'finished_successfully' && state.endTurn) state.done = true;
    const index = partIndexFromPath(path);
    if (index !== null && typeof value === 'string') {
      state.done = false;
      const existing = state.fragments.get(index) ?? '';
      if (operation === 'append') state.fragments.set(index, existing + value);
      else if (['replace', 'set', 'add'].includes(operation)) state.fragments.set(index, value);
    } else if (path === '/message/content/parts' && Array.isArray(value) && ['replace', 'set', 'add'].includes(operation)) {
      state.done = false;
      state.fragments = new Map(value.flatMap((part, index) => typeof part === 'string' ? [[index, part]] : []));
    }
  }

  function handleSseBlock(block, state) {
    const normalized = block.replace(/\r\n/g, '\n');
    if (!normalized.trim() || normalized.startsWith(':')) return;

    let event = 'message';
    const dataLines = [];
    for (const line of normalized.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) return;
    const rawData = dataLines.join('\n');
    if (rawData === '[DONE]') {
      state.done = true;
      state.transportDone = true;
      return;
    }

    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      return;
    }

    // Completion metadata is not a text patch, even when its event label is
    // delta. Check it before the delta dispatcher rather than waiting for EOF.
    if (event === 'message_stream_complete' || data?.type === 'message_stream_complete') {
      state.done = true;
      return;
    }

    // ChatGPT can omit event: delta on subsequent compact packets. SSE then
    // defaults to "message"; do not silently drop their p/o/v content.
    // Only accept the patch envelope, not unrelated typed metadata.
    const compactPatch = event === 'message' && (Array.isArray(data) || (
      data && typeof data === 'object' && Object.keys(data).length > 0
      && Object.keys(data).every((key) => ['p', 'o', 'v'].includes(key))
      && ('v' in data || 'p' in data)
    ));
    if (event === 'delta' || data?.message || data?.v?.message || compactPatch) {
      handleDelta(data, state);
      return;
    }
  }

  function createState() {
    return { fragments: new Map(), currentPath: null, currentOperation: 'append', role: null, messageId: null, accepting: false, done: false, transportDone: false };
  }

  async function readCaptureStream(stream, captureId, state) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastText = '';
    let lastChunkAt = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Normalize after concatenation so a CR/LF split across chunks is safe.
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

        let separator;
        while ((separator = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          handleSseBlock(block, state);

          const text = textFromState(state);
          if (text && text !== lastText && Date.now() - lastChunkAt >= CHUNK_POST_MIN_MS) {
            lastText = text;
            lastChunkAt = Date.now();
            post({ type: 'capture-chunk', captureId, text, messageId: state.accepting ? state.messageId : null });
          }
          // A message-level completion is not the end of this HTTP response.
          // Keep consuming the page's existing stream: a later final snapshot
          // or delta may still supersede the current prefix. Only the global
          // DONE sentinel may end this branch before transport EOF.
          if (state.transportDone) break;
        }
        if (state.transportDone) break;
      }

      if (buffer && !state.transportDone) {
        handleSseBlock(buffer, state);
      }
      if (!state.done) throw new Error('ChatGPT response stream ended before a completion marker.');
      post({ type: 'capture-done', captureId, text: textFromState(state), messageId: state.accepting ? state.messageId : null });
    } catch (error) {
      post({ type: 'capture-error', captureId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      // Cancel only the tee's capture branch, never the page's response stream.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  function shouldCapture(url, method) {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.origin === window.location.origin && method === CAPTURE_METHOD && CAPTURE_PATHS.includes(parsed.pathname);
    } catch {
      return false;
    }
  }

  function captureResponse(response, requestAt) {
    const captureId =
      typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      return response;
    }

    const [pageStream, captureStream] = response.body.tee();
    const forPage = new Response(pageStream, response);
    const state = createState();
    // A slow response from a cancelled previous turn must not join a new turn.
    post({ type: 'capture-begin', captureId, at: requestAt });
    void readCaptureStream(captureStream, captureId, state);
    return forPage;
  }

  window.fetch = async function (...args) {
    const input = args[0];
    const init = args[1] ?? {};
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
    const requestAt = Date.now();
    const response = await originalFetch(...args);
    if (!shouldCapture(url, method) || !response?.body) {
      return response;
    }
    return captureResponse(response, requestAt);
  };
})();
