/**
 * 规则检测层。
 *
 * 这里只做“可机械验证”的事：
 *  - 截断：行尾没有句末标点 + 下一行像续写，给出候选和置信度；
 *  - 章节：编号是否连续、重复、倒退；
 *  - 无关内容：网址、联系方式、广告词、纯符号；
 *  - 空行：段间空行、章节前过多空行、首尾空行；
 *  - 缩进：是否为 5 个半角空格。
 *
 * 语义上拿不准的候选会打上 strength=medium，交给 9B 模型复核。
 */

const TERMINAL = /[。！？!?…～~”’」』）】》〉\u2014\u2013.]$/;
const SOFT_END = /[，,、；;：:]$/;
const CONTINUE_START = /^(却|但|而|又|也|就|才|便|于是|然后|忽然|突然|原来|因为|所以|只是|不过|而且|或者|如果|虽然|可是|接着|随即|终于|竟|居然|还是|仍然|依然|于是|因此|至于|同时|此外|这时|那时|只见|直到|等到|正在|已经|曾经|似乎|仿佛|好像)/;
const FUNCTION_END = /(的|地|得|了|着|过|和|与|跟|在|把|被|让|给|对|从|向|为|是|有|没|不|很|太|更|最|都|也|又|还|却|而|但|或|就|才|便|将|要|会|能|可|所|以|于|及|并|且|若|如|因|由|自|至|往|朝|像|比|等|把|使|令|叫|请|说|道|问|喊|想|看|听|觉|感|知|望|走|跑|站|坐|躺|拿|放|推|拉|开|关|转|回|进|出|上|下|起|落)$/;
const NEW_PARAGRAPH_START = /^([0-9０-９]+[.、)）]|[-*•·]\s|（[一二三四五六七八九十]+）|[一二三四五六七八九十]+、|第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节回卷]|Chapter\s)/i;
const SPEECH_VERB = /(说|问|道|喊|叫|答|低声|轻声|冷笑|笑道|吼道|嘟囔|喃喃|开口|回答|反问|感叹|念叨)$/;

const URL_RE = /(?:https?:\/\/|www\.)[^\s，。！？；：、）】」』]+/gi;
const DOMAIN_RE = /\b[a-z0-9][a-z0-9-]{0,62}\.(?:com|net|org|cc|cn|me|io|tv|info|xyz|top|vip|site|club|app|la|link|shop)\b[^\s，。！？；：、）】」』]*/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CONTACT_RE = /(?:QQ|qq|微信|威信|V信|vx|VX|微博|抖音|快手|公众号|书友群|交流群|催更群|读者群)\s*[:：]?\s*[A-Za-z0-9_-]{4,}/g;
const META_RE = /(求收藏|求推荐|推荐票|月票|打赏|订阅|收藏本站|加入书架|最新章节|无弹窗|笔趣阁|首发|转载|请记住|本站|域名|更新最快|手机阅读|电脑阅读|点击下一页|本章未完|本章完|未完待续|付费阅读|VIP章节|防盗|盗版|书友群|QQ群|微信群|公众号|作者的话|作者有话说|作者[:：]|PS[:：]|P\.S\.|感谢打赏|盟主|舵主|求月票|求评价票|点击推荐|请假|断更|加更)/i;
const AD_PREFIX = /^(【?\s*广告\s*】?|广告\s*[:：]|推广\s*[:：])/i;
const NOISE_RE = /^[\s\-—–_=*#~·•◆◇■□▲△▼▽★☆※×+÷|/\\<>《》〈〉「」『』〔〕【】\[\]()（）{}:：;；,，.。!！?？…"'`]+$/;
const CHAPTER_EDGE_META = /(作者|抱歉|感谢|大家|今天|明天|更新|请假|断更|加更|推荐|收藏|月票|打赏|读者|书友|群|PS|ps)/;

/** 统一去掉句首缩进，保留正文。 */
function coreOf(block) {
  return String(block?.core || '').trim();
}

/** 判断两行之间是不是被硬回车拆开的句子。 */
export function detectTruncation(doc) {
  const candidates = [];
  const blocks = doc.blocks;

  for (let index = 0; index < blocks.length - 1; index += 1) {
    const prev = blocks[index];
    const next = blocks[index + 1];
    if (prev.kind !== 'paragraph' || next.kind !== 'paragraph') continue;
    if (next.lineNo !== prev.lineNo + 1) continue;
    if (prev.chapterIndex !== next.chapterIndex) continue;

    const left = coreOf(prev);
    const right = coreOf(next);
    if (right.length < 2) continue;
    const openQuoteCount = (left.match(/[“「『]/g) || []).length;
    const closeQuoteCount = (left.match(/[”」』]/g) || []).length;
    const shortButOpenQuote = left.length < 6 && openQuoteCount > closeQuoteCount;
    if (left.length < 6 && !shortButOpenQuote) continue;
    if (TERMINAL.test(left)) continue;
    if (NEW_PARAGRAPH_START.test(right)) continue;
    // 两段对话各自成段，不合并。
    if (/^[“「『]/.test(left) && /^[“「『]/.test(right)) continue;
    // 明显的列表 / 歌词 / 诗句不碰。
    if (/^[·•]/.test(left) || /^[·•]/.test(right)) continue;

    let score = 0;
    const reasons = [];

    if (SOFT_END.test(left)) {
      score += 4;
      reasons.push('上一行以逗号/顿号/分号收尾');
    }
    if (openQuoteCount > closeQuoteCount && !/^[“「『]/.test(right)) {
      score += 4;
      reasons.push('引号没有闭合');
    }
    if (CONTINUE_START.test(right)) {
      score += 4;
      reasons.push('下一行以转折/承接词开头');
    }
    if (FUNCTION_END.test(left)) {
      score += 2;
      reasons.push('上一行停在虚词/动词上');
    }
    if (/(看见|听见|想起|发现|觉得|知道|明白|感觉|记得|希望|认为|说道|问道|笑道|看见|盯着|望着|看着)$/.test(left)) {
      score += 4;
      reasons.push('感知/言说动词后直接换行');
    }
    if (/^(停|落|放|站|坐|躺|走|跑|看|听|说|问|答|笑|哭|伸|缩|转|回|抬|低|握|拿|推|拉|开|关|响|亮|暗|飘|散|涌)/.test(right) && left.length >= 8) {
      score += 2;
      reasons.push('下一行以动作动词直接承接');
    }
    if (SPEECH_VERB.test(left) && /^[“「『]/.test(right)) {
      score += 4;
      reasons.push('说话动词后接下一行引语');
    }
    if (left.length >= 12) {
      score += 1;
      reasons.push('长句没有句末标点');
    }
    if (/[A-Za-z]-$/.test(left) && /^[A-Za-z]/.test(right)) {
      score += 3;
      reasons.push('英文单词被连字符拆开');
    }
    if (/[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)) {
      score += 1;
    }

    if (score < 2) continue;

    const beforeBlock = blocks[index - 1];
    const afterBlock = blocks[index + 2];
    const strength = score >= 4 ? 'strong' : 'medium';
    candidates.push({
      id: `T${String(candidates.length + 1).padStart(4, '0')}`,
      type: 'truncation',
      prevId: prev.id,
      nextId: next.id,
      prev,
      next,
      left,
      right,
      score,
      strength,
      reasons,
      join: /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? ' ' : '',
      contextBefore: beforeBlock?.kind === 'paragraph' ? beforeBlock.core.slice(-40) : '',
      contextAfter: afterBlock?.kind === 'paragraph' ? afterBlock.core.slice(0, 40) : '',
      chapterTitle: prev.chapterTitle || '',
    });
  }

  // 同一行只作为“上一行”出现一次；但链式截断允许同一行也是下一行。
  return candidates;
}

/** 章节连续性。只报告，不替作者编造缺失章节。 */
export function detectChapters(doc) {
  const items = doc.chapters
    .filter((chapter) => chapter.chapterNumber !== null && !chapter.volume && !chapter.special)
    .map((chapter) => ({
      blockId: chapter.id,
      lineNo: chapter.lineNo,
      number: chapter.chapterNumber,
      title: chapter.chapterTitle,
      unit: chapter.chapterUnit,
      style: chapter.chapterStyle,
      raw: chapter.text,
    }));

  const issues = [];
  const gaps = [];
  const duplicates = [];
  let okTransitions = 0;

  for (let index = 1; index < items.length; index += 1) {
    const prev = items[index - 1];
    const current = items[index];
    const diff = current.number - prev.number;
    if (diff === 1) {
      okTransitions += 1;
      continue;
    }

    if (diff === 0) {
      // “第 5 章（上）/（下）”不是重复。
      if (/^[（(]?[上中下前后][）)]?$/.test(current.title.trim()) || /^[（(]?[上中下前后][）)]?$/.test(prev.title.trim())) {
        continue;
      }
      duplicates.push({ prev, current });
      issues.push({
        id: `C${String(issues.length + 1).padStart(4, '0')}`,
        type: 'chapter',
        layer: 'rule',
        severity: 'warn',
        fixable: false,
        title: `章节号重复：第 ${current.number} 章`,
        detail: `第 ${current.lineNo} 行与第 ${prev.lineNo} 行都编号为第 ${current.number} 章。`,
        blockIds: [prev.blockId, current.blockId],
        suggestion: `若后一个是编号笔误，建议改为第 ${current.number + 1} 章；软件不会擅自改动。`,
      });
      continue;
    }

    if (diff < 0) {
      issues.push({
        id: `C${String(issues.length + 1).padStart(4, '0')}`,
        type: 'chapter',
        layer: 'rule',
        severity: 'warn',
        fixable: false,
        title: `章节号倒退：第 ${prev.number} 章 → 第 ${current.number} 章`,
        detail: `第 ${current.lineNo} 行的编号小于上一章，可能混入了旧稿或重复章节。`,
        blockIds: [prev.blockId, current.blockId],
        suggestion: '需要人工确认章节顺序。',
      });
      continue;
    }

    const missing = [];
    for (let value = prev.number + 1; value < current.number && missing.length < 12; value += 1) missing.push(value);
    gaps.push({ from: prev, to: current, missing });
    issues.push({
      id: `C${String(issues.length + 1).padStart(4, '0')}`,
      type: 'chapter',
      layer: 'rule',
      severity: 'warn',
      fixable: false,
      title: `章节不连续：缺第 ${missing.join('、')} 章`,
      detail: `第 ${prev.number} 章（行 ${prev.lineNo}）之后直接是第 ${current.number} 章（行 ${current.lineNo}）。`,
      blockIds: [prev.blockId, current.blockId],
      suggestion: '缺失章节无法由软件补出；请确认是否漏稿，或是否存在番外/分卷。',
      missing,
    });
  }

  return {
    items,
    issues,
    gaps,
    duplicates,
    continuity: items.length > 1 ? Math.round((okTransitions / (items.length - 1)) * 100) : 100,
    expected: items.length ? items[items.length - 1].number - items[0].number + 1 : 0,
    found: items.length,
  };
}

/** 段落缩进：正文必须恰好 5 个半角空格，章节标题不缩进。 */
export function detectIndent(doc, continuationIds = new Set()) {
  const issues = [];
  for (const block of doc.paragraphs) {
    if (continuationIds.has(block.id)) continue;
    if (block.indent === 5) continue;
    issues.push({
      id: `N${String(issues.length + 1).padStart(4, '0')}`,
      type: 'indent',
      layer: 'rule',
      severity: 'fix',
      fixable: true,
      title: `段落缩进 ${block.indent} 个空格`,
      detail: `应为 5 个半角空格，第 ${block.lineNo} 行是 ${block.indent} 个${block.indentRaw.includes('\t') ? '（含制表符）' : ''}。`,
      blockIds: [block.id],
      before: block.indentRaw + block.core.slice(0, 24),
      after: '     ' + block.core.slice(0, 24),
    });
  }
  for (const chapter of doc.chapters) {
    if (chapter.indent === 0) continue;
    issues.push({
      id: `N${String(issues.length + 1).padStart(4, '0')}`,
      type: 'indent',
      layer: 'rule',
      severity: 'fix',
      fixable: true,
      title: '章节标题被缩进',
      detail: `标题应顶格，第 ${chapter.lineNo} 行前有 ${chapter.indent} 个空格。`,
      blockIds: [chapter.id],
      before: chapter.indentRaw + chapter.core,
      after: chapter.core,
    });
  }
  return issues;
}

/** 空行：段与段之间不留空行；章节前最多留 1 个；首尾不留。 */
export function detectBlank(doc) {
  const issues = [];
  const blocks = doc.blocks;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.kind !== 'blank') continue;
    const prev = blocks[index - 1];
    const next = blocks[index + 1];
    const beforeChapter = next?.kind === 'chapter';
    const atEdge = !prev || !next;
    const allowed = atEdge ? 0 : beforeChapter ? 1 : 0;
    if (block.count <= allowed) continue;

    let title = '多余空行';
    if (atEdge) title = prev ? '文末多余空行' : '文首空行';
    else if (beforeChapter) title = `章节前空行过多（${block.count} 行）`;
    else title = `段落之间夹了 ${block.count} 个空行`;

    issues.push({
      id: `E${String(issues.length + 1).padStart(4, '0')}`,
      type: 'blank',
      layer: 'rule',
      severity: 'fix',
      fixable: true,
      title,
      detail: atEdge
        ? '文件开头/结尾的空行会破坏排版，建议删除。'
        : beforeChapter
          ? '章节之间保留 1 个空行即可，多余的会压成 1 个。'
          : '小说按行分段，段与段之间不需要空行。',
      blockIds: [block.id],
      removed: block.count - allowed,
      allowed,
    });
  }
  return issues;
}

function collectUrls(text) {
  const urls = new Set();
  for (const regex of [URL_RE, DOMAIN_RE, EMAIL_RE]) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) urls.add(match[0]);
  }
  return [...urls];
}

/**
 * 找到网址区间，并把紧贴在它前面的“更多章节请访问 / 最新网址：”一并圈进去。
 * 这样删完网址不会留下半句广告。
 */
function urlRanges(text) {
  const raw = [];
  for (const url of collectUrls(text)) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(url, from);
      if (start < 0) break;
      let begin = start;
      const prefix = text.slice(Math.max(0, start - 24), start);
      const lead = prefix.match(/(更多章节|最新章节|最新网址|请访问|请记住本站|记住本站|首发网址|更新最快|手机阅读|电脑阅读|点击下一页|本章未完|本章完)[^。！？\n]{0,12}$/);
      if (lead) begin = Math.max(0, start - lead[0].length);
      let end = start + url.length;
      while (end < text.length && /[）)】」』，,。.；;、!?！？]/.test(text[end])) end += 1;
      raw.push({ start: begin, end, text: text.slice(begin, end) });
      from = start + url.length;
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of raw) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      if (range.end > last.end) {
        last.end = range.end;
        last.text = text.slice(last.start, last.end);
      }
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function candidatePriority(candidate) {
  if (candidate.strength === 'strong') return 100 + Math.min(20, candidate.score || 0);
  if (candidate.boundary) return 60;
  return 40;
}

/**
 * 无关内容候选：
 *  - strong：短广告、网址、联系方式、纯符号 → 默认删除；
 *  - medium：章节首尾的短留言、长段落里的广告词 → 交给 AI；
 *  - inline：长正文里的网址 → 只删网址，不删整段。
 */
export function detectIrrelevant(doc) {
  const candidates = [];
  const issues = [];
  const chapters = doc.chapters;
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));

  for (const block of doc.paragraphs) {
    const text = block.core;
    if (!text) continue;
    const urls = collectUrls(text);
    const meta = META_RE.test(text) || AD_PREFIX.test(text);
    const contact = CONTACT_RE.test(text);
    const noisy = NOISE_RE.test(text) && text.length <= 16;
    const boundary = isChapterBoundary(block, doc);

    // 长正文里夹网址：只做行内删除，保留故事。
    if (urls.length && text.length > 45 && /[。！？!?]/.test(text) && !noisy && !(meta && text.length <= 90)) {
      const matches = urlRanges(text);
      if (matches.length) {
        const inlineId = `D${String(candidates.length + 1).padStart(4, '0')}`;
        candidates.push({
          id: inlineId,
          type: 'irrelevant',
          mode: 'inline',
          blockId: block.id,
          text,
          urls,
          matches,
          strength: 'strong',
          score: 80,
          reason: '正文里夹带的网址',
          boundary,
        });
        issues.push({
          id: inlineId,
          type: 'irrelevant',
          layer: 'rule',
          severity: 'fix',
          fixable: true,
          mode: 'inline',
          title: '正文夹带网址',
          detail: `第 ${block.lineNo} 行正文里夹着 ${urls.length} 个网址，只删除网址，不改动故事。`,
          blockIds: [block.id],
          before: urls.join('、'),
          after: '（删除网址）',
          matches,
          toggle: false,
        });
        // 长正文不再整段删除。
        continue;
      }
    }

    let strength = null;
    let reason = '';
    let score = 0;
    const hardEvidence = noisy || meta || contact || urls.length > 0;

    if (noisy) {
      strength = 'strong';
      reason = '只有符号、没有文字';
      score = 90;
    } else if (meta && text.length <= 90) {
      strength = 'strong';
      reason = '广告 / 作者留言 / 网站提示';
      score = 85;
    } else if ((contact || urls.length) && text.length <= 120) {
      strength = 'strong';
      reason = '联系方式或外部链接';
      score = 82;
    } else if (meta && text.length <= 180) {
      strength = 'medium';
      reason = '疑似作者留言 / 广告';
      score = 55;
    } else if (boundary && text.length <= 60 && CHAPTER_EDGE_META.test(text)) {
      strength = 'medium';
      reason = '章节首尾的短留言';
      score = 45;
    } else if (boundary && text.length <= 18) {
      strength = 'medium';
      reason = '章节首尾的孤立短句';
      score = 35;
    }

    if (!strength) continue;

    const id = `D${String(candidates.length + 1).padStart(4, '0')}`;
    const before = doc.paragraphs.find((item) => item.id === block.id);
    const beforeContext = doc.paragraphs[doc.paragraphs.indexOf(before) - 1];
    const afterContext = doc.paragraphs[doc.paragraphs.indexOf(before) + 1];
    candidates.push({
      id,
      type: 'irrelevant',
      mode: 'paragraph',
      blockId: block.id,
      text,
      urls,
      strength,
      score,
      reason,
      boundary,
      hardEvidence,
      contextBefore: beforeContext?.core.slice(-70) || '',
      contextAfter: afterContext?.core.slice(0, 70) || '',
      chapterTitle: block.chapterTitle || '',
    });

    issues.push({
      id,
      type: 'irrelevant',
      layer: strength === 'strong' ? 'rule' : 'ai',
      severity: strength === 'strong' ? 'fix' : 'warn',
      fixable: true,
      mode: 'paragraph',
      title: strength === 'strong' ? `无关内容：${reason}` : `疑似无关内容：${reason}`,
      detail: `第 ${block.lineNo} 行 · ${text.slice(0, 72)}${text.length > 72 ? '…' : ''}`,
      blockIds: [block.id],
      before: text.slice(0, 120),
      after: '（整段删除）',
      confidence: strength === 'strong' ? 0.9 : 0.5,
      toggle: true,
      applied: strength === 'strong',
    });
  }

  candidates.sort((a, b) => candidatePriority(b) - candidatePriority(a) || a.id.localeCompare(b.id));
  return { candidates, issues };
}

function isChapterBoundary(block, doc) {
  const paragraphs = doc.paragraphs;
  const index = paragraphs.findIndex((item) => item.id === block.id);
  if (index < 0) return false;
  const prev = paragraphs[index - 1];
  const next = paragraphs[index + 1];
  return !prev || !next || prev.chapterIndex !== block.chapterIndex || next.chapterIndex !== block.chapterIndex;
}

/** 不可见字符报告。把首次出现的行映射回段落，HMI 才能“定位”。 */
export function invisibleIssues(scan, doc) {
  const blockByLine = new Map(
    (doc?.paragraphs || []).map((block) => [block.lineNo, block.id]),
  );
  return scan.found.map((entry, index) => {
    const lineNo = entry.samples[0]?.line ?? null;
    const blockId = lineNo ? blockByLine.get(lineNo) || null : null;
    return {
      id: `V${String(index + 1).padStart(4, '0')}`,
      type: 'invisible',
      layer: 'rule',
      severity: 'fix',
      fixable: true,
      toggle: false,
      title: `${entry.name} × ${entry.count}`,
      detail: `${entry.hex} · ${entry.action === 'remove' ? '删除' : '替换为普通空格'} · 首次出现在第 ${lineNo ?? '?'} 行`,
      code: entry.code,
      hex: entry.hex,
      name: entry.name,
      action: entry.action,
      count: entry.count,
      lineNo,
      blockIds: blockId ? [blockId] : [],
      before: entry.hex,
      after: entry.action === 'remove' ? '（移除）' : '␠',
    };
  });
}

/** 编码报告。 */
export function encodingIssue(decoded, newline) {
  const issues = [];
  if (decoded.converted) {
    issues.push({
      id: 'U0001',
      type: 'encoding',
      layer: 'rule',
      severity: 'fix',
      fixable: true,
      toggle: false,
      title: `${decoded.encodingLabel} → UTF-8`,
      detail: `${decoded.bom ? '移除 BOM；' : ''}输出统一为 UTF-8（无 BOM）。${decoded.notes.join('；')}`,
      before: decoded.encodingLabel,
      after: 'UTF-8',
    });
  }
  if (newline.changed) {
    issues.push({
      id: `U${String(issues.length + 1).padStart(4, '0')}`,
      type: 'encoding',
      layer: 'rule',
      severity: 'fix',
      fixable: true,
      toggle: false,
      title: `换行符 ${newline.style} → LF`,
      detail: `统一换行符，避免不同系统打开时出现整本变一行或双倍行距。`,
      before: newline.style,
      after: 'LF',
    });
  }
  return issues;
}
