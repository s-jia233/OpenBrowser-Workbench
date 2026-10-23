const composerIds = new Set(['prompt', 'followup-prompt']);

export function installEnterToSend(document, send, now = Date.now) {
  let composing = false;
  let compositionEndedAt = -Infinity;
  document.addEventListener('compositionstart', (event) => { if (composerIds.has(event.target?.id)) composing = true; });
  document.addEventListener('compositionend', (event) => {
    if (composerIds.has(event.target?.id)) { composing = false; compositionEndedAt = now(); }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !composerIds.has(event.target?.id) || event.shiftKey || event.altKey || event.repeat ||
      event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing || now() - compositionEndedAt < 50 || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    send(event.target.id);
  });
}

export function installNavigationToggle(document, storage) {
  const button = document.querySelector('#toggle-navigation');
  const navigation = document.querySelector('#navigation-panel');
  if (!button || !navigation) return;
  const apply = (open, remember = true) => {
    if (!open && navigation.contains(document.activeElement)) button.focus();
    document.body.classList.toggle('navigation-hidden', !open);
    navigation.setAttribute('aria-hidden', String(!open));
    navigation.inert = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? '隐藏导航侧栏' : '显示导航侧栏');
    button.title = open ? '隐藏导航侧栏' : '显示导航侧栏';
    if (remember) { try { storage?.setItem('openbrowser.navigationHidden', String(!open)); } catch { /* Browser storage may be disabled. */ } }
  };
  let open = true;
  try { open = storage?.getItem('openbrowser.navigationHidden') !== 'true'; } catch { /* Default remains usable without storage. */ }
  apply(open, false);
  button.addEventListener('click', () => apply(document.body.classList.contains('navigation-hidden')));
}
