import { describe, expect, it } from 'vitest';
import { parseComparison, comparisonHtml, exportCollaboration } from './collaboration-report.js';

const proposals = [{ status: 'complete' }, { status: 'failed' }, { status: 'complete' }];
const row = (candidate) => ({ candidate, coverage: '覆盖登录', strengths: ['小范围'], risks: ['需检查兼容性'], evidence: ['src/login.ts：待核查'], verificationPlan: '运行登录测试', mergeable: ['错误提示'] });
const report = () => ({ version: 1, summary: '需人工判断', comparisons: [row('C'), row('A')], recommendation: '先核查 A', conflicts: ['状态管理不同'] });
describe('structured comparison and safe report export', () => {
  it('orders exact successful candidates and tolerates one outer JSON fence', () => {
    const result = parseComparison('```json\n' + JSON.stringify(report()) + '\n```', proposals);
    expect(result.comparisons.map((item) => item.candidate)).toEqual(['A', 'C']);
    expect(comparisonHtml(JSON.stringify(report()), proposals)).toContain('未成功返回，不参与评估');
    expect(comparisonHtml(JSON.stringify(report()), proposals)).toContain('未实际运行测试');
  });
  it('rejects invented, duplicate, missing, malformed and oversized evaluations without repairing them', () => {
    for (const comparisons of [[row('A'), row('B')], [row('A'), row('A')], [row('A')], [{ ...row('A'), risks: 'safe' }, row('C')]]) {
      expect(parseComparison(JSON.stringify({ ...report(), comparisons }), proposals)).toBeNull();
    }
    for (const value of ['plain report', 'x'.repeat(16001), null, JSON.stringify({ ...report(), version: 2 })]) expect(parseComparison(value, proposals)).toBeNull();
    expect(comparisonHtml('plain report', proposals)).toContain('保留下面的完整原文');
  });
  it('escapes all model fields rather than interpreting HTML or links', () => {
    const value = report(); value.summary = '<img src=x onerror=alert(1)>';
    value.comparisons[0].strengths = ['<script>bad</script>'];
    const html = comparisonHtml(JSON.stringify(value), proposals);
    expect(html).not.toContain('<img'); expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
  });
  it('exports raw replies and attempt history, not source snapshot or complete prompts', () => {
    const job = { id: 'a', label: '方案 A', status: 'complete', manualReply: false, reportedSource: '<img src=x>\n# injected',
      response: '```\n<script>raw reply</script>\n```', prompt: 'PRIVATE_PROMPT', attempt: 2,
      attemptHistory: [{ attempt: 1, endpoint: { kind: 'ollama', label: '<b>untrusted</b>' }, error: 'HTTP 429' }] };
    const md = exportCollaboration({ id: 'round', prompt: 'Task', createdAt: 'today', phase: 'decision',
      snapshot: { digest: 'hash', paths: ['src/login.ts'], context: 'PRIVATE_SOURCE' }, proposals: [job], revisions: [], feedback: [] });
    expect(md).not.toContain('PRIVATE_PROMPT'); expect(md).not.toContain('PRIVATE_SOURCE');
    expect(md).toContain('HTTP 429'); expect(md).toContain('src/login.ts');
    expect(md).toContain('````text\n```'); expect(md).toContain('&lt;img src=x&gt;');
    expect(md).not.toContain('\n# injected'); expect(md).toContain('未实际运行代码测试');
  });
  it('includes the valid comparison as a portable Markdown table with escaped cells', () => {
    const data = report(); data.comparisons[0].coverage = 'A | B <html>';
    const md = exportCollaboration({ id: 'round', prompt: 'Task', createdAt: 'today', phase: 'decision',
      snapshot: { digest: 'hash', paths: [], context: 'private' }, proposals,
      review: { label: 'Judge', status: 'complete', response: JSON.stringify(data) }, revisions: [], feedback: [] });
    expect(md).toContain('| 方案 | 需求覆盖 |'); expect(md).toContain('A \\| B &lt;html&gt;');
    expect(md).toContain('验证计划（未实际运行）');
  });
});
