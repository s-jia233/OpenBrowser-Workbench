export function targetChoices(targets = [], selected = '') {
  const options = [{ value: '', label: targets.length > 1 ? '请选择执行网页' : '自动选择' }];
  for (const target of targets) options.push({ value: target.id, label: `${target.name} · 标签页 ${target.tabId}` });
  if (selected && !targets.some((target) => target.id === selected)) options.push({ value: selected, label: '已离线，请重选', disabled: true });
  return options;
}

export function validateBrowserTarget(targets = [], selected = '') {
  if (selected && !targets.some((target) => target.id === selected)) throw new Error('指定执行网页已离线，请重新选择');
  if (!selected && targets.length > 1) throw new Error('请选择本轮执行网页');
  return selected || undefined;
}
