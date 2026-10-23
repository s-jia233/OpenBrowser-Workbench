import { connectionAiDisplay, taskAiLabel } from './ai-status.js';
import { installEnterToSend, installNavigationToggle } from './composer-controls.js';
import { visibleConversations, installConversationMenu } from './conversation-menu.js';
import { installCollaboration } from './collaboration.js';
import { executionHtml, browserReceptionHtml, clarificationHtml } from './execution-status.js';
import { targetChoices, validateBrowserTarget } from './browser-targets.js';
import { createTaskDraftStore, followupDraftKey, replyDraftKey } from './task-drafts.js';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { token: '', workspace: null, selected: new Set(), collapsed: new Set(), scripts: new Set(), mode: 'agent', view: 'work', task: null, tasks: [], draft: '', busy: false, lastTaskMarkup: '', history: [], online: true };
const terminal = new Set(['complete', 'failed', 'cancelled', 'rejected', 'needs_input']);
const labels = { preparing: '读取上下文', awaiting_response: '等待模型回复', review: '待你审核', applying: '应用与验证中', complete: '已完成', failed: '任务失败', needs_input: '等待你补充信息', cancelled: '已取消', rejected: '已拒绝' };
const viewTitles = { work: '任务工作台', collaboration: '多模型协作', changes: '变更审核', logs: '运行日志', history: '历史记录' };
const actions = { CREATE_FILE: '新增', EDIT_FILE: '修改', DELETE_FILE: '删除', RENAME_FILE: '重命名', CREATE_FOLDER: '目录' };
let polling = false;
let uiActions = 0;
let pollCount = 0;
let folderState = null;
let browsingFolders = false;
let followupTaskId = '';
let deletingTaskId = '';
let deleteInFlight = false;
let tasksRevision = 0;
let showingArchived = false;
let renamingTaskId = '';
let metadataInFlight = false;
let recentMarkup = '';
let taskDrafts = null, draftProject = '', followupSlot = '', replySlot = '', draftWarning = false;
let draftStorage;
try { draftStorage = window.localStorage; } catch { /* Drafts remain in memory when browser storage is blocked. */ }

function esc(value = '') { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function time(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false }); }
function shortTime(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }
function pill(status) { return `<span class="status-pill ${esc(status)}">${esc(labels[status] || status)}</span>`; }
function isActive() { return state.tasks.some((task) => !terminal.has(task.status)); }
function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|ENOTDIR/.test(message)) return '找不到这个文件或文件夹。请检查路径是否正确、盘符是否存在。';
  if (/EACCES|EPERM/.test(message)) return '没有访问此文件夹的权限。请改选有访问权限的项目。';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return '无法连接本地服务。请确认工作台终端仍在运行，然后刷新页面。';
  if (error?.name === 'TimeoutError') return '本地服务响应超时，请稍后重试。当前输入已保留。';
  return message;
}
function toast(message, error = false) {
  $('#feedback-title').textContent = error ? '操作未完成' : '操作提示';
  $('#feedback-message').textContent = message;
  $('#action-feedback').className = `action-feedback${error ? ' error' : ''}`;
  if (error) { $('#action-feedback').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); $('#action-feedback').focus({ preventScroll: true }); }
}

function fieldError(selector, message = '') {
  const element = $(selector);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('hidden', !message);
  if (message) { element.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); element.focus({ preventScroll: true }); }
}

function saveDraft(slot, text) {
  if (!taskDrafts || !slot) return;
  if (!taskDrafts.save(slot, text) && !draftWarning) {
    draftWarning = true; toast('草稿无法保存到浏览器，关闭页面前请复制内容。', true);
  }
}

function loadProjectDraft(root) {
  if (!root || root === draftProject) return;
  draftProject = root; taskDrafts = createTaskDraftStore(draftStorage, root);
  followupSlot = ''; replySlot = ''; state.draft = '';
  $('#prompt').value = taskDrafts.load('new');
}

function restoreTaskDrafts(task) {
  if (!taskDrafts || !task) return;
  const nextFollowup = followupDraftKey(task);
  if (nextFollowup !== followupSlot) {
    followupSlot = nextFollowup; $('#followup-prompt').value = taskDrafts.load(followupSlot);
  }
  const nextReply = task.status === 'awaiting_response' ? replyDraftKey(task) : '';
  if (nextReply !== replySlot) { replySlot = nextReply; state.draft = replySlot ? taskDrafts.load(replySlot) : ''; }
}

function saveVisibleDrafts() {
  saveDraft('new', $('#prompt').value);
  if (followupSlot) saveDraft(followupSlot, $('#followup-prompt').value);
  const response = $('#manual-response');
  if (replySlot && response) saveDraft(replySlot, response.value);
}

function renderBrowserTargets(followupSelection) {
  const targets = state.workspace?.connection?.targets || [];
  for (const prefix of ['', 'followup-']) {
    const select = $(`#${prefix}browser-target`);
    const selected = prefix && followupSelection !== undefined ? followupSelection : select.value;
    const markup = targetChoices(targets, selected).map((option) => `<option value="${esc(option.value)}"${option.disabled ? ' disabled' : ''}>${esc(option.label)}</option>`).join('');
    if (select.innerHTML !== markup) { select.innerHTML = markup; select.value = selected; }
    $(`#${prefix}target-picker`).classList.toggle('hidden', $(`#${prefix}delivery`).value !== 'browser' || (!targets.length && !selected));
  }
}

function contextIsOpen() {
  return matchMedia('(max-width: 1100px)').matches ? document.body.classList.contains('context-open') : !document.body.classList.contains('context-hidden');
}

function syncContext() {
  const open = contextIsOpen();
  const overlay = open && matchMedia('(max-width: 1100px)').matches;
  $('#toggle-context').setAttribute('aria-expanded', String(open));
  $('#context-panel').setAttribute('aria-hidden', String(!open));
  $('#context-panel').setAttribute('role', overlay ? 'dialog' : 'complementary');
  if (overlay) $('#context-panel').setAttribute('aria-modal', 'true'); else $('#context-panel').removeAttribute('aria-modal');
  $('#context-scrim').hidden = !overlay;
}

function setContext(open, focusSearch = false) {
  document.body.classList.toggle('context-open', open);
  document.body.classList.toggle('context-hidden', !open);
  syncContext();
  if (open && (focusSearch || matchMedia('(max-width: 1100px)').matches)) $('#file-search').focus();
  if (!open && $('#context-panel').contains(document.activeElement)) $('#toggle-context').focus();
}

function renderDelivery() {
  renderBrowserTargets();
  const followup = state.task && !state.task.archived && terminal.has(state.task.status);
  const delivery = state.task ? followup ? $('#followup-delivery').value : state.task.delivery : $('#delivery').value;
  const manual = delivery === 'manual';
  const display = connectionAiDisplay(state.workspace?.connection, state.task ? state.task.delivery === 'manual' || state.task.manualResponse : manual, state.online);
  $('#ai-current').textContent = state.view === 'collaboration' ? '多模型协作' : state.task ? taskAiLabel(state.task) : display.label;
  $('#ai-current').title = display.detail;
  $('#ai-detail').textContent = '';
  const count = state.workspace?.browserConnections || 0;
  const fallback = state.task?.status === 'awaiting_response'
    ? '<button class="button secondary" type="button" data-focus-response>手动导入回复</button>'
    : !state.task || followup ? '<button class="button secondary" type="button" data-use-manual>改用手动传递</button>' : '';
  let title, message, buttons = '', ready = false;
  if (!state.online) {
    title = '本地服务已断开'; message = '请确认启动工作台的终端仍在运行。服务恢复后刷新页面。';
    buttons = '<button class="button secondary" type="button" data-refresh-page>刷新页面</button>';
  } else if (manual) {
    title = '手动传递'; ready = true;
    message = '开始后，先复制完整提示词给模型，再在任务中粘贴完整回复。无需连接扩展。';
  } else if (!count) {
    title = '浏览器扩展未连接';
    message = '当前无法自动发送任务。连接 Chrome 扩展，或切换为手动传递后继续。';
    buttons = '<button class="button secondary" type="button" data-open-help>查看扩展连接步骤</button>' + fallback;
  } else if (state.workspace?.connection?.state === 'no_tab') {
    title = '扩展已连接，AI 页面未就绪';
    message = '请打开并登录 AI 聊天网页，刷新该页面，等待输入框出现。扩展连接不等于模型已经可用。';
    buttons = '<button class="button secondary" type="button" data-open-help>查看连接步骤</button>' + fallback;
  } else {
    title = '浏览器扩展已连接'; ready = true;
    message = state.workspace?.connection?.state === 'legacy' ? '检测到旧版扩展通道。请在扩展管理页点击重新加载，再刷新 AI 网页，以启用稳定连接和页面就绪检测。' : `检测到 ${state.workspace?.connection?.readyTabs || 1} 个 AI 输入页面。任务将发送到 AI 标签页，请先只保留一个用于任务的页面。`;
  }
  const markup = `<strong>${esc(title)}</strong><p>${esc(message)}</p>${buttons ? `<div class="task-buttons">${buttons}</div>` : ''}`;
  if ($('#delivery-status').innerHTML !== markup) $('#delivery-status').innerHTML = markup;
  $('#delivery-status').classList.toggle('ready', ready);
  $('#delivery-status').classList.toggle('hidden', ready);
  $('#composer-hint').textContent = state.busy ? '正在读取项目，请稍候…' : 'Enter 发送 · Shift+Enter 换行';
}

function renderTaskBanner() {
  const task = state.task;
  $('#task-banner').classList.toggle('hidden', !task?.archived);
  if (!task?.archived) return;
  const markup = '<strong>已归档</strong><button class="button secondary" data-restore-conversation>移回最近对话</button>';
  $('#task-banner').className = 'task-banner';
  if ($('#task-banner').innerHTML !== markup) $('#task-banner').innerHTML = markup;
}

function focusManualResponse() {
  setView('work');
  const input = $('#manual-response');
  if (!input) return;
  const details = input.closest('details');
  if (details) details.open = true;
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  input.focus({ preventScroll: true });
}

async function api(url, body, method) {
  const response = await fetch(`/api/ui${url}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', 'x-workbench-token': state.token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || data.message || `请求失败 (${response.status})`); error.status = response.status; throw error; }
  return data;
}

function empty(title, description, icon = '◇') { return `<div class="empty-state"><span>${icon}</span><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`; }

function setView(view) {
  state.view = view;
  $$('.view').forEach((element) => element.classList.toggle('hidden', element.id !== `view-${view}`));
  $$('.nav-item').forEach((button) => { const active = button.dataset.view === view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  $('#breadcrumb-title').textContent = viewTitles[view];
  renderDelivery();
  $('#context-panel .task-details').classList.toggle('hidden', view === 'collaboration');
  $('#context-panel .context-footer').textContent = view === 'collaboration' ? '会诊最多附带8个文件，每个16000字，总计60000字；超限会提示，不静默截断。' : '最多 30 个文件；过大内容会截断。默认排除密钥与环境文件。';
  if (view === 'changes') renderChanges();
  if (view === 'logs') renderLogs();
  if (view === 'history') void loadHistory();
  if (view === 'collaboration') void collaborationUI.open();
  // A view switch must expose the task status and heading, instead of keeping
  // the scroll position of the previous reply input or long log.
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function setMode(mode) {
  state.mode = mode;
  $$('[data-mode]').forEach((button) => { button.classList.toggle('active', button.dataset.mode === mode); button.setAttribute('aria-pressed', String(button.dataset.mode === mode)); });
  $('#prompt').placeholder = mode === 'ask' ? '例如：梳理这个模块的调用关系，说明应该从哪里入手修改。' : '例如：为登录表单添加邮箱校验，并补充对应的测试。';
  renderScripts();
  $('#verification-hint').textContent = mode === 'ask' ? '项目问答只生成回答，不修改文件，也不运行验证脚本。' : '选中的项目脚本将在临时副本运行，具有本机进程权限。';
  fieldError('#form-error');
}

function renderWorkspace(workspace, resetScripts = false) {
  state.workspace = workspace;
  loadProjectDraft(workspace.root);
  $('#project-name').textContent = workspace.name;
  $('#project-path').textContent = workspace.root;
  $('#project-path').title = workspace.root;
  $('#file-count').textContent = workspace.totalFiles.toLocaleString();
  if (resetScripts) state.scripts = new Set(workspace.scripts.filter((script) => ['typecheck', 'test'].includes(script)));
  for (const file of state.selected) if (!workspace.files.includes(file)) state.selected.delete(file);
  renderFiles(); renderChips(); renderScripts(); renderConnection(workspace.browserConnections);
}

function renderConnection(count) {
  const element = $('#connection');
  const connection = state.workspace?.connection;
  element.classList.toggle('offline', !state.online || !count || connection?.state === 'no_tab');
  element.replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot'; element.append(dot);
  element.append(document.createTextNode(!state.online ? '服务已断开' : !count ? '扩展未连接' : connection?.state === 'no_tab' ? 'AI 页面未就绪' : connection?.state === 'ready' ? 'AI 页面就绪' : '扩展通道已连接'));
  element.title = !count ? '等待扩展自动重连；请保持 AI 页面打开，或改用手动传递' : `${count} 个扩展实例 · ${connection?.readyTabs ?? '未知'} 个就绪页面。页面有输入框不保证模型服务可用。`;
  renderDelivery();
}

function renderFiles() {
  if (!state.workspace) return;
  const query = $('#file-search').value.trim().toLowerCase();
  const matches = state.workspace.files.filter((file) => file.toLowerCase().includes(query));
  const visible = matches.slice(0, 350);
  $('#file-shown').textContent = `${matches.length} 个文件${matches.length > 350 ? ' · 显示前 350' : ''}`;
  const groups = new Map();
  for (const file of visible) { const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''; if (!groups.has(folder)) groups.set(folder, []); groups.get(folder).push(file); }
  $('#file-tree').innerHTML = visible.length ? [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([folder, files]) => {
    const collapsed = state.collapsed.has(folder) && !query;
    const heading = `<button class="folder-row" type="button" data-folder-toggle="${esc(folder)}" aria-expanded="${!collapsed}" title="${esc(folder || '项目根目录')}"><span>${collapsed ? '▸' : '▾'}</span><span>▱</span><span>${esc(folder || '项目根目录')}</span></button>`;
    return heading + (collapsed ? '' : files.map((file) => {
    const name = file.split('/').pop();
    const extension = name.includes('.') ? name.split('.').pop().slice(0, 3).toUpperCase() : '·';
    return `<div class="file-row${state.selected.has(file) ? ' selected' : ''}"><input type="checkbox" data-file-select="${esc(file)}" aria-label="附带 ${esc(file)}" ${state.selected.has(file) ? 'checked' : ''} ${state.contextLocked ? 'disabled' : ''}><span class="file-type">${esc(extension)}</span><button class="file-name" data-preview="${esc(file)}" title="预览 ${esc(file)}">${esc(name)}</button></div>`;
    }).join(''));
  }).join('') : '<p class="panel-description">没有匹配的文件</p>';
}

function renderChips() {
  $('#selected-count').textContent = `${state.selected.size} 已选`;
  $('#context-toggle-count').textContent = state.selected.size;
  $('#context-caption').textContent = state.selected.size ? `已选择 ${state.selected.size} 个上下文文件。点击文件标签旁的 × 可移除。` : '未附带文件，仅发送项目摘要。可在上下文侧栏选择源码。';
  $('#context-chips').innerHTML = state.selected.size
    ? [...state.selected].map((file) => `<span class="context-chip"><span title="${esc(file)}">${esc(file)}</span><button type="button" data-remove-context="${esc(file)}" aria-label="移除 ${esc(file)}">×</button></span>`).join('')
    : '';
  $('#followup-context').textContent = state.selected.size ? `${state.selected.size} 个上下文文件` : '';
}

function renderScripts() {
  const workspace = state.workspace;
  if (!workspace) return;
  $('#script-options').innerHTML = workspace.scripts.length ? workspace.scripts.map((name) => `<label class="script-option" title="${esc(workspace.scriptCommands[name])}"><input type="checkbox" data-script="${name}" ${state.scripts.has(name) ? 'checked' : ''} ${state.mode === 'ask' ? 'disabled' : ''}>${name}</label>`).join('') : '<span>未检测到验证脚本</span>';
  $('#followup-scripts').innerHTML = workspace.scripts.length ? workspace.scripts.map((name) => `<label class="script-option" title="${esc(workspace.scriptCommands[name])}"><input type="checkbox" data-script="${name}" ${state.scripts.has(name) ? 'checked' : ''} ${$('#followup-mode').value === 'ask' ? 'disabled' : ''}>${name}</label>`).join('') : '<span>未检测到验证脚本</span>';
}

async function refreshTasks() {
  const revision = tasksRevision;
  const tasks = await api('/tasks');
  if (revision !== tasksRevision || deleteInFlight || metadataInFlight) return;
  state.tasks = tasks; renderRecent(); updateSubmit();
}
function renderRecent() {
  const query = $('#conversation-search').value;
  const tasks = visibleConversations(state.tasks, showingArchived, query);
  $('#recent-label').textContent = showingArchived ? '归档对话' : '最近对话';
  $('#toggle-archived').textContent = showingArchived ? '返回最近' : `归档 ${state.tasks.filter((task) => task.archived).length}`;
  $('#toggle-archived').setAttribute('aria-pressed', String(showingArchived));
  const markup = tasks.length ? tasks.map((task) => `<div class="recent-task-row${task.id === state.task?.id ? ' active' : ''}"><button class="recent-task" data-task="${task.id}" title="${esc(task.title)} · ${esc(labels[task.status])}${task.pinned ? ' · 已置顶' : ''}"><span class="recent-title">${esc(task.title)}</span>${task.pinned ? '<svg class="recent-pin" aria-hidden="true" viewBox="0 0 24 24"><path d="m16 3 5 5-3 1-4 5 1 3-2 2-4-4-6 6 6-6-4-4 2-2 3 1 5-4 1-3Z"/></svg>' : ''}</button><button class="recent-more" type="button" data-task-more="${task.id}" aria-label="对话操作：${esc(task.title)}" title="对话操作" aria-haspopup="menu" aria-controls="conversation-menu" aria-expanded="false">⋯</button></div>`).join('') : `<p class="rail-empty">${query.trim() ? '没有匹配的对话' : showingArchived ? '暂无归档对话' : '暂无对话'}</p>`;
  // Polls must not replace identical buttons and steal keyboard/menu focus.
  if (recentMarkup !== markup) { $('#recent-tasks').innerHTML = markup; recentMarkup = markup; }
}

async function updateConversation(id, patch) {
  if (state.busy) throw new Error('请等待当前操作完成');
  metadataInFlight = true; state.busy = true; updateSubmit();
  try {
    const task = await api(`/tasks/${id}`, patch, 'PATCH');
    tasksRevision++;
    state.tasks = state.tasks.map((item) => item.id === id ? { ...item, title: task.title, pinned: task.pinned, archived: task.archived } : item);
    if (state.task?.id === id) { state.task = task; renderTask(true); }
    renderRecent();
    return task;
  } finally { metadataInFlight = false; state.busy = false; updateSubmit(); }
}

function showRenameTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || state.busy) return;
  renamingTaskId = id;
  $('#rename-task-input').value = task.title;
  fieldError('#rename-task-error');
  $('#rename-task-dialog').showModal();
  $('#rename-task-input').focus(); $('#rename-task-input').select();
}

async function conversationAction(action, id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || state.busy) return;
  if (action === 'delete') return showDeleteTask(id);
  if (action === 'rename') return showRenameTask(id);
  try {
    if (action === 'pin') { await updateConversation(id, { pinned: !task.pinned }); toast(task.pinned ? '已取消置顶' : '对话已置顶'); }
    if (action === 'archive') {
      await updateConversation(id, { archived: !task.archived });
      toast(task.archived ? '已移回最近对话' : '对话已归档。点击左侧“归档”可查看或移回。');
    }
  } catch (error) { toast(errorText(error), true); }
}

function showDeleteTask(id) {
  if (state.busy) return;
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  if (!terminal.has(task.status)) { toast('请先完成或停止本轮任务，再删除对话'); return; }
  deletingTaskId = id;
  $('#delete-task-title').textContent = task.title;
  fieldError('#delete-task-error');
  $('#delete-task-dialog').showModal();
  $('#cancel-delete-task').focus();
}

async function deleteTask() {
  if (!deletingTaskId || deleteInFlight || state.busy) return;
  const id = deletingTaskId;
  deleteInFlight = true; state.busy = true; updateSubmit();
  $('#confirm-delete-task').disabled = true; $('#cancel-delete-task').disabled = true;
  fieldError('#delete-task-error');
  try {
    await api(`/tasks/${id}`, {}, 'DELETE');
    const draftsCleared = !taskDrafts || taskDrafts.clearTask(id);
    tasksRevision++;
    state.tasks = state.tasks.filter((task) => task.id !== id);
    if (state.task?.id === id) {
      state.task = null; state.lastTaskMarkup = ''; state.draft = ''; followupTaskId = '';
      followupSlot = ''; replySlot = ''; $('#followup-prompt').value = ''; $('#prompt').value = taskDrafts?.load('new') || '';
      $('#change-count').textContent = '0'; $('#export-diff').disabled = true; $('#export-logs').disabled = true;
      renderTask(); renderChanges(); renderLogs(); setView('work');
    }
    renderRecent();
    $('#delete-task-dialog').close();
    $('#new-task').focus();
    toast(draftsCleared ? '对话已删除' : '对话已删除，但浏览器草稿未能清除。', !draftsCleared);
  } catch (error) { fieldError('#delete-task-error', errorText(error)); }
  finally {
    deleteInFlight = false; state.busy = false;
    $('#confirm-delete-task').disabled = false; $('#cancel-delete-task').disabled = false;
    renderRecent(); updateSubmit();
  }
}

function updateSubmit() { $('#submit-task').disabled = state.busy || isActive() || !state.online || state.needsRestart; $('#send-followup').disabled = state.busy || isActive() || !state.online || state.needsRestart || Boolean(state.task?.archived); renderDelivery(); }

function renderTask(force = false) {
  const task = state.task;
  const locked = Boolean(task && !terminal.has(task.status));
  if (state.contextLocked !== locked) { state.contextLocked = locked; renderFiles(); }
  $('#clear-context').disabled = locked;
  $('.panel-description').textContent = locked ? '本轮上下文已锁定' : '勾选文件，点击预览';
  document.body.classList.toggle('task-open', Boolean(task));
  $('#followup-form').classList.toggle('hidden', !task || task.archived || !terminal.has(task.status));
  if (task && followupTaskId !== task.id) {
    followupTaskId = task.id;
    $('#followup-mode').value = task.mode; $('#followup-delivery').value = task.delivery;
    renderBrowserTargets(task.browserTargetId || '');
    followupSlot = '';
    $('#followup-prompt').value = ''; fieldError('#followup-error'); renderScripts();
  }
  restoreTaskDrafts(task);
  renderTaskBanner();
  if (!task) { $('#task-card').classList.add('hidden'); renderOverview(); return; }
  $('#task-card').classList.remove('hidden');
  const signature = [task.id, task.title, task.archived, task.turns?.length || 0, task.status, task.attempt, task.response, task.error, task.plans.length, taskAiLabel(task), JSON.stringify(task.executionRuns), replySlot].join('|');
  if (signature !== state.lastTaskMarkup || force) {
    state.lastTaskMarkup = signature;
    const waiting = task.status === 'awaiting_response';
    const history = (task.turns || []).map((turn, index) => `<article class="conversation-turn">
      <header><span>第 ${index + 1} 轮 · ${turn.mode === 'ask' ? '项目问答' : '修改代码'}</span>${pill(turn.status)}</header>
      <p class="conversation-user">${esc(turn.prompt)}</p>
      ${turn.mode === 'ask' ? `<div class="conversation-assistant">${esc(turn.response)}</div>` : `<p class="followup-note">${esc((turn.changes || []).join(' · ') || '本轮没有文件方案')} · ${turn.status === 'complete' ? '已应用' : '未应用'}</p>${turn.response ? `<details><summary>查看本轮模型回复</summary><pre>${esc(turn.response)}</pre></details>` : ''}`}
      ${turn.executionRuns?.length ? executionHtml(turn.executionRuns) : ''}
      ${turn.error ? turn.status === 'needs_input' ? clarificationHtml(turn.error) : `<pre class="task-error">${esc(turn.error)}</pre>` : ''}</article>`).join('');
    $('#task-card').innerHTML = `<div class="task-card-heading"><h3>${esc(task.title)}</h3>${pill(task.status)}</div>
${task.collaborationSource ? `<div class="collab-task-source"><span>来自多模型会诊 · ${esc(task.collaborationSource.label)} · 原快照 ${esc(task.collaborationSource.snapshotDigest.slice(0, 12))}<br>本轮按当前代码生成方案，不沿用旧 Diff 批准。</span><button type="button" class="text-button" data-open-collaboration="${task.collaborationSource.roundId}">返回方案比较</button></div>` : ''}
${history ? `<div class="conversation-history" aria-label="本会话的历史对话">${history}</div><p class="current-turn-label">当前第 ${task.turns.length + 1} 轮</p><p class="conversation-user">${esc(task.prompt)}</p>` : task.collaborationSource ? `<p class="conversation-user">${esc(task.collaborationSource.taskSummary || '按已确认方案实施')}</p><details class="collab-implementation-requirements"><summary>查看已确认草案与实施要求</summary><pre class="collab-output">${esc(task.prompt)}</pre></details>` : task.title !== task.prompt ? `<p class="conversation-user">${esc(task.prompt)}</p>` : ''}
<div class="task-card-body">${task.attempt > 1 ? `<p class="form-note">第 ${task.attempt}/3 次尝试</p>` : ''}
<details data-browser-reception hidden><summary>接收详情</summary><div data-reception-content></div></details>
${task.mode === 'agent' ? executionHtml(task.executionRuns, task.status === 'complete') : ''}
${task.error ? task.status === 'needs_input' ? clarificationHtml(task.error) : `<div role="alert"><strong>本轮问题</strong>${task.executionRuns?.at(-1)?.detail === task.error.slice(-6000) ? '<p class="form-note">执行问题已记录，请展开上方“本次执行详情”查看原因。新的修改方案仍须审核 Diff。</p>' : `<pre class="task-error">${esc(task.error)}</pre>`}</div>` : ''}
${task.mode === 'ask' && task.response ? `<div class="answer">${esc(task.response)}</div>` : ''}
<div class="task-buttons">${task.status === 'review' ? '<button class="button primary" data-view="changes">查看并审核 Diff</button>' : ''}<button class="button secondary" data-view="logs">查看日志</button>
${!terminal.has(task.status) && task.status !== 'applying' ? '<button class="button danger" data-cancel>停止任务</button>' : ''}
${terminal.has(task.status) ? `${!task.archived ? `<button class="button primary" data-focus-followup>${task.status === 'needs_input' ? '回答' : '继续追问'}</button>` : ''}<button class="text-button" data-new>新任务</button>` : ''}</div>
${waiting ? `${task.delivery === 'browser' ? '<details class="manual-box"><summary>手动导入回复</summary>' : '<div class="manual-box">'}<div class="task-buttons"><button class="button secondary" data-copy-prompt>复制提示词</button><button class="text-button" data-show-prompt>查看提示词</button></div>
<label class="response-label" for="manual-response">模型回复</label><p id="response-help">${task.mode === 'agent' ? '粘贴完整 JSON，导入后审核 Diff。' : '粘贴完整回答。'}</p>
<textarea id="manual-response" aria-describedby="response-help response-error" placeholder="粘贴完整回复…">${esc(state.draft)}</textarea>
<div id="response-error" class="field-error hidden" role="alert" tabindex="-1"></div><button class="button primary" data-import-response>${task.mode === 'agent' ? '审核 Diff' : '导入回答'}</button>${task.delivery === 'browser' ? '</details>' : '</div>'}` : ''}</div>`;
  }
  const receptionPanel = $('[data-reception-content]');
  const receptionMarkup = task.delivery === 'browser' && !task.manualResponse ? browserReceptionHtml(task.reception, task.status === 'awaiting_response') : '';
  // Update just the diagnostic panel: polling must not rebuild/focus-reset
  // the manual reply textarea or destroy the user's draft selection.
  if (receptionPanel && receptionPanel.innerHTML !== receptionMarkup) receptionPanel.innerHTML = receptionMarkup;
  if ($('[data-browser-reception]')) $('[data-browser-reception]').hidden = !receptionMarkup;
  $('#change-count').textContent = task.plans.length;
  $('#export-diff').disabled = !task.plans.length;
  $('#export-logs').disabled = !task.logs.length;
  renderOverview();
  if (state.view === 'changes') renderChanges();
  if (state.view === 'logs') renderLogs();
}

function renderOverview() {
  const task = state.task;
  const status = task?.status;
  $('#overview-status').innerHTML = `<strong>${esc(task ? labels[status] : '准备就绪')}</strong><p>${task ? `第 ${task.attempt}/3 次尝试 · ${task.mode === 'ask' ? '项目问答' : '修改代码'}` : '描述任务后点击“开始任务”。'}</p>`;
  const step = !task ? 0 : ['awaiting_response', 'preparing'].includes(status) ? 1 : status === 'review' ? 2 : status === 'applying' ? 3 : status === 'complete' ? 4 : 0;
  $$('#step-list li').forEach((element, index) => { element.className = index < step ? 'done' : index === step ? 'current' : ''; });
}

function renderChanges() {
  const task = state.task;
  if (!task?.plans.length) { $('#changes-content').innerHTML = empty('还没有待审核的修改', '开始一个“修改代码”任务，模型返回方案后，文件 Diff 会显示在这里。', '⌘'); return; }
  const added = task.plans.flatMap((plan) => plan.diff.split('\n')).filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = task.plans.flatMap((plan) => plan.diff.split('\n')).filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  $('#changes-content').innerHTML = `<div class="change-summary"><strong>${task.plans.length} 项文件操作</strong><span>+${added} / −${removed} 行</span><span>${esc(labels[task.status])}</span></div>${task.plans.map((plan) => `<article class="diff-file"><header class="diff-heading"><span class="action-tag${plan.operation.action === 'DELETE_FILE' ? ' delete' : ''}">${esc(actions[plan.operation.action] || plan.operation.action)}</span><span>${esc(plan.operation.path)}${plan.operation.action === 'RENAME_FILE' ? ` → ${esc(plan.operation.replace)}` : ''}</span></header><div class="diff-body">${plan.diff.split('\n').map((line, index) => { const meta = /^(Index:|===|---|\+\+\+|@@)/.test(line); return `<div class="diff-line ${meta ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : ''}"><span class="line-number">${index + 1}</span><span class="line-code">${esc(line) || ' '}</span></div>`; }).join('')}</div></article>`).join('')}${task.status === 'review' ? `<div class="review-actions"><div><strong>只应用你已审核的修改</strong><p>${task.scripts.length ? `验证脚本：${esc(task.scripts.join('、'))} · 使用本机进程权限` : '本轮未选择验证脚本'}</p></div><div class="task-buttons"><button class="button danger" data-cancel>拒绝</button><button class="button primary" data-apply>批准并应用 ✓</button></div></div>` : `<p class="history-footnote">这份 Diff 来自本次方案。当前状态：${esc(labels[task.status])}。</p>`}`;
}

function renderLogs() {
  const task = state.task;
  if (!task) { $('#logs-content').innerHTML = empty('暂无运行日志', '任务开始后，这里会显示真实的执行步骤和验证输出。', '≡'); return; }
  const sameTask = $('#logs-content').dataset.taskId === task.id;
  const prior = sameTask && $('#log-stream'); const atBottom = !prior || prior.scrollHeight - prior.scrollTop - prior.clientHeight < 70;
  const scrollTop = prior?.scrollTop || 0;
  const expanded = sameTask ? [...$('#logs-content').querySelectorAll('details')].map((element) => element.open) : [];
  $('#logs-content').dataset.taskId = task.id;
  $('#logs-content').innerHTML = `${task.mode === 'agent' ? executionHtml(task.executionRuns, task.status === 'complete') : ''}<div class="logs-panel"><div class="logs-bar"><span>任务日志</span><span>${esc(labels[task.status])} · ${task.logs.length} 条</span></div><div class="log-stream" id="log-stream">${task.logs.map((log) => `<div class="log-entry"><span class="log-time">${esc(shortTime(log.time))}</span>${esc(log.text)}</div>`).join('')}</div></div>`;
  [...$('#logs-content').querySelectorAll('details')].forEach((element, index) => { element.open = Boolean(expanded[index]); });
  $('#log-stream').scrollTop = atBottom ? $('#log-stream').scrollHeight : scrollTop;
}

async function loadHistory() {
  try {
    state.history = await api('/history');
    $('#history-content').innerHTML = state.history.length ? `<div class="history-list">${state.history.map((entry) => `<article class="history-item"><header><h3>${esc(entry.summary)}</h3><time>${esc(time(entry.timestamp))}</time></header>${entry.detail ? `<p>${esc(entry.detail)}</p>` : ''}</article>`).join('')}</div><p class="history-footnote">最多展示最近 100 条本地操作记录。当前支持失败自动回滚，尚未提供历史版本手动回滚。</p>` : empty('还没有文件操作记录', '成功应用或失败回滚后，操作结果会保存在项目的 .openbrowser 目录。', '◷');
  } catch (error) { toast(error.message, true); }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
  catch { showPreview('复制内容', text, '浏览器未授予剪贴板权限，可在下方选中并复制。'); }
}
function showPreview(title, content, note = '') { $('#preview-title').textContent = title; $('#preview-content').textContent = content; $('#preview-note').textContent = note; $('#file-dialog').showModal(); }
function download(name, text) { const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); }

async function ensureBrowserConnection(delivery, selected = '') {
  if (delivery !== 'browser') return;
  const connection = await api('/connection');
  state.workspace.connection = connection; state.workspace.browserConnections = connection.browserConnections;
  renderConnection(connection.browserConnections);
  if (!connection.browserConnections) throw new Error('扩展尚未连接或正在重连。请保持 AI 网页打开，稍后重试；也可以选择手动传递。');
  if (connection.state === 'no_tab') throw new Error('扩展已连接，但没有就绪的 AI 输入页面。请登录并刷新 AI 网页，或选择手动传递。');
  return validateBrowserTarget(connection.targets || [], selected);
}

async function sendFollowUp(event) {
  event.preventDefault(); fieldError('#followup-error');
  if (state.busy || isActive() || !state.task) return;
  const draftText = $('#followup-prompt').value, prompt = draftText.trim(), sentSlot = followupSlot;
  if (!prompt) { fieldError('#followup-error', '请先填写要追问的问题或下一步修改要求。'); return; }
  state.busy = true; updateSubmit();
  try {
    const browserTargetId = await ensureBrowserConnection($('#followup-delivery').value, $('#followup-browser-target').value);
    const updated = await api(`/tasks/${state.task.id}/follow-up`, { prompt, mode: $('#followup-mode').value, delivery: $('#followup-delivery').value, browserTargetId, contextPaths: [...state.selected], scripts: $('#followup-mode').value === 'agent' ? [...state.scripts] : [] });
    saveDraft(sentSlot, '');
    if ($('#followup-prompt').value !== draftText) saveDraft(followupDraftKey(updated), $('#followup-prompt').value);
    else $('#followup-prompt').value = '';
    state.task = updated; state.draft = ''; renderTask(true); await refreshTasks();
    $('#task-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { fieldError('#followup-error', errorText(error)); }
  finally { state.busy = false; updateSubmit(); }
}

async function browseFolders(folder) {
  if (browsingFolders) return;
  browsingFolders = true; fieldError('#project-error'); $('#open-project').disabled = true;
  $('#folder-list').setAttribute('aria-busy', 'true');
  try {
    folderState = await api(`/folders${folder ? `?path=${encodeURIComponent(folder)}` : ''}`);
    $('#project-input').value = folderState.current;
    $('#folder-current').textContent = folderState.current;
    $('#folder-parent').disabled = !folderState.parent;
    $('#folder-shortcuts').innerHTML = `<button type="button" class="button secondary" data-folder-go="${esc(folderState.home)}">个人文件夹</button>${folderState.roots.map((root) => `<button type="button" class="button secondary" data-folder-go="${esc(root)}">${esc(root)}</button>`).join('')}`;
    $('#folder-list').innerHTML = folderState.folders.length ? folderState.folders.map((entry) => `<button type="button" class="folder-entry" data-folder-go="${esc(entry.path)}"><span aria-hidden="true">▱</span>${esc(entry.name)}<span aria-hidden="true">›</span></button>`).join('') : '<p class="folder-empty">此处没有可显示的子文件夹，可以直接选择当前文件夹。</p>';
    if (folderState.truncated) $('#folder-list').insertAdjacentHTML('beforeend', '<p class="folder-empty">仅显示前 500 个目录；可输入地址前往其他目录。</p>');
  } catch (error) { fieldError('#project-error', errorText(error)); }
  finally { browsingFolders = false; $('#folder-list').removeAttribute('aria-busy'); $('#open-project').disabled = !folderState || $('#project-input').value !== folderState.current; }
}

async function startTask(event) {
  event.preventDefault();
  fieldError('#form-error');
  if (state.busy || isActive()) { fieldError('#form-error', '请先完成或停止进行中的任务。'); return; }
  const draftText = $('#prompt').value, prompt = draftText.trim();
  if (!prompt) { fieldError('#form-error', '请先填写任务描述，例如：修复登录表单的邮箱校验。'); $('#prompt').setAttribute('aria-invalid', 'true'); return; }
  $('#prompt').removeAttribute('aria-invalid');
  state.busy = true; updateSubmit();
  try {
    const browserTargetId = await ensureBrowserConnection($('#delivery').value, $('#browser-target').value);
    state.task = await api('/tasks', { prompt, mode: state.mode, delivery: $('#delivery').value, browserTargetId, contextPaths: [...state.selected], scripts: state.mode === 'agent' ? [...state.scripts] : [] });
    if ($('#prompt').value === draftText) { $('#prompt').value = ''; saveDraft('new', ''); }
    state.draft = ''; $('#action-feedback').classList.add('hidden'); renderTask(true); await refreshTasks(); $('#task-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) { fieldError('#form-error', errorText(error)); }
  finally { state.busy = false; updateSubmit(); }
}

function newTask() {
  if (isActive()) { toast('请先完成或停止当前任务'); setView('work'); return; }
  saveVisibleDrafts();
  state.task = null; state.lastTaskMarkup = ''; state.draft = ''; followupSlot = ''; replySlot = '';
  $('#prompt').value = taskDrafts?.load('new') || ''; $('#change-count').textContent = '0';
  followupTaskId = '';
  fieldError('#form-error'); $('#action-feedback').classList.add('hidden');
  $('#export-diff').disabled = true; $('#export-logs').disabled = true; renderTask(); renderRecent(); setView('work'); $('#prompt').focus();
}

async function withButton(button, callback) {
  button.disabled = true; uiActions++;
  try { await callback(); } catch (error) {
    if (button.closest('#project-dialog')) fieldError('#project-error', errorText(error));
    else if (button.closest('#followup-form')) fieldError('#followup-error', errorText(error));
    else if (button.closest('.manual-box') && $('#response-error')) fieldError('#response-error', errorText(error));
    else { if (button.closest('#context-panel')) setContext(false); toast(errorText(error), true); }
  }
  finally { uiActions--; if (button.isConnected) button.disabled = false; }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-open-context')) { setContext(true, true); return; }
  if (button.hasAttribute('data-open-help')) { $('#help-dialog').showModal(); return; }
  if (button.hasAttribute('data-refresh-page')) { location.reload(); return; }
  if (button.hasAttribute('data-use-manual')) {
    if (state.task?.status === 'awaiting_response') { focusManualResponse(); return; }
    if (state.task && (!terminal.has(state.task.status) || state.task.archived)) return;
    const prefix = state.task ? 'followup-' : '';
    $(`#${prefix}delivery`).value = 'manual'; renderDelivery();
    fieldError(state.task ? '#followup-error' : '#form-error');
    $(`#${prefix}prompt`).focus(); return;
  }
  if (button.hasAttribute('data-focus-response')) { focusManualResponse(); return; }
  if (button.hasAttribute('data-focus-followup')) { setView('work'); $('#followup-prompt').focus(); $('#followup-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (button.dataset.folderGo) { void browseFolders(button.dataset.folderGo); return; }
  if (button.hasAttribute('data-folder-toggle')) { const folder = button.dataset.folderToggle; if (state.collapsed.has(folder)) state.collapsed.delete(folder); else state.collapsed.add(folder); renderFiles(); return; }
  if (button.dataset.view) return setView(button.dataset.view);
  if (button.dataset.openCollaboration) return withButton(button, async () => { await collaborationUI.openRound(button.dataset.openCollaboration); setView('collaboration'); });
  if (button.dataset.mode) return setMode(button.dataset.mode);
  if (button.dataset.removeContext) { state.selected.delete(button.dataset.removeContext); renderFiles(); renderChips(); return; }
  if (button.dataset.suggestion) { $('#prompt').value = button.dataset.suggestion; saveDraft('new', button.dataset.suggestion); setMode(button.dataset.suggestionMode || 'agent'); $('#prompt').focus(); return; }
  if (button.hasAttribute('data-close-dialog')) return button.closest('dialog').close();
  if (button.hasAttribute('data-new')) return newTask();
  if (button.hasAttribute('data-restore-conversation') && state.task) return conversationAction('archive', state.task.id);
  if (button.dataset.task) return withButton(button, async () => { saveVisibleDrafts(); state.task = await api(`/tasks/${button.dataset.task}`); state.selected = new Set(state.task.contextPaths.filter((file) => state.workspace.files.includes(file))); renderChips(); renderTask(true); renderRecent(); setView('work'); });
  if (button.dataset.preview) return withButton(button, async () => { const file = await api(`/file?path=${encodeURIComponent(button.dataset.preview)}`); showPreview(file.path, file.content, file.truncated ? '文件较大，仅显示前 100 KB。' : '只读预览 · 勾选文件后才会发送给模型'); });
  if (button.hasAttribute('data-copy-prompt')) return copy(state.task.promptMessage);
  if (button.hasAttribute('data-show-prompt')) return showPreview('发送给模型的完整提示词', state.task.promptMessage, '包含任务描述、所选上下文与操作协议');
  if (button.hasAttribute('data-import-response')) return withButton(button, async () => {
    fieldError('#response-error');
    const draftText = $('#manual-response').value, text = draftText.trim(), sentSlot = replySlot; if (!text) throw new Error('请先粘贴模型的完整回复');
    state.task = await api(`/tasks/${state.task.id}/response`, { text });
    if ($('#manual-response').value === draftText) { state.draft = ''; saveDraft(sentSlot, ''); }
    renderTask(true); await refreshTasks(); if (state.task.status === 'review') setView('changes');
  });
  if (button.hasAttribute('data-cancel')) return withButton(button, async () => { state.task = await api(`/tasks/${state.task.id}/cancel`, {}); renderTask(true); await refreshTasks(); toast('已停止，待审核修改未应用'); });
  if (button.hasAttribute('data-apply')) return withButton(button, async () => { state.task = await api(`/tasks/${state.task.id}/apply`, {}); renderTask(true); await refreshTasks(); setView('logs'); toast('已批准，开始应用与验证'); });
});

document.addEventListener('change', (event) => {
  const input = event.target;
  if (input.dataset.fileSelect) {
    if (input.checked && state.selected.size >= 30) { input.checked = false; toast('最多选择 30 个上下文文件'); return; }
    if (input.checked) state.selected.add(input.dataset.fileSelect); else state.selected.delete(input.dataset.fileSelect);
    renderFiles(); renderChips();
  }
  if (input.dataset.script) { if (input.checked) state.scripts.add(input.dataset.script); else state.scripts.delete(input.dataset.script); renderScripts(); }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'manual-response') { state.draft = event.target.value; saveDraft(replySlot, state.draft); fieldError('#response-error'); }
  if (event.target.id === 'prompt') { saveDraft('new', event.target.value); $('#prompt').removeAttribute('aria-invalid'); fieldError('#form-error'); }
  if (event.target.id === 'followup-prompt') { saveDraft(followupSlot, event.target.value); fieldError('#followup-error'); }
  if (event.target.id === 'project-input') { fieldError('#project-error'); $('#open-project').disabled = !folderState || event.target.value !== folderState.current; }
});
$('#file-search').addEventListener('input', renderFiles);
$('#conversation-search').addEventListener('input', renderRecent);
$('#clear-context').addEventListener('click', () => { state.selected.clear(); renderFiles(); renderChips(); });
$('#delivery').addEventListener('change', () => { renderDelivery(); fieldError('#form-error'); });
$('#toggle-context').addEventListener('click', () => setContext(!contextIsOpen()));
$('#close-context').addEventListener('click', () => setContext(false));
$('#context-scrim').addEventListener('click', () => setContext(false));
$('#dismiss-feedback').addEventListener('click', () => $('#action-feedback').classList.add('hidden'));
window.addEventListener('resize', syncContext);
window.addEventListener('beforeunload', saveVisibleDrafts);
$('#task-form').addEventListener('submit', startTask);
$('#followup-form').addEventListener('submit', sendFollowUp);
installConversationMenu(document, {
  getTask: (id) => state.tasks.find((task) => task.id === id),
  canManage: (task) => terminal.has(task.status) && !state.busy && state.online && !state.needsRestart,
  onAction: (action, id) => { void conversationAction(action, id); },
});
$('#toggle-archived').addEventListener('click', () => { showingArchived = !showingArchived; renderRecent(); });
$('#rename-task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (metadataInFlight || !renamingTaskId) return;
  const title = $('#rename-task-input').value.trim();
  if (!title || title.length > 200) { fieldError('#rename-task-error', '请输入 1–200 字的对话名称。'); return; }
  $('#save-rename-task').disabled = true; $('#cancel-rename-task').disabled = true;
  fieldError('#rename-task-error');
  try { await updateConversation(renamingTaskId, { title }); $('#rename-task-dialog').close(); toast('对话已重命名'); }
  catch (error) { fieldError('#rename-task-error', errorText(error)); }
  finally { $('#save-rename-task').disabled = false; $('#cancel-rename-task').disabled = false; }
});
$('#cancel-rename-task').addEventListener('click', () => { if (!metadataInFlight) $('#rename-task-dialog').close(); });
$('#rename-task-dialog').addEventListener('cancel', (event) => { if (metadataInFlight) event.preventDefault(); });
$('#rename-task-dialog').addEventListener('close', () => { renamingTaskId = ''; $('#new-task').focus(); });
$('#confirm-delete-task').addEventListener('click', deleteTask);
$('#cancel-delete-task').addEventListener('click', () => { if (!deleteInFlight) $('#delete-task-dialog').close(); });
$('#delete-task-dialog').addEventListener('cancel', (event) => { if (deleteInFlight) event.preventDefault(); });
$('#delete-task-dialog').addEventListener('close', () => { deletingTaskId = ''; $('#new-task').focus(); });
$('#followup-mode').addEventListener('change', renderScripts);
$('#followup-delivery').addEventListener('change', () => { renderDelivery(); fieldError('#followup-error'); });
$('#browser-target').addEventListener('change', () => fieldError('#form-error'));
$('#followup-browser-target').addEventListener('change', () => fieldError('#followup-error'));
$('#new-task').addEventListener('click', newTask);
$('#help').addEventListener('click', () => $('#help-dialog').showModal());
$('#switch-project').addEventListener('click', () => { if (state.needsRestart) { toast('请先重新启动本地工作台服务，再使用新版文件夹选择。', true); return; } fieldError('#project-error'); folderState = null; $('#project-input').value = state.workspace?.root || ''; $('#project-dialog').showModal(); void browseFolders(state.workspace?.root); });
$('#browse-address').addEventListener('click', () => { void browseFolders($('#project-input').value.trim()); });
$('#folder-parent').addEventListener('click', () => { if (folderState?.parent) void browseFolders(folderState.parent); });
$('#project-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void browseFolders(event.target.value.trim()); } });
$('#project-form').addEventListener('submit', (event) => {
  event.preventDefault(); void withButton($('#open-project'), async () => {
    fieldError('#project-error');
    if (!folderState || browsingFolders || $('#project-input').value !== folderState.current) throw new Error('请先进入要选择的文件夹，再点击选择。');
    saveVisibleDrafts();
    const workspace = await api('/project', { root: folderState.current });
    $('#conversation-search').value = '';
    state.selected.clear(); state.task = null; state.lastTaskMarkup = ''; state.draft = ''; renderWorkspace(workspace, true); renderTask(); $('#change-count').textContent = '0'; await refreshTasks(); setView('work'); $('#project-dialog').close(); toast('项目已打开');
  });
});
$('#refresh').addEventListener('click', () => withButton($('#refresh'), async () => { renderWorkspace(await api('/workspace')); await refreshTasks(); toast('项目和连接状态已更新'); }));
$('#refresh-history').addEventListener('click', loadHistory);
$('#export-diff').addEventListener('click', () => { if (state.task) download('openbrowser-changes.diff', state.task.plans.map((plan) => plan.diff).join('\n')); });
$('#export-logs').addEventListener('click', () => { if (state.task) download('openbrowser-task.log', state.task.logs.map((log) => `${log.time}\n${log.text}`).join('\n\n')); });
installEnterToSend(document, (inputId) => {
  if (state.busy || isActive() || !state.online || state.needsRestart || state.view !== 'work') return;
  const form = $(inputId === 'prompt' ? '#task-form' : '#followup-form');
  const button = $(inputId === 'prompt' ? '#submit-task' : '#send-followup');
  if (button.disabled || form.getClientRects().length === 0) return;
  form.requestSubmit(button);
});
let navigationStorage;
try { navigationStorage = window.localStorage; } catch { /* Navigation still works without saved preferences. */ }
installNavigationToggle(document, navigationStorage);

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || $('#conversation-menu').matches(':popover-open')) return;
  if (event.key === 'Escape' && document.body.classList.contains('context-open') && !$$('dialog[open]').length) { setContext(false); return; }
  if (event.key === 'Tab' && contextIsOpen() && matchMedia('(max-width: 1100px)').matches && !$$('dialog[open]').length) {
    const controls = [...$('#context-panel').querySelectorAll('button:not([disabled]), input:not([disabled]), summary')].filter((element) => element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if (event.altKey && event.key.toLowerCase() === 'n' && !$$('dialog[open]').length) { event.preventDefault(); newTask(); }
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !$$('dialog[open]').length) { event.preventDefault(); setContext(true, true); }
});

async function poll() {
  if (polling || !state.token || state.busy || uiActions || deleteInFlight || metadataInFlight) return;
  polling = true;
  try {
    if (state.task && !terminal.has(state.task.status)) {
      const previous = state.task, project = state.workspace.root, priorStatus = previous.status;
      const updated = await api(`/tasks/${previous.id}`);
      if (state.task !== previous || state.workspace.root !== project || state.busy || uiActions) return;
      state.task = updated; renderTask();
      if (state.task.status !== priorStatus) { await refreshTasks(); if (state.task.status === 'review') setView('changes'); }
    }
    if (pollCount++ % 2 === 0) { const status = await api('/connection'); state.workspace.browserConnections = status.browserConnections; state.workspace.connection = status; await refreshTasks(); }
    state.online = true; renderConnection(state.workspace.browserConnections);
  } catch (error) {
    state.online = false; renderConnection(0);
    if (error.status === 401) {
      try {
        const previousId = state.task?.id;
        const data = await api('/bootstrap'); state.token = data.token; state.needsRestart = data.protocolVersion !== 4; state.task = null; state.lastTaskMarkup = ''; followupTaskId = ''; renderWorkspace(data.workspace, true); await refreshTasks();
        const restored = state.tasks.find((task) => task.id === previousId && task.root === state.workspace.root) || state.tasks.find((task) => task.root === state.workspace.root && !terminal.has(task.status));
        if (restored) { state.task = await api(`/tasks/${restored.id}`); state.selected = new Set(state.task.contextPaths.filter((file) => state.workspace.files.includes(file))); renderChips(); }
        renderTask(true); renderChanges(); renderLogs(); state.online = true;
        toast('本地服务已重连，已保存的对话仍保留。中断任务已暂停，旧 Diff 批准失效，不会自动重发或执行；可在原对话继续。');
      } catch { /* Keep retrying the local connection without submitting tasks. */ }
    }
  }
  finally { polling = false; updateSubmit(); }
}

async function init() {
  try {
    const data = await api('/bootstrap'); state.token = data.token; state.needsRestart = data.protocolVersion !== 4; renderWorkspace(data.workspace, true); await refreshTasks();
    if (state.needsRestart) toast('页面与本地服务版本不兼容，请先备份会话，再重新构建并重启工作台。已保存记录会恢复，中断任务暂停，旧批准不会重放。', true);
    const active = state.tasks.find((task) => task.root === state.workspace.root && !terminal.has(task.status));
    if (active) { state.task = await api(`/tasks/${active.id}`); state.selected = new Set(state.task.contextPaths.filter((file) => state.workspace.files.includes(file))); renderChips(); renderTask(); }
    renderChanges(); renderLogs(); updateSubmit(); syncContext(); setInterval(poll, 1100);
  } catch (error) { state.online = false; renderConnection(0); toast(`工作台连接失败：${error.message}`, true); updateSubmit(); }
}
const collaborationUI = installCollaboration({
  api, getWorkspace: () => state.workspace, getSelected: () => [...state.selected],
  onRestoreContext: (paths) => { state.selected = new Set(paths.filter((path) => state.workspace?.files.includes(path))); renderFiles(); renderChips(); },
  onOpenTask: async (id, root) => {
    if (root !== state.workspace?.root) throw new Error('请切换回实施任务所属项目');
    const task = await api(`/tasks/${id}`);
    if (task.root !== state.workspace.root) throw new Error('实施任务不属于当前项目');
    state.task = task; state.selected = new Set(task.contextPaths.filter((path) => state.workspace.files.includes(path)));
    saveVisibleDrafts(); renderChips(); renderTask(true); await refreshTasks();
    setView(task.status === 'review' ? 'changes' : 'work');
    toast('已打开关联实施任务，文件修改仍需你审核并批准 Diff。');
  },
  onHandoff: (prompt, root) => {
    if (isActive() || state.busy) throw new Error('请先完成或停止单模型任务，再带入草案。');
    if (root !== state.workspace?.root) throw new Error('请先切换到会诊所属项目。');
    if (prompt.length > 16000) throw new Error('草案过长，请先精简后粘贴到新任务。');
    newTask(); setMode('agent'); $('#prompt').value = prompt; saveDraft('new', prompt);
    toast('草案已带入，尚未发送。请核对上下文，再开始任务；文件修改仍需审核 Diff。');
  },
});
void init();
