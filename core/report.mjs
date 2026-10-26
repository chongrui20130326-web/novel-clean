import crypto from 'node:crypto';

export const REPORT_SCHEMA = 'novel-clean/report@1';
export const APP_VERSION = '1.0.0';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function countIssues(issues) {
  const byType = {};
  const bySeverity = {};
  for (const issue of issues) {
    byType[issue.type] = (byType[issue.type] || 0) + 1;
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
  }
  return { total: issues.length, byType, bySeverity };
}

/**
 * 可追溯的清洗报告。和正文一起落盘，便于二次处理：
 * - schema / generatedAt / app version
 * - 源文件、编码、字符数、哈希
 * - 七项检查与章节断点
 * - 全量 issue（id / 行号 / blockIds / before / after / 是否应用）
 * - 用户逐条关闭的 issue id
 * - 正文与报告的路径、字节数、哈希
 */
export function buildReport({
  id = '',
  name = '',
  title = '',
  summary = null,
  issues = [],
  disabled = [],
  text = '',
  sourceBytes = 0,
  sourceHash = '',
  textPath = '',
  reportPath = '',
  options = {},
  generatedAt = new Date().toISOString(),
}) {
  const resultBytes = Buffer.byteLength(String(text || ''), 'utf8');
  return {
    schema: REPORT_SCHEMA,
    generatedAt,
    app: { name: '墨净', version: APP_VERSION },
    job: { id, sourceFile: name, bookName: summary?.bookName || title || '' },
    source: {
      bytes: sourceBytes,
      sha256: sourceHash,
      encoding: summary?.input?.encoding || '',
      encodingLabel: summary?.input?.encodingLabel || '',
      newline: summary?.input?.newline || '',
      chars: summary?.input?.chars ?? null,
      paragraphs: summary?.input?.paragraphs ?? null,
      chapters: summary?.input?.chapters ?? null,
    },
    result: {
      chars: summary?.output?.chars ?? null,
      paragraphs: summary?.output?.paragraphs ?? null,
      chapters: summary?.output?.chapters ?? null,
      durationMs: summary?.durationMs ?? null,
      ai: summary?.ai || null,
      issueCount: issues.length,
      issueCounts: countIssues(issues),
    },
    checks: summary?.checks || [],
    chapters: summary?.chapter || null,
    issues,
    disabled,
    files: {
      text: {
        path: textPath,
        name: textPath ? textPath.split(/[\\/]/).pop() : '',
        bytes: resultBytes,
        sha256: sha256(String(text || '')),
      },
      report: {
        path: reportPath,
        name: reportPath ? reportPath.split(/[\\/]/).pop() : '',
      },
    },
    options,
  };
}
