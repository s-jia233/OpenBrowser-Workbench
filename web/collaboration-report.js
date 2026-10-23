const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const isText = (value, limit = 3000) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const isList = (value) => Array.isArray(value) && value.length <= 12 && value.every((item) => isText(item, 1000));

export function parseComparison(text, proposals) {
  if (typeof text !== 'string' || text.length > 16000) return null;
  try {
    const source = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
    const value = JSON.parse(source);
    const expected = proposals.flatMap((job, index) => job.status === 'complete' ? [String.fromCharCode(65 + index)] : []);
    if (!value || value.version !== 1 || !isText(value.summary) || !isText(value.recommendation) || !isList(value.conflicts) || !Array.isArray(value.comparisons) || value.comparisons.length !== expected.length) return null;
    const seen = new Set();
    const comparisons = [];
    for (const row of value.comparisons) {
      if (!row || !expected.includes(row.candidate) || seen.has(row.candidate) || !isText(row.coverage) || !isText(row.verificationPlan) ||
        !['strengths', 'risks', 'evidence', 'mergeable'].every((key) => isList(row[key]))) return null;
      seen.add(row.candidate);
      comparisons.push({ candidate: row.candidate, coverage: row.coverage, verificationPlan: row.verificationPlan,
        strengths: row.strengths, risks: row.risks, evidence: row.evidence, mergeable: row.mergeable });
    }
    return { summary: value.summary, recommendation: value.recommendation, conflicts: value.conflicts,
      comparisons: expected.map((candidate) => comparisons.find((row) => row.candidate === candidate)) };
  } catch { return null; }
}

export function comparisonHtml(text, proposals) {
  const report = parseComparison(text, proposals);
  if (!report) return '<p class="collab-notice">评审回复未符合结构化格式，已保留下面的完整原文，不据此生成分数或结论。</p>';
  const list = (items) => items.length ? `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<span class="form-note">未提供</span>';
  const rows = proposals.map((job, index) => {
    const candidate = String.fromCharCode(65 + index), row = report.comparisons.find((item) => item.candidate === candidate);
    return row ? `<tr><th scope="row">方案 ${candidate}</th><td>${esc(row.coverage)}</td><td>${list(row.strengths)}</td><td>${list(row.risks)}</td><td>${list(row.evidence)}</td><td>${esc(row.verificationPlan)}<br><strong>未实际运行测试</strong></td><td>${list(row.mergeable)}</td></tr>` :
      `<tr><th scope="row">方案 ${candidate}</th><td colspan="6">此方案未成功返回，不参与评估。</td></tr>`;
  }).join('');
  return `<section class="collab-comparison" aria-label="方案结构化对照表"><h3>方案对照 · AI 观点，非验证结果</h3><p>${esc(report.summary)}</p><p class="form-note">表格可横向滚动查看全部栏目，也可收起右侧上下文扩大阅读区域。</p><div class="collab-table-scroll" tabindex="0" role="region" aria-label="可横向滚动的方案对照表"><table><thead><tr><th scope="col">方案</th><th scope="col">需求覆盖</th><th scope="col">优势</th><th scope="col">风险</th><th scope="col">代码依据 / 待核查</th><th scope="col">验证计划</th><th scope="col">可融合部分</th></tr></thead><tbody>${rows}</tbody></table></div><h4>评审建议 · 由你决定</h4><p>${esc(report.recommendation)}</p><h4>分歧与冲突</h4>${list(report.conflicts)}</section>`;
}

function fenced(value) {
  const text = String(value ?? ''), runs = text.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}
const inline = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#!|]/g, '\\$&');
export function exportCollaboration(round) {
  const jobText = (job) => {
    const origin = job.manualReply ? '手动粘贴，来源未核实' : job.reportedSource || '尚未确认实际来源';
    const history = (job.attemptHistory || []).map((attempt) => `- 第${attempt.attempt}次：${inline(attempt.endpoint.kind)} / ${inline(attempt.endpoint.label)}\n${fenced(attempt.error || '失败')}`).join('\n');
    return `### ${inline(job.label)}\n\n- 状态：${inline(job.status)}\n- 当前尝试：${job.attempt || 1}/3\n- 来源：${inline(origin)}\n- 验证：未实际运行代码测试\n\n${job.error ? fenced(job.error) + '\n\n' : ''}${job.response ? fenced(job.response) : '尚无成功回复。'}${history ? '\n\n尝试记录：\n' + history : ''}`;
  };
  const report = round.review?.status === 'complete' && parseComparison(round.review.response, round.proposals);
  const comparison = report ? [inline(report.summary), '',
    '| 方案 | 需求覆盖 | 优势 | 风险 | 代码依据 / 待核查 | 验证计划（未实际运行） | 可融合部分 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.comparisons.map((row) => `| ${[row.candidate, row.coverage, row.strengths.join('；'), row.risks.join('；'), row.evidence.join('；'), row.verificationPlan, row.mergeable.join('；')].map(inline).join(' | ')} |`),
    '', `评审建议（由人决定）：${inline(report.recommendation)}`, '', `分歧：${report.conflicts.map(inline).join('；')}`].join('\n') : '没有可展示的结构化评审，以下保留完整原文。';
  return [
    '# 多模型协作报告',
    '本报告是只读方案记录，不是测试成绩或执行批准。默认不包含源码快照和发送给模型的完整提示词；任务及回复本身仍可能包含敏感内容，请核对后再分享。',
    '## 共同任务', fenced(round.prompt),
    `- 会诊编号：${inline(round.id)}\n- 创建时间：${inline(round.createdAt)}\n- 当前阶段：${inline(round.phase)}\n- 快照摘要：${inline(round.snapshot.digest)}`,
    '## 所选文件（不含内容）', fenced(round.snapshot.paths.join('\n') || '未附带源码'),
    '## 独立方案', round.proposals.map(jobText).join('\n\n'),
    '## 比较评审', comparison, round.review ? jobText(round.review) : '尚无评审。',
    '## 人工意见', round.feedback.map((item, index) => `### 第${index + 1}轮\n\n${fenced(item.feedback)}\n\n采纳：${item.selected.map((id) => inline(round.proposals.find((job) => job.id === id)?.label || '未知方案')).join('、')}`).join('\n\n') || '尚未提交。',
    '## 统一草案', round.revisions.map(jobText).join('\n\n') || '尚无草案。', '',
  ].join('\n\n');
}
