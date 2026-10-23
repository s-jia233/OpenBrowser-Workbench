export function visibleConversations(tasks, archived = false, query = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter((task) => Boolean(task.archived) === archived)
    .filter((task) => words.every((word) => String(task.title || '').toLocaleLowerCase().includes(word)))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
}

export function menuPosition(anchor, size, viewport) {
  const gap = 8;
  const left = Math.max(gap, Math.min(anchor.right - 10, viewport.width - size.width - gap));
  const below = anchor.bottom + 4;
  const top = Math.max(gap, Math.min(below, viewport.height - size.height - gap));
  return { left, top };
}

/** Native popover supplies light-dismiss and a top layer outside the scrolling rail. */
export function installConversationMenu(document, { getTask, canManage, onAction }) {
  const menu = document.querySelector('#conversation-menu');
  let taskId = '', source = null;
  const isOpen = () => menu.matches(':popover-open');
  const close = (restoreFocus = false) => {
    if (isOpen()) menu.hidePopover();
    source?.setAttribute('aria-expanded', 'false');
    const trigger = source?.isConnected ? source : taskId ? document.querySelector(`[data-task-more="${taskId}"]`) : null;
    if (restoreFocus) trigger?.focus();
    taskId = ''; source = null;
  };
  const open = (button) => {
    const id = button.dataset.taskMore;
    if (isOpen() && taskId === id) { close(true); return; }
    close();
    const task = getTask(id);
    if (!task) return;
    taskId = id; source = button;
    menu.querySelector('[data-pin-label]').textContent = task.pinned ? '取消置顶' : '置顶';
    menu.querySelector('[data-archive-label]').textContent = task.archived ? '移回最近对话' : '归档';
    const allowed = canManage(task);
    for (const item of menu.querySelectorAll('[role="menuitem"]')) item.disabled = !allowed;
    menu.querySelector('.menu-note').hidden = allowed;
    menu.showPopover();
    const position = menuPosition(button.getBoundingClientRect(), menu.getBoundingClientRect(), {
      width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
    });
    menu.style.left = `${position.left}px`; menu.style.top = `${position.top}px`;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  };
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button?.dataset.taskMore) { open(button); return; }
    if (button?.dataset.conversationAction && menu.contains(button) && !button.disabled) {
      const id = taskId, action = button.dataset.conversationAction;
      close(true);
      onAction(action, id);
    }
  });
  document.addEventListener('keydown', (event) => {
    const trigger = event.target.closest('[data-task-more]');
    if (trigger && event.key === 'ArrowDown') { event.preventDefault(); open(trigger); return; }
    if (!isOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  });
  menu.addEventListener('toggle', () => { if (!isOpen()) close(); });
  document.addEventListener('scroll', (event) => { if (isOpen() && !menu.contains(event.target)) close(); }, true);
  document.defaultView.addEventListener('resize', () => close());
  return { close };
}
