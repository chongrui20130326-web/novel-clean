/**
 * 把「原文块 + 规则/AI 决策」渲染成最终文稿和 HMI 对比行。
 *
 * 所有会改变正文结构的动作（合并、删除）都集中在 accepted / disabled 两个集合里，
 * 所以用户在界面上逐条取消时，只要重新跑一次 render 即可，前端不需要复制清洗逻辑。
 */

import { invisibleLabel } from './invisible.mjs';

const BODY_INDENT = 5;

function normalizeCore(text) {
  return String(text || '').replace(/[ \t]+$/g, '').trim();
}

function displayWithMarks(text, marks = []) {
  if (!marks.length) return text;
  const chars = [...String(text || '')];
  // 倒序插入，避免位置偏移。同一位置多个标记时按原顺序。
  const sorted = marks.slice().sort((a, b) => b.index - a.index);
  for (const mark of sorted) {
    const label = invisibleLabel(mark.code);
    const token = `⟨${label.short}⟩`;
    if (mark.index < 0 || mark.index > chars.length) continue;
    if (mark.index < chars.length && chars[mark.index]?.codePointAt(0) === mark.code) {
      chars[mark.index] = token;
    } else {
      chars.splice(mark.index, 0, token);
    }
  }
  return chars.join('');
}

function removeSpans(text, matches = []) {
  if (!matches.length) return text;
  let output = String(text);
  for (const match of matches.slice().sort((a, b) => b.start - a.start)) {
    output = output.slice(0, match.start) + output.slice(match.end);
  }
  return output
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。！？；：、])/g, '$1')
    .replace(/[ \t]+$/g, '')
    .trim();
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  find(id) {
    if (!this.parent.has(id)) this.parent.set(id, id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cursor = id;
    while (this.parent.get(cursor) !== cursor) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

/**
 * @param {object} doc parseDocument 结果
 * @param {object} state
 * @param {Array} state.edges 截断候选（含 accepted/merge）
 * @param {Map} state.deletions blockId -> {accepted, issueId, reason}
 * @param {Array} state.issues 全部 issue
 * @param {Set} state.disabled 被用户关闭的 issue id
 * @param {Map} state.marksByLine 行号 -> 不可见字符标记
 * @param {object} state.meta 编码等报告
 */
export function renderDocument(doc, state = {}) {
  const disabled = state.disabled instanceof Set ? state.disabled : new Set(state.disabled || []);
  const deletions = state.deletions || new Map();
  const issues = state.issues || [];
  const edges = (state.edges || []).filter((edge) => edge.accepted);
  const marksByLine = state.marksByLine || new Map();

  const uf = new UnionFind();
  const edgeByPair = new Map();
  for (const edge of edges) {
    if (disabled.has(edge.issueId)) continue;
    if (deletions.get(edge.prevId)?.accepted || deletions.get(edge.nextId)?.accepted) continue;
    uf.union(edge.prevId, edge.nextId);
    edgeByPair.set(`${edge.prevId}>${edge.nextId}`, edge);
  }

  const groups = new Map();
  for (const paragraph of doc.paragraphs) {
    const root = uf.find(paragraph.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(paragraph);
  }

  const emitted = new Set();
  const blocks = [];
  const lines = [];
  let previousWasChapter = false;
  let lastLineKind = '';

  const issuesFor = (blockIds) => {
    const ids = new Set(blockIds);
    return issues.filter((issue) => issue.blockIds?.some((id) => ids.has(id)));
  };

  for (const source of doc.blocks) {
    if (source.kind === 'blank') continue;

    if (source.kind === 'chapter') {
      const related = issuesFor([source.id]);
      const cleaned = normalizeCore(source.formattedTitle || source.core);
      if (lines.length && lastLineKind !== 'blank') lines.push('');
      lines.push(cleaned);
      lastLineKind = 'chapter';
      previousWasChapter = true;
      const chapterMarks = (marksByLine.get(source.lineNo) || [])
        .filter((mark) => mark.index >= source.indent)
        .map((mark) => ({ ...mark, index: mark.index - source.indent }));
      blocks.push({
        id: source.id,
        kind: 'chapter',
        chapterIndex: source.chapterIndex,
        chapterNumber: source.chapterNumber,
        chapterUnit: source.chapterUnit,
        chapterTitle: source.chapterTitle,
        lineNo: source.lineNo,
        original: normalizeCore(source.core),
        displayOriginal: displayWithMarks(normalizeCore(source.core), chapterMarks),
        cleaned,
        coreOriginal: normalizeCore(source.core),
        coreCleaned: cleaned,
        indentBefore: source.indent,
        indentAfter: 0,
        changed: cleaned !== normalizeCore(source.core),
        deleted: false,
        merged: false,
        parts: [{ lineNo: source.lineNo, original: normalizeCore(source.core), clean: normalizeCore(source.core), indent: source.indent }],
        issueIds: related.map((issue) => issue.id),
        issueTypes: [...new Set(related.map((issue) => issue.type))],
      });
      continue;
    }

    const root = uf.find(source.id);
    if (emitted.has(root)) continue;
    emitted.add(root);
    const parts = groups.get(root) || [source];
    const deleteEntry = parts.map((part) => deletions.get(part.id)).find((item) => item?.accepted);
    const relatedAll = issuesFor(parts.map((part) => part.id));
    // “AI 判定保留”只是复核记录，不挂到正文标签上，否则正常叙事会被标成“广告”。
    const related = relatedAll.filter((issue) => issue.severity !== 'info');

    const partCores = parts.map((part) => normalizeCore(part.core));
    const partClips = parts.map((part) => {
      // 段首缩进由 HMI 的“空格标记”单独画；这里要剔除段首不可见空格，
      // 并把剩余标记的位置减去缩进，否则 ⟨␠⟩ 会和圆点重复、行内标记会偏移。
      const marks = (marksByLine.get(part.lineNo) || [])
        .filter((mark) => mark.index >= part.indent)
        .map((mark) => ({ ...mark, index: mark.index - part.indent }));
      return displayWithMarks(normalizeCore(part.core), marks);
    });

    // 合并时按边上的 join 拼接（英文单词之间补空格）。
    let mergedCore = partCores[0] || '';
    for (let index = 1; index < parts.length; index += 1) {
      const edge = edgeByPair.get(`${parts[index - 1].id}>${parts[index].id}`);
      mergedCore += `${edge?.join || ''}${partCores[index] || ''}`;
    }

    const inlineMatches = state.inlineMatches?.get(parts[0].id) || [];
    const cleanedCore = normalizeCore(removeSpans(mergedCore, inlineMatches));
    const deleteActive = Boolean(deleteEntry);
    const cleaned = deleteActive ? '' : `${' '.repeat(BODY_INDENT)}${cleanedCore}`;
    const originalCore = partCores.join('\n');
    const displayOriginal = partClips.join('\n');

    if (!deleteActive) {
      lines.push(cleaned);
      lastLineKind = 'paragraph';
      previousWasChapter = false;
    }

    blocks.push({
      id: parts.length > 1 ? `group-${parts[0].id}` : parts[0].id,
      kind: 'paragraph',
      chapterIndex: source.chapterIndex,
      chapterTitle: source.chapterTitle,
      lineNo: source.lineNo,
      original: originalCore,
      displayOriginal,
      cleaned,
      coreOriginal: originalCore,
      coreCleaned: cleanedCore,
      indentBefore: parts[0].indent,
      indentAfter: BODY_INDENT,
      changed: cleanedCore !== originalCore.replace(/\n/g, '') || parts[0].indent !== BODY_INDENT,
      deleted: deleteActive,
      deleteReason: deleteEntry?.reason || '',
      merged: parts.length > 1,
      parts: parts.map((part, index) => ({
        lineNo: part.lineNo,
        original: partCores[index],
        displayOriginal: partClips[index],
        clean: partCores[index],
        indent: part.indent,
      })),
      issueIds: related.map((issue) => issue.id),
      issueTypes: [...new Set(related.map((issue) => issue.type))],
    });
  }

  // 去掉文末多余空行；保证文件以单个 LF 结束。
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const text = `${lines.join('\n')}\n`;

  const charsBefore = doc.paragraphs.reduce((sum, block) => sum + block.core.replace(/\s/g, '').length, 0)
    + doc.chapters.reduce((sum, block) => sum + block.core.replace(/\s/g, '').length, 0);
  const charsAfter = text.replace(/\s/g, '').length;
  const paragraphsOut = blocks.filter((block) => block.kind === 'paragraph' && !block.deleted).length;
  const deletedBlocks = blocks.filter((block) => block.deleted).length;
  const mergedBlocks = blocks.filter((block) => block.merged).length;
  const aiApplied = issues.filter((issue) => issue.layer === 'ai' && issue.accepted && !disabled.has(issue.id) && issue.toggle).length;
  const ruleApplied = issues.filter((issue) => issue.layer === 'rule' && issue.applied && !issue.toggle).length;

  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    blocks,
    stats: {
      charsBefore,
      charsAfter,
      removedChars: Math.max(0, charsBefore - charsAfter),
      paragraphsIn: doc.paragraphs.length,
      paragraphsOut,
      chapters: doc.stats.chapters,
      deletedBlocks,
      mergedSentences: mergedBlocks,
      aiApplied,
      ruleApplied,
      linesOut: lines.length,
      bytesOut: Buffer.byteLength(text, 'utf8'),
    },
    issues: issues.map((issue) => ({
      ...issue,
      applied: issue.toggle
        ? Boolean(issue.accepted) && !disabled.has(issue.id)
        : issue.applied !== false,
      disabled: disabled.has(issue.id),
    })),
    chapterMap: doc.chapters.map((chapter) => ({
      blockId: chapter.id,
      lineNo: chapter.lineNo,
      number: chapter.chapterNumber,
      unit: chapter.chapterUnit,
      title: chapter.formattedTitle || chapter.chapterTitle,
      text: chapter.text,
      special: chapter.special,
      volume: chapter.volume,
    })),
  };
}

/** 生成导出文件名。 */
export function exportFileName(title) {
  const safe = String(title || '未命名稿件')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48) || '未命名稿件';
  return `${safe}.utf8.txt`;
}
