const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const changes = { in_progress: '文件事务进行中', applied: '修改已应用', rolled_back: '本轮修改已回滚', rollback_failed: '回滚未完成，请人工检查', not_applied: '尚未写入文件', unknown: '文件状态未确认' };
export function clarificationHtml(question) {
  return `<section class="clarification-card" aria-label="待回答的问题"><p class="clarification-question">${esc(question)}</p></section>`;
}
const verification = { not_run: '尚未运行验证', running: '验证运行中', passed: '所选验证项目通过', skipped: '未执行验证，不代表测试通过', failed: '验证失败', setup_failed: '验证环境或配置异常，未完成验证', unknown: '验证结果未确认' };
const receptionReasons = {
  awaiting_turn: '尚未定位到本轮提问，也没有匹配的本轮回复编号', ambiguous_turn: '发现多个新提问，不能安全判断本轮回复',
  awaiting_answer: '已定位本轮提问，等待新回复节点', analysis: '目前只识别到思考区域，等待最终正文', mixed_analysis: '正文与思考区域尚未可靠分离',
  invalid_json: '已找到正文，等待完整且匹配本会话的 JSON', structure_unknown: '尚未识别到当前网页的消息结构',
  generating: '网页仍有生成中标记', awaiting_completion: '已匹配完整正文，但尚未识别到生成结束信号', settling: '已匹配完整正文，正在确认稳定', returning: '完整回复已识别，准备回传',
};
export function browserReceptionHtml(reception, waiting = true) {
  if (!reception) return waiting ? '<p class="form-note">尚未收到扩展的接收诊断。网页若已有完整回复，请勿重复发送，可使用下方手动粘贴备用入口。</p>' : '';
  const count = (value) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const stream = { pending: '等待结束', done: '已结束', error: '中断或未捕获正文' }[reception.stream] || '未知';
  const match = { user: '按本轮提问匹配', stream_id: '按本轮回复编号匹配', none: '尚未匹配本轮消息' }[reception.matchedBy] || '定位方式未知';
  return `<section class="execution-result" aria-label="网页回复接收状态"><strong>${waiting ? '自动接收状态' : '本轮最后接收状态（历史记录）'}</strong><p>${esc(receptionReasons[reception.reason] || '接收状态未知')}<br>扩展 ${esc(reception.version)} · 已等待 ${Math.round(count(reception.elapsedMs) / 1000)} 秒 · 回复流${stream}<br>${match}<br>流式正文 ${count(reception.streamChars)} 字 · 页面正文 ${count(reception.pageChars)} 字 · 本轮提问 ${count(reception.currentUsers)} 个（用户 ${count(reception.users)} / 助手 ${count(reception.assistants)}）</p><p class="form-note">这里只显示接收过程，不代表模型方案已验证或文件已修改。</p></section>`;
}
export function executionText(run) {
  const passed = Array.isArray(run.passed) ? run.passed : [], requested = Array.isArray(run.requested) ? run.requested : [];
  const status = run.verification === 'passed' && (!passed.length || requested.some((script) => !passed.includes(script))) ? 'unknown' : run.verification;
  return { changes: changes[run.changes] || changes.unknown, verification: verification[status] || verification.unknown,
    requested: requested.join('、') || '未选择', passed: passed.join('、') || '无已确认通过项' };
}
export function executionHtml(runs = [], legacy = false) {
  if (!runs.length) return legacy ? '<p class="form-note">执行结果未记录，详见日志。</p>' : '';
  const card = (run) => {
    const result = executionText(run);
    const caution = ['rollback_failed', 'unknown', 'rolled_back'].includes(run.changes) || ['failed', 'setup_failed', 'unknown'].includes(run.verification);
    return `<div class="execution-result${caution ? ' caution' : run.changes === 'applied' && result.verification === verification.passed ? ' verified' : ''}"><strong>${esc(result.changes)} · ${esc(result.verification)}</strong><p>所选验证：${esc(result.requested)}<br>已确认通过：${esc(result.passed)}</p>${run.detail ? `<details><summary>本次执行详情</summary><pre>${esc(run.detail)}</pre></details>` : ''}</div>`;
  };
  const latest = runs.at(-1);
  return `<section class="execution-summary" aria-label="实际执行结果"><h4>最近一次实际执行 · 第 ${esc(latest.attempt)}/3 次尝试</h4>${card(latest)}${runs.length > 1 ? `<details class="execution-history"><summary>此前 ${runs.length - 1} 次执行记录</summary>${runs.slice(0, -1).map((run) => `<p>第 ${esc(run.attempt)}/3 次尝试</p>${card(run)}`).join('')}</details>` : ''}</section>`;
}
