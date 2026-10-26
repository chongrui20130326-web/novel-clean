/**
 * 清洗流水线：字节 → 解码 → 规则扫描 → 本地 9B 复核 → 渲染 → 报告。
 */

import { decodeNovel, normalizeNewlines } from './encoding.mjs';
import { scanInvisible } from './invisible.mjs';
import { parseDocument } from './parse.mjs';
import {
  detectTruncation,
  detectChapters,
  detectIrrelevant,
  detectIndent,
  detectBlank,
  invisibleIssues,
  encodingIssue,
} from './detect.mjs';
import { renderDocument } from './render.mjs';

const TYPE_ORDER = ['truncation', 'chapter', 'irrelevant', 'blank', 'indent', 'encoding', 'invisible'];

function pct(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function issueAccepted(issue) {
  return issue.accepted === true || issue.applied === true || issue.toggle === false;
}

function sortIssues(issues) {
  return issues.slice().sort((a, b) => {
    const type = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    if (type !== 0) return type;
    const lineA = a.lineNo ?? a.blockIds?.[0] ?? '';
    const lineB = b.lineNo ?? b.blockIds?.[0] ?? '';
    return String(lineA).localeCompare(String(lineB), 'zh-CN', { numeric: true });
  });
}

function updateCheckCounts(issues, render, extra) {
  const byType = (type) => issues.filter((issue) => issue.type === type);
  const applied = (issue) => issue.applied !== false;
  const truncation = byType('truncation');
  const chapter = byType('chapter');
  const irrelevant = byType('irrelevant');
  const blank = byType('blank');
  const indent = byType('indent');
  const encoding = byType('encoding');
  const invisible = byType('invisible');

  return [
    {
      type: 'truncation',
      index: 1,
      label: '语句截断',
      engine: '规则 + AI',
      found: truncation.filter(applied).length,
      reviewed: truncation.length,
      status: truncation.some((issue) => issue.severity === 'warn')
        ? 'review'
        : truncation.filter(applied).length ? 'fixed' : 'ok',
      detail: extra.truncationDetail,
    },
    {
      type: 'chapter',
      index: 2,
      label: '章节连续',
      engine: '规则',
      found: chapter.length,
      reviewed: chapter.length,
      warnCount: chapter.filter((issue) => issue.severity === 'warn').length,
      formatCount: chapter.filter((issue) => issue.severity === 'fix').length,
      status: chapter.some((issue) => issue.severity === 'warn')
        ? 'warn'
        : chapter.some((issue) => issue.severity === 'fix') ? 'fixed' : 'ok',
      detail: extra.chapterDetail,
    },
    {
      type: 'irrelevant',
      index: 3,
      label: '无关内容',
      engine: '规则 + AI',
      found: irrelevant.filter((issue) => issue.toggle !== false && applied(issue)).length,
      reviewed: irrelevant.length,
      status: irrelevant.some((issue) => issue.severity === 'warn')
        ? 'review'
        : irrelevant.some((issue) => issue.severity === 'fix' && applied(issue)) ? 'fixed' : 'ok',
      detail: extra.irrelevantDetail,
    },
    {
      type: 'blank',
      index: 4,
      label: '多余空行',
      engine: '规则',
      found: blank.length,
      reviewed: blank.length,
      status: blank.length ? 'fixed' : 'ok',
      detail: extra.blankDetail,
    },
    {
      type: 'indent',
      index: 5,
      label: '段落缩进',
      engine: '规则 · 5 空格',
      found: indent.length,
      reviewed: indent.length,
      status: indent.length ? 'fixed' : 'ok',
      detail: extra.indentDetail,
    },
    {
      type: 'encoding',
      index: 6,
      label: 'UTF-8 编码',
      engine: '规则',
      found: encoding.length,
      reviewed: encoding.length,
      status: encoding.length ? 'fixed' : 'ok',
      detail: extra.encodingDetail,
    },
    {
      type: 'invisible',
      index: 7,
      label: '不可见字符',
      engine: '规则',
      found: invisible.reduce((sum, issue) => sum + (issue.count || 0), 0),
      reviewed: invisible.length,
      status: invisible.length ? 'fixed' : 'ok',
      detail: extra.invisibleDetail,
    },
  ];
}

/**
 * @param {object} input
 * @param {Buffer} input.buffer
 * @param {string} input.name
 * @param {object} input.options
 * @param {object|null} input.aiClient
 * @param {(progress:object)=>void} input.onProgress
 */
export async function runClean(input) {
  const { buffer, name = '未命名.txt', options = {}, aiClient = null, onProgress = () => {} } = input;
  const bookName = String(options.bookName || input.bookName || '').trim().slice(0, 100);
  const resolvedBookName = bookName || name.replace(/\.[^.]+$/, '') || '未命名稿件';
  const started = Date.now();
  const indent = 5;
  const aiEnabled = options.ai !== false && Boolean(aiClient);

  const report = (percent, stage, label, detail = '', ai = null) => {
    onProgress({ percent: pct(percent), stage, label, detail, ai, elapsedMs: Date.now() - started });
  };

  report(3, 'decode', '识别编码', '检查 BOM、UTF-8 / GBK / UTF-16');
  const decoded = decodeNovel(buffer);
  const newline = normalizeNewlines(decoded.text);

  report(9, 'scan', '扫描不可见字符', `${decoded.encodingLabel} · ${(buffer.length / 1024).toFixed(1)} KB`);
  const invisible = scanInvisible(newline.text);

  report(15, 'parse', '切分章节与段落', '按标题行、正文行、空行建立编号');
  const doc = parseDocument(newline.text, invisible.cleaned, resolvedBookName);

  report(23, 'rules', '规则扫描', '截断 · 章节 · 广告 · 空行 · 缩进');
  const truncationCandidates = detectTruncation(doc);
  const chapterScan = detectChapters(doc);
  const chapterFormatIssues = doc.chapters
    .filter((chapter) => chapter.formattedTitle && chapter.formattedTitle !== chapter.core)
    .map((chapter, index) => ({
      id: `F${String(index + 1).padStart(4, '0')}`,
      type: 'chapter',
      layer: 'rule',
      severity: 'fix',
      fixable: true,
      toggle: false,
      accepted: true,
      applied: true,
      title: '章节标题格式统一',
      detail: `第 ${chapter.lineNo} 行 · 「${chapter.core}」→「${chapter.formattedTitle}」`,
      blockIds: [chapter.id],
      lineNo: chapter.lineNo,
      before: chapter.core,
      after: chapter.formattedTitle,
    }));
  const irrelevantScan = detectIrrelevant(doc);
  const blankIssues = detectBlank(doc);
  const encodingIssues = encodingIssue(decoded, newline);

  // ---------- AI 复核 ----------
  const ai = {
    enabled: Boolean(aiEnabled),
    model: aiClient?.model || options.model || '',
    health: null,
    calls: 0,
    failed: 0,
    truncatedReviewed: 0,
    irrelevantReviewed: 0,
    truncatedAccepted: 0,
    irrelevantAccepted: 0,
    skipped: 0,
    degraded: false,
    error: '',
    durationMs: 0,
    promptTokens: 0,
    evalTokens: 0,
  };

  let health = null;
  if (aiEnabled) {
    report(27, 'ai-check', '连接本地模型', aiClient.model);
    health = await aiClient.health();
    ai.health = health;
    if (!health.ok) {
      ai.enabled = false;
      ai.degraded = true;
      ai.error = health.error || '本地模型不可用，已退回规则模式';
    }
  } else {
    ai.degraded = true;
    ai.error = options.ai === false ? '本次关闭了 AI 复核，使用规则兜底' : '没有可用的本地模型客户端';
  }

  const truncLimit = Math.max(0, Number(options.maxTruncation ?? 24));
  const irrLimit = Math.max(0, Number(options.maxIrrelevant ?? 20));
  const truncTotal = Math.min(truncationCandidates.length, truncLimit);
  const irrTotal = Math.min(irrelevantScan.candidates.filter((item) => item.mode !== 'inline').length, irrLimit);
  const aiTotal = truncTotal + irrTotal;

  let truncReview = { selected: [], decisions: new Map(), skipped: truncationCandidates.length };
  let irrReview = { selected: [], decisions: new Map(), skipped: irrelevantScan.candidates.length };

  if (ai.enabled && aiTotal > 0) {
    let done = 0;
    const progress = ({ phase, done: phaseDone, total, tokensPerSecond = null, completionTokens = 0, durationMs = 0, speedSource = '' }) => {
      const current = phase === 'truncation' ? phaseDone : truncTotal + phaseDone;
      done = current;
      const percent = 30 + (aiTotal ? (achieved(phase, phaseDone, truncTotal) / aiTotal) * 50 : 0);
      report(percent, 'ai', phase === 'truncation' ? '模型复核语句截断' : '模型复核无关内容', `${phaseDone}/${total} · ${ai.model}`, {
        phase,
        done: current,
        total: aiTotal,
        batchDone: phaseDone,
        batchTotal: total,
        tokensPerSecond,
        completionTokens,
        durationMs,
        speedSource,
        model: ai.model,
      });
    };
    const achieved = (phase, phaseDone, truncCount) => phase === 'truncation' ? phaseDone : truncCount + phaseDone;

    truncReview = await aiClient.reviewTruncations(truncationCandidates, {
      limit: truncLimit,
      batchSize: 4,
      onProgress: progress,
    });
    irrReview = await aiClient.reviewIrrelevant(irrelevantScan.candidates, {
      limit: irrLimit,
      batchSize: 4,
      onProgress: progress,
    });
    ai.truncatedReviewed = truncReview.selected.length;
    ai.irrelevantReviewed = irrReview.selected.length;
    ai.skipped = (truncReview.skipped || 0) + (irrReview.skipped || 0);
    ai.calls = aiClient.stats?.calls || 0;
    ai.failed = aiClient.stats?.failedCalls || 0;
    ai.durationMs = aiClient.stats?.durationMs || 0;
    ai.promptTokens = aiClient.stats?.promptTokens || 0;
    ai.evalTokens = aiClient.stats?.evalTokens || 0;
    ai.tokensPerSecond = aiClient.stats?.lastTokensPerSecond || 0;
    ai.lastCompletionTokens = aiClient.stats?.lastCompletionTokens || 0;
    ai.lastDurationMs = aiClient.stats?.lastDurationMs || 0;
    ai.speedSource = aiClient.stats?.lastSpeedSource || '';
    if (ai.failed) ai.degraded = true;
    if (aiClient.stats?.errors?.length) ai.error = aiClient.stats.errors.slice(-2).join(' / ');
    if (done < aiTotal && aiTotal > 0) report(80, 'ai', '模型复核完成', `${done}/${aiTotal}`, {
      done,
      total: aiTotal,
      tokensPerSecond: ai.tokensPerSecond,
      completionTokens: ai.lastCompletionTokens,
      durationMs: ai.lastDurationMs,
      speedSource: ai.speedSource,
      model: ai.model,
    });
  } else {
    ai.skipped = truncationCandidates.length + irrelevantScan.candidates.length;
  }

  // ---------- 截断决策 ----------
  report(82, 'decide', '合并判定', '逐条生成可撤销的修复动作');
  const edges = [];
  let mergeSeq = 0;
  for (const candidate of truncationCandidates) {
    const decision = truncReview.decisions.get(candidate.id);
    const issueId = `M${String(mergeSeq + 1).padStart(4, '0')}`;
    mergeSeq += 1;
    let accepted = false;
    let layer = 'rule';
    let reason = candidate.reasons.join('；');
    let confidence = candidate.strength === 'strong' ? 0.82 : 0.5;
    let merged = candidate.left + candidate.join + candidate.right;

    if (decision) {
      layer = decision.layer || 'ai';
      reason = decision.reason || reason;
      confidence = decision.confidence ?? confidence;
      if (decision.error) {
        accepted = candidate.strength === 'strong';
        layer = 'rule';
        reason = `${reason}（AI 失败，按规则兜底）`;
      } else {
        accepted = decision.merge === true && (decision.confidence ?? 0) >= 0.5;
        if (accepted && decision.merged) merged = decision.merged;
      }
    } else {
      accepted = candidate.strength === 'strong' && !ai.enabled;
      if (ai.enabled) {
        layer = 'rule';
        reason = `${reason}（超出本次 AI 复核预算，保留待人工确认）`;
      }
    }

    candidate.accepted = accepted;
    candidate.issueId = issueId;
    candidate.layer = layer;
    candidate.merged = merged;
    candidate.confidence = confidence;
    candidate.reason = reason;
    edges.push(candidate);

    const issue = {
      id: issueId,
      type: 'truncation',
      layer,
      severity: accepted ? 'fix' : (decision ? 'info' : 'warn'),
      fixable: true,
      toggle: accepted,
      accepted,
      applied: accepted,
      title: accepted ? '语句被回车截断' : '疑似截断，保留换行',
      detail: `第 ${candidate.prev.lineNo}–${candidate.next.lineNo} 行 · ${reason}`,
      blockIds: [candidate.prevId, candidate.nextId],
      lineNo: candidate.prev.lineNo,
      before: `${candidate.left}\n${candidate.right}`,
      after: accepted ? merged : `${candidate.left}\n${candidate.right}`,
      confidence,
      reason,
      mergedSource: decision?.mergedSource || (accepted ? 'rule' : ''),
    };
    candidate.issue = issue;
  }

  // ---------- 无关内容决策 ----------
  const deletions = new Map();
  const inlineMatches = new Map();
  const irrelevantIssues = [];
  for (const candidate of irrelevantScan.candidates) {
    const issue = irrelevantScan.issues.find((item) => item.id === candidate.id);
    if (!issue) continue;
    if (candidate.mode === 'inline') {
      issue.accepted = true;
      issue.applied = true;
      issue.layer = 'rule';
      issue.severity = 'fix';
      issue.toggle = false;
      irrelevantIssues.push(issue);
      inlineMatches.set(candidate.blockId, candidate.matches);
      continue;
    }

    const decision = irrReview.decisions.get(candidate.id);
    let accepted;
    let layer = candidate.strength === 'strong' ? 'rule' : 'ai';
    let reason = candidate.reason;
    let confidence = candidate.strength === 'strong' ? 0.9 : 0.5;
    let kind = '';

    if (decision) {
      layer = decision.layer || 'ai';
      reason = decision.reason || reason;
      confidence = decision.confidence ?? confidence;
      kind = decision.kind || '';
      if (decision.error) {
        accepted = candidate.strength === 'strong';
        layer = 'rule';
        reason = `${reason}（AI 失败，按规则兜底）`;
      } else {
        // 安全阀：没有广告/网址/联系方式/纯符号等硬证据的“短句”，
        // 即使模型说删也不删，避免 9B 把正常叙事误判成留言。
        const allowDelete = candidate.strength === 'strong' || candidate.hardEvidence;
        accepted = decision.remove === true && (decision.confidence ?? 0) >= 0.5 && allowDelete;
        if (decision.remove === true && !allowDelete) {
          reason = 'AI 提议删除，但该段没有广告特征，已安全保留';
          layer = 'rule';
        }
      }
    } else {
      accepted = candidate.strength === 'strong' && !ai.enabled;
      if (ai.enabled) reason = `${reason}（超出本次 AI 复核预算）`;
    }

    issue.accepted = accepted;
    issue.applied = accepted;
    issue.layer = layer;
    issue.confidence = confidence;
    issue.reason = reason;
    issue.kind = kind;
    issue.severity = accepted ? 'fix' : (decision ? 'info' : 'warn');
    issue.title = accepted
      ? `无关内容：${reason}`
      : decision
        ? `AI 判定保留：${reason}`
        : `待确认：${reason}`;
    issue.after = accepted ? '（整段删除）' : '（保留）';
    issue.toggle = accepted;
    relevantPush(irrelevantIssues, issue);
    deletions.set(candidate.blockId, {
      accepted,
      issueId: issue.id,
      reason: reason || issue.detail,
      kind,
    });
  }

  // ---------- 缩进 / 空行 / 章节 ----------
  const continuationIds = new Set(edges.filter((edge) => edge.accepted).map((edge) => edge.nextId));
  const indentIssues = detectIndent(doc, continuationIds);
  for (const issue of indentIssues) {
    issue.applied = true;
    issue.accepted = true;
    issue.lineNo = doc.blocks.find((block) => block.id === issue.blockIds[0])?.lineNo;
  }
  for (const issue of blankIssues) {
    issue.applied = true;
    issue.accepted = true;
  }
  for (const issue of chapterScan.issues) {
    issue.accepted = false;
    issue.applied = false;
    issue.lineNo = doc.blocks.find((block) => block.id === issue.blockIds?.[0])?.lineNo;
  }
  const invIssues = invisibleIssues(invisible, doc);
  for (const issue of invIssues) {
    issue.accepted = true;
    issue.applied = true;
  }

  const allIssues = sortIssues([
    ...edges.map((edge) => edge.issue).filter(Boolean),
    ...chapterScan.issues,
    ...chapterFormatIssues,
    ...irrelevantIssues,
    ...blankIssues,
    ...indentIssues,
    ...encodingIssues,
    ...invIssues,
  ]);

  // ---------- 渲染 ----------
  report(88, 'render', '生成对比结果', `整理 ${allIssues.length} 条检查记录`);
  const state = {
    edges,
    deletions,
    issues: allIssues,
    disabled: new Set(),
    marksByLine: invisible.marksByLine,
    inlineMatches,
  };
  const rendered = renderDocument(doc, state);

  const aiAppliedTrunc = edges.filter((edge) => edge.accepted && edge.layer === 'ai').length;
  const aiAppliedIrr = irrelevantIssues.filter((issue) => issue.accepted && issue.layer === 'ai').length;
  ai.truncatedAccepted = edges.filter((edge) => edge.accepted).length;
  ai.irrelevantAccepted = irrelevantIssues.filter((issue) => issue.accepted && issue.toggle).length;
  ai.aiApplied = aiAppliedTrunc + aiAppliedIrr;

  const deletedText = irrelevantIssues.filter((issue) => issue.accepted && issue.mode !== 'inline').length;
  const blankRemoved = blankIssues.reduce((sum, issue) => sum + (issue.removed || 0), 0);
  const checkDetails = {
    truncationDetail: `${truncationCandidates.length} 处候选 · AI 复核 ${ai.truncatedReviewed} · 确认 ${ai.truncatedAccepted}`,
    chapterDetail: [
      `${chapterScan.found} 章`,
      `连续性 ${chapterScan.continuity}%`,
      chapterFormatIssues.length ? `格式统一 ${chapterFormatIssues.length}` : '格式已一致',
      chapterScan.gaps.length ? `缺 ${chapterScan.gaps.map((gap) => gap.missing.join('、')).join('；')}` : '编号连续',
    ].join(' · '),
    irrelevantDetail: `${deletedText} 段整段删除 · ${inlineMatches.size} 处行内网址`,
    blankDetail: `${blankIssues.length} 组空行 · 删除 ${blankRemoved} 行`,
    indentDetail: `${indentIssues.length} 段缩进已统一为 5 个半角空格`,
    encodingDetail: decoded.converted ? `${decoded.encodingLabel} → UTF-8（无 BOM）` : 'UTF-8（无 BOM）',
    invisibleDetail: `${invisible.kinds} 种 / ${invisible.total} 个不可见字符已清理`,
  };
  const checks = updateCheckCounts(allIssues, rendered, checkDetails);

  const summary = {
    name,
    bookName: resolvedBookName,
    title: resolvedBookName,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    input: {
      bytes: buffer.length,
      encoding: decoded.encoding,
      encodingLabel: decoded.encodingLabel,
      bom: decoded.bom,
      confidence: decoded.confidence,
      newline: newline.style,
      chars: doc.stats.charsWithTitle,
      paragraphs: doc.stats.paragraphs,
      chapters: doc.stats.chapters,
      lines: doc.lines,
      bookName: resolvedBookName,
    },
    output: {
      encoding: 'UTF-8',
      bom: false,
      bytes: rendered.bytes,
      chars: rendered.stats.charsAfter,
      paragraphs: rendered.stats.paragraphsOut,
      chapters: rendered.stats.chapters,
      deletedBlocks: rendered.stats.deletedBlocks,
      mergedSentences: rendered.stats.mergedSentences,
      blankRemoved,
    },
    stats: rendered.stats,
    checks,
    chapter: {
      continuity: chapterScan.continuity,
      found: chapterScan.found,
      expected: chapterScan.expected,
      gaps: chapterScan.gaps.map((gap) => ({
        from: gap.from.number,
        to: gap.to.number,
        missing: gap.missing,
      })),
      formatCount: chapterFormatIssues.length,
      items: rendered.chapterMap,
    },
    ai,
    issuesTotal: allIssues.length,
  };

  report(100, 'done', '清洗完成', `${summary.input.chars} → ${summary.output.chars} 字`, ai.enabled ? {
    done: aiTotal,
    total: aiTotal,
    tokensPerSecond: ai.tokensPerSecond || 0,
    completionTokens: ai.lastCompletionTokens || 0,
    durationMs: ai.lastDurationMs || 0,
    speedSource: ai.speedSource || '',
    model: ai.model,
  } : null);

  const snapshot = {
    doc,
    state,
    summary,
    decoded,
    newline,
    invisible,
    chapterScan,
    blankIssues,
    indentIssues,
    encodingIssues,
    invIssues,
    irrelevantIssues,
    truncationCandidates,
    checkDetails,
    ai,
    aiTotal,
    blankRemoved,
    indent,
  };

  return {
    summary,
    issues: rendered.issues,
    blocks: rendered.blocks,
    text: rendered.text,
    doc,
    state,
    ai,
    snapshot,
    options: { ...options, indent },
  };
}

/**
 * 用户取消/恢复某些修复后，重新渲染并刷新报告。
 * 纯函数式地复用第一次分析得到的 doc/state，不会重新跑模型。
 */
export function rerender(snapshot, disabled = []) {
  const state = snapshot.state;
  state.disabled = new Set(disabled);
  const rendered = renderDocument(snapshot.doc, state);
  const summary = snapshot.summary;
  summary.stats = rendered.stats;
  summary.output = {
    ...summary.output,
    bytes: rendered.bytes,
    chars: rendered.stats.charsAfter,
    paragraphs: rendered.stats.paragraphsOut,
    chapters: rendered.stats.chapters,
    deletedBlocks: rendered.stats.deletedBlocks,
    mergedSentences: rendered.stats.mergedSentences,
    blankRemoved: snapshot.blankRemoved,
  };
  summary.checks = updateCheckCounts(rendered.issues, rendered, snapshot.checkDetails);
  summary.issuesTotal = rendered.issues.length;
  summary.ai = {
    ...summary.ai,
    aiApplied: rendered.issues.filter((issue) => issue.layer === 'ai' && issue.toggle && issue.applied).length,
  };
  return {
    summary,
    issues: rendered.issues,
    blocks: rendered.blocks,
    text: rendered.text,
  };
}

function relevantPush(list, issue) {
  const existing = list.findIndex((item) => item.id === issue.id);
  if (existing >= 0) list[existing] = issue;
  else list.push(issue);
}
