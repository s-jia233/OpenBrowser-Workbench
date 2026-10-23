import { describe, expect, it } from 'vitest';
import { executionHtml, executionText, browserReceptionHtml, clarificationHtml } from './execution-status.js';
const run = (extra = {}) => ({ attempt: 1, changes: 'applied', verification: 'passed', requested: ['test'], passed: ['test'], ...extra });
describe('observed execution result presentation', () => {
  it('presents clarification as an actionable question and escapes model-generated HTML', () => {
    const html = clarificationHtml('改哪个文件？\n<script>alert(1)</script>');
    expect(html).toContain('改哪个文件？'); expect(html).toContain('待回答的问题');
    expect(html).not.toContain('请在下方'); expect(html).not.toContain('不会自动');
    expect(html).not.toContain('<h4>');
    expect(html.match(/<p\b/g)).toHaveLength(1);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).not.toContain('任务失败'); expect(html).not.toContain('role="alert"');
  });
  it('explains exact captured-message matching even when no legacy user node is present', () => {
    const html = browserReceptionHtml({ reason: 'settling', matchedBy: 'stream_id', currentUsers: 0, assistants: 1 });
    expect(html).toContain('按本轮回复编号匹配'); expect(html).toContain('正在确认稳定');
    expect(html).toContain('本轮提问 0 个');
  });
  it('distinguishes matched complete content waiting for an end signal from a model still generating', () => {
    const html = browserReceptionHtml({ reason: 'awaiting_completion', stream: 'pending', version: '0.8.13', elapsedMs: 32_000, pageChars: 200, currentUsers: 1 });
    expect(html).toContain('已匹配完整正文，但尚未识别到生成结束信号'); expect(html).toContain('32 秒');
    expect(html).toContain('200 字'); expect(html).not.toContain('网页仍有生成中标记');
    expect(browserReceptionHtml({ reason: 'generating' })).toContain('网页仍有生成中标记');
  });
  it('renders unknown/missing diagnostics honestly, escapes metadata and marks historical records', () => {
    expect(browserReceptionHtml()).toContain('尚未收到'); expect(browserReceptionHtml(undefined, false)).toBe('');
    const html = browserReceptionHtml({ reason: '<script>', version: '<img>', elapsedMs: 'bad' }, false);
    expect(html).toContain('历史记录'); expect(html).toContain('接收状态未知'); expect(html).toContain('&lt;img&gt;');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('NaN');
  });
  it('distinguishes selected verification passing from all tests passing', () => {
    const html = executionHtml([run()]); expect(html).toContain('所选验证项目通过'); expect(html).toContain('修改已应用');
    expect(html).not.toContain('全部测试通过');
  });
  it('does not fabricate passing results for skipped, unknown, missing or partial records', () => {
    expect(executionText(run({ verification: 'skipped', passed: [] })).verification).toContain('不代表测试通过');
    expect(executionText(run({ passed: [] })).verification).toBe('验证结果未确认');
    expect(executionText(run({ requested: ['test', 'lint'] })).verification).toBe('验证结果未确认');
    expect(executionHtml([], true)).toContain('执行结果未记录'); expect(executionHtml()).toBe('');
  });
  it('separates rollback from verification and labels the actual attempt, not the next model attempt', () => {
    const html = executionHtml([run({ changes: 'rolled_back', verification: 'failed', passed: [] }), run({ attempt: 2, changes: 'not_applied', verification: 'not_run', passed: [] })]);
    expect(html).toContain('第 2/3 次尝试'); expect(html).toContain('此前 1 次执行记录');
    expect(html).toContain('本轮修改已回滚'); expect(html).toContain('验证失败'); expect(html).toContain('尚未写入文件');
  });
  it('escapes all file, script, detail and attempt data', () => {
    const html = executionHtml([run({ detail: '<script>bad</script>', requested: ['<img src=x>'], passed: [], attempt: '<b>' })]);
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
  });
});
