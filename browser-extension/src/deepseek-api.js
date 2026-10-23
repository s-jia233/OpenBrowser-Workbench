(() => {
  const HOSTS = ['chat.deepseek.com'];
  const CAPTURE_PATHS = ['/api/v0/chat/completion'];
  const CAPTURE_METHOD = 'POST';
  const CHUNK_POST_MIN_MS = 120;

  if (!HOSTS.includes(window.location.hostname)) return;
  if (window.__openbrowserDeepSeekApiCaptureInstalled) return;
  window.__openbrowserDeepSeekApiCaptureInstalled = true;

  const originalFetch = window.fetch.bind(window);

  function post(payload) {
    window.postMessage({ source: 'openbrowser-deepseek-api', ...payload }, '*');
  }

  function shouldCapture(url, method) {
    try {
      const parsed = new URL(url, window.location.origin);
      return (
        method === CAPTURE_METHOD &&
        CAPTURE_PATHS.some((path) => parsed.pathname.endsWith(path))
      );
    } catch {
      return false;
    }
  }

  function createState() {
    return { buffer: '', text: '', done: false, fragments: [], currentPath: '', currentOperation: 'APPEND' };
  }

  function updateAnswer(state) {
    state.text = state.fragments.filter((fragment) => ['RESPONSE', 'ANSWER', 'FINAL', 'TEXT'].includes(String(fragment?.type).toUpperCase()))
      .map((fragment) => typeof fragment.content === 'string' ? fragment.content : '').join('');
  }

  function handleDeepSeekData(data, state, basePath = '') {
    if (!data || typeof data !== 'object') return;
    const value = data.v;
    const explicit = typeof data.p === 'string' ? data.p.replace(/^\//, '') : null;
    const patchPath = explicit === null ? state.currentPath
      : basePath && !explicit.startsWith('response/') && explicit !== 'response' ? `${basePath}/${explicit}` : explicit;
    if (data.o === 'BATCH' && Array.isArray(value)) {
      for (const patch of value) handleDeepSeekData(patch, state, explicit === null ? basePath : patchPath);
      return;
    }
    if (explicit !== null) state.currentPath = patchPath;
    const operation = String(data.o || state.currentOperation || 'APPEND').toUpperCase();
    if (data.o) state.currentOperation = operation;
    const response = value?.response || (patchPath === 'response' ? value : null);
    if (response && typeof response === 'object') {
      const fragments = response.fragments;
      if (Array.isArray(fragments)) {
        state.fragments = fragments.map((fragment) => ({ ...fragment }));
        state.currentPath = `response/fragments/${fragments.length - 1}/content`;
        state.currentOperation = 'APPEND';
        updateAnswer(state);
      }
      if (response.status === 'FINISHED') state.done = true;
      return;
    }
    if (['response/status', 'response/quasi_status', 'quasi_status'].includes(patchPath)) {
      if (value === 'FINISHED') state.done = true;
      return;
    }
    if (patchPath === 'response/fragments' && Array.isArray(value)) {
      const fragments = value.map((fragment) => ({ ...fragment }));
      state.fragments = operation === 'APPEND' ? [...state.fragments, ...fragments] : fragments;
      state.currentPath = `response/fragments/${state.fragments.length - 1}/content`;
      state.currentOperation = 'APPEND';
      updateAnswer(state);
      return;
    }
    const match = /^response\/fragments\/(-?\d+)(?:\/(content|type))?$/.exec(patchPath);
    if (!match) return; // Ignore metadata/unknown fields, never append them to an answer.
    const index = Number(match[1]) < 0 ? state.fragments.length + Number(match[1]) : Number(match[1]);
    if (index < 0 || index > 1000) return;
    if (!match[2] && value && typeof value === 'object' && !Array.isArray(value)) {
      state.fragments[index] = { ...value };
      state.currentPath = `response/fragments/${index}/content`;
      state.currentOperation = 'APPEND';
    } else if (state.fragments[index] && typeof value === 'string') {
      const fragment = state.fragments[index];
      if (match[2] === 'type') {
        if (fragment.type !== value) fragment.content = '';
        fragment.type = value;
      } else if (match[2] === 'content') {
        fragment.content = operation === 'APPEND' ? String(fragment.content || '') + value : value;
      }
    }
    updateAnswer(state);
  }

  function handleSseBlock(block, state) {
    const normalized = block.replace(/\r\n/g, '\n');
    if (!normalized.trim() || normalized.startsWith(':')) {
      return;
    }

    const dataLines = [];
    for (const line of normalized.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) {
      return;
    }

    const rawData = dataLines.join('\n');
    if (rawData === '[DONE]') {
      state.done = true;
      return;
    }

    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      return;
    }
    handleDeepSeekData(data, state);
  }

  function feedSseText(chunk, state) {
    state.buffer = (state.buffer + chunk).replace(/\r\n/g, '\n');
    let separator;
    while ((separator = state.buffer.indexOf('\n\n')) !== -1) {
      const block = state.buffer.slice(0, separator);
      state.buffer = state.buffer.slice(separator + 2);
      handleSseBlock(block, state);
      if (state.done) {
        break;
      }
    }
  }

  function flushSseBuffer(state) {
    if (state.buffer.trim()) {
      handleSseBlock(state.buffer, state);
      state.buffer = '';
    }
  }

  async function readCaptureStream(stream, captureId, state) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let lastText = '';
    let lastChunkAt = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        feedSseText(decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n'), state);

        const text = state.text;
        if (text && text !== lastText && Date.now() - lastChunkAt >= CHUNK_POST_MIN_MS) {
          lastText = text;
          lastChunkAt = Date.now();
          post({ type: 'capture-chunk', captureId, text });
        }
        if (state.done) {
          break;
        }
      }

      flushSseBuffer(state);
      post({ type: 'capture-done', captureId, text: state.text });
    } catch (error) {
      flushSseBuffer(state);
      post({ type: 'capture-error', captureId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function captureResponse(response) {
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
    post({ type: 'capture-begin', captureId, at: Date.now() });
    void readCaptureStream(captureStream, captureId, state);
    return forPage;
  }

  window.fetch = async function (...args) {
    const input = args[0];
    const init = args[1] ?? {};
    const url = typeof input === 'string' ? input : input?.url;
    const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
    const response = await originalFetch(...args);
    if (!shouldCapture(url, method) || !response?.body) {
      return response;
    }
    return captureResponse(response);
  };

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__openbrowserDeepSeekUrl = url ?? '';
    this.__openbrowserDeepSeekMethod = String(method ?? 'GET').toUpperCase();
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const xhr = this;
    if (shouldCapture(xhr.__openbrowserDeepSeekUrl, xhr.__openbrowserDeepSeekMethod)) {
      const captureId =
        typeof crypto?.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const state = createState();
      let lastLength = 0;
      let lastText = '';
      let lastChunkAt = 0;

      post({ type: 'capture-begin', captureId, at: Date.now() });

      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState < 3) {
          return;
        }

        let raw = '';
        try {
          raw = xhr.responseText ?? '';
        } catch {
          raw = '';
        }
        if (raw.length > lastLength) {
          feedSseText(raw.slice(lastLength).replace(/\r\n/g, '\n'), state);
          lastLength = raw.length;

          const text = state.text;
          if (text && text !== lastText && Date.now() - lastChunkAt >= CHUNK_POST_MIN_MS) {
            lastText = text;
            lastChunkAt = Date.now();
            post({ type: 'capture-chunk', captureId, text });
          }
        }

        if (xhr.readyState === 4) {
          flushSseBuffer(state);
          post({ type: 'capture-done', captureId, text: state.text });
        }
      });
    }
    return originalXhrSend.apply(this, args);
  };
})();
