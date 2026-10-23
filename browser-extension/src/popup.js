const BRIDGE_URL = 'http://127.0.0.1:5000';

const PROVIDERS = [
  { name: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'] },
  { name: 'Claude', hosts: ['claude.ai'] },
  { name: 'Perplexity', hosts: ['www.perplexity.ai', 'perplexity.ai'] },
  { name: 'GLM', hosts: ['chat.z.ai', 'glm.ai', 'open.bigmodel.cn'] },
  { name: 'Grok', hosts: ['grok.com', 'x.com'] },
  { name: 'Gemini', hosts: ['gemini.google.com'] },
  { name: 'DeepSeek', hosts: ['chat.deepseek.com'] },
];

const URL_PATTERNS = PROVIDERS.flatMap((provider) =>
  provider.hosts.map((host) => `https://${host}/*`),
);

const bridgeDot = document.querySelector('#bridge-dot');
const bridgeStatus = document.querySelector('#bridge-status');
const bridgeMeta = document.querySelector('#bridge-meta');
const pageDot = document.querySelector('#page-dot');
const pageHost = document.querySelector('#page-host');
const pageProvider = document.querySelector('#page-provider');
const providerList = document.querySelector('#provider-list');
const tabsSummary = document.querySelector('#tabs-summary');
const refreshButton = document.querySelector('#check');
const extensionVersion = document.querySelector('#extension-version') ?? document.querySelector('.version');
if (extensionVersion) extensionVersion.textContent = `v${chrome.runtime.getManifest().version}`;

refreshButton.addEventListener('click', refreshStatus);
refreshStatus();
setInterval(refreshStatus, 3000);

async function refreshStatus() {
  bridgeStatus.textContent = 'Checking bridge...';
  setDot(bridgeDot, 'pending');

  const [bridgeOk, workerStatus, tabs, activeTab] = await Promise.all([
    checkBridge(),
    checkWorker(),
    chrome.tabs.query({ url: URL_PATTERNS }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  if (bridgeOk && workerStatus?.sseConnected && workerStatus.readyTabs > 0) {
    setDot(bridgeDot, 'online');
    bridgeStatus.textContent = '扩展和 AI 页面已就绪';
    bridgeMeta.textContent = workerStatus.identityReporting
      ? `${BRIDGE_URL} · SSE active · ${workerStatus.readyTabs} tab(s) · 已启用 AI 平台上报`
      : 'AI 页面就绪，但后台脚本未上报平台；请在扩展管理页重新加载扩展，再刷新 AI 网页。';
  } else if (bridgeOk && workerStatus?.sseConnected) {
    setDot(bridgeDot, 'pending');
    bridgeStatus.textContent = '扩展已连接，AI 页面未就绪';
    bridgeMeta.textContent = '请登录 AI 网页并刷新，等待输入框出现';
  } else if (bridgeOk) {
    setDot(bridgeDot, 'pending');
    bridgeStatus.textContent = '本地服务正常，扩展正在重连…';
    bridgeMeta.textContent = `${BRIDGE_URL} · reload AI tab if jobs do not arrive`;
  } else {
    setDot(bridgeDot, 'offline');
    bridgeStatus.textContent = '本地服务未连接';
    bridgeMeta.textContent = 'Run openbrowser in your project folder';
  }

  const activeHost = getHostname(activeTab[0]?.url);
  const activeProvider = findProvider(activeHost);

  if (activeProvider) {
    setDot(pageDot, bridgeOk ? 'online' : 'pending');
    pageHost.textContent = activeHost;
    pageProvider.textContent = `${activeProvider.name} detected`;
  } else if (activeHost) {
    setDot(pageDot, 'offline');
    pageHost.textContent = activeHost;
    pageProvider.textContent = 'Unsupported host';
  } else {
    setDot(pageDot, 'offline');
    pageHost.textContent = 'No active tab';
    pageProvider.textContent = 'Open an AI chat page';
  }

  renderProviders(tabs);
  tabsSummary.textContent = `${tabs.length} AI tab(s) open`;
}

async function checkBridge() {
  try {
    const started = performance.now();
    const response = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      return false;
    }
    const latency = Math.round(performance.now() - started);
    bridgeMeta.textContent = `${BRIDGE_URL} · ${latency}ms`;
    return true;
  } catch {
    return false;
  }
}

async function checkWorker() {
  try {
    return await chrome.runtime.sendMessage({ type: 'OPENBROWSER_PING' });
  } catch {
    return null;
  }
}

function renderProviders(tabs) {
  const openHosts = new Set(
    tabs.map((tab) => getHostname(tab.url)).filter(Boolean),
  );

  providerList.replaceChildren(
    ...PROVIDERS.map((provider) => {
      const item = document.createElement('li');
      const isOpen = provider.hosts.some((host) => openHosts.has(host));
      item.className = `provider-item ${isOpen ? 'open' : 'closed'}`;
      item.innerHTML = `
        <span class="dot ${isOpen ? 'online' : 'offline'}"></span>
        <span class="provider-name">${provider.name}</span>
        <span class="provider-host">${provider.hosts[0]}</span>
      `;
      return item;
    }),
  );
}

function findProvider(hostname) {
  if (!hostname) {
    return null;
  }
  return PROVIDERS.find((provider) => provider.hosts.includes(hostname)) ?? null;
}

function getHostname(url) {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function setDot(element, state) {
  element.className = `dot ${state}`;
}
