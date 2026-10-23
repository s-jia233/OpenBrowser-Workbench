export function connectionAiDisplay(connection = {}, manual = false, online = true) {
  if (!online) return { label: '当前 AI：服务未连接', detail: '本地服务恢复后刷新页面。' };
  if (manual) return { label: '当前 AI：手动传递', detail: '手动复制和粘贴，无法自动识别来源 AI。' };
  if (!connection.browserConnections || connection.state === 'disconnected') return { label: '当前 AI：未连接', detail: '连接浏览器扩展并打开 AI 聊天页面。' };
  if (connection.state === 'no_tab' || connection.readyTabs === 0) return { label: '当前 AI：无就绪页面', detail: '扩展已连接，请登录并刷新 AI 网页。' };
  const names = [...new Set((connection.providers || []).map((provider) => provider.name))];
  if (!names.length) return { label: '当前 AI：未识别', detail: '请重新加载扩展 0.8.5 并刷新 AI 网页；旧版连接不会报告平台名称。' };
  const multiple = connection.readyTabs > 1 || names.length > 1;
  return { label: `${multiple ? '就绪 AI' : '当前 AI'}：${names.join('、')}`,
    detail: multiple ? `${connection.readyTabs ?? names.length} 个页面已就绪，以任务中的实际接单 AI 为准；建议只保留一个用于任务的页面。`
      : '平台由扩展报告，具体模型版本未识别；本轮接单后会在任务中确认。' };
}

export function taskAiLabel(task) {
  if (task.delivery === 'manual' || task.manualResponse) return '本轮 AI：手动传递（无法自动识别）';
  if (task.ai) return `本轮 AI：${task.ai.name}`;
  if (task.aiPending) return '本轮 AI：等待实际接单';
  return '本轮 AI：未识别（旧版扩展或历史记录未报告）';
}
