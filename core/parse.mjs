/**
 * 章 / 段解析。
 *
 * 小说稿不是 Markdown：一段就是一行，章节标题单独一行，空行只是排版噪音。
 * 这里先把“行”变成带编号的块，后续所有检查都引用同一套 B0001 编号。
 */

const DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

const UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

const CHAPTER_RE = /^第\s*([0-9０-９零〇一二三四五六七八九十百千万两]+)\s*([章节回卷集部篇])(?:\s*[：:、.．·\-—，,]?\s*(.*))?$/;
const BOOK_CHAPTER_RE = /^《([^》]{1,40})》\s*（第\s*([0-9０-９]+)\s*([章节回卷])）\s*(.*)$/;
const SPECIAL_RE = /^(序章|楔子|引子|引言|前言|序言|后记|尾声|终章|终曲|番外(?:篇)?\s*[0-9０-９零〇一二三四五六七八九十百千万两]*)(?:\s*[：:、.．·\-—，,]?\s*(.*))?$/;
const BOOK_SPECIAL_RE = /^《([^》]{1,40})》\s*(序章|楔子|引子|引言|前言|序言|后记|尾声|终章|终曲|番外(?:篇)?\s*[0-9０-９零〇一二三四五六七八九十百千万两]*)\s*$/;
const PAREN_CHAPTER_RE = /^[（(]\s*([0-9０-９零〇一二三四五六七八九十百千万两]{1,8})\s*[）)]\s*(.*)$/;
const BARE_CHAPTER_RE = /^([0-9０-９零〇一二三四五六七八九十百千万两]{1,12})\s*([章节回卷])(?:\s*[：:、.．·\-—，,]?\s*(.*))?$/;
const ENGLISH_RE = /^(Chapter|CHAPTER|chapter)\s+([0-9]+|[IVXLCDM]+)\b(.*)$/;

const TRAILING_PUNCT = /[，,。.、；;：:！？!?]+$/;

function normalizeDigits(value) {
  return String(value).replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

/** 中文数字转阿拉伯数字，支持 1–9999 与“十二 / 两百 / 一百零二”。 */
export function chineseToNumber(value) {
  const raw = normalizeDigits(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === '〇' || raw === '零') return 0;

  let total = 0;
  let section = 0;
  let number = 0;
  let seen = false;

  for (const char of raw) {
    if (char in DIGITS) {
      number = DIGITS[char];
      seen = true;
      continue;
    }
    const unit = UNITS[char];
    if (!unit) return null;
    seen = true;
    if (unit >= 10000) {
      section += number;
      total += (section || 1) * unit;
      section = 0;
    } else {
      section += (number || 1) * unit;
    }
    number = 0;
  }
  if (!seen) return null;
  return total + section + number;
}

function romanToNumber(value) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  const upper = value.toUpperCase();
  for (let index = 0; index < upper.length; index += 1) {
    const current = map[upper[index]];
    const next = map[upper[index + 1]];
    if (!current) return null;
    total += current < next ? -current : current;
  }
  return total || null;
}

/**
 * 识别章节标题。宁可漏认，也不要把正文里的“第一章”引用当成标题。
 * @param {string} line
 * @returns {null|{number:number|null, unit:string, title:string, raw:string, special:boolean, volume:boolean, style:string}}
 */
export function detectChapter(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.length > 80) return null;
  // 旧稿常见「第一章，」「第一章。」这种行尾标点：先剥掉再识别。
  // 但正文里带完整句号的引用（“见第一章，他走了。”）仍然不当作标题。
  const text = raw.replace(TRAILING_PUNCT, '').trim();
  if (!text || text.length > 80) return null;
  if (/[。！？!?]/.test(text)) return null;

  const bookMatch = text.match(BOOK_CHAPTER_RE);
  if (bookMatch) {
    const number = chineseToNumber(bookMatch[2]);
    if (number === null) return null;
    const unit = bookMatch[3];
    return {
      number,
      unit,
      title: (bookMatch[4] || '').trim(),
      raw,
      special: false,
      volume: unit === '卷',
      style: 'arabic',
      bookName: bookMatch[1].trim(),
    };
  }

  const bookSpecial = text.match(BOOK_SPECIAL_RE);
  if (bookSpecial) {
    return {
      number: null,
      unit: 'special',
      title: '',
      raw,
      special: true,
      volume: false,
      style: 'special',
      bookName: bookSpecial[1].trim(),
    };
  }

  // 旧论坛稿常见单独一行 `(12)` / `（14）` 作为章节号。
  const parenMatch = text.match(PAREN_CHAPTER_RE);
  if (parenMatch) {
    const number = chineseToNumber(parenMatch[1]);
    if (number === null) return null;
    return {
      number,
      unit: 'paren',
      title: (parenMatch[2] || '').trim(),
      raw,
      special: false,
      volume: false,
      style: 'paren',
    };
  }

  // 有些旧稿会丢掉「第」：二十二章 / 12章。
  const bareMatch = text.match(BARE_CHAPTER_RE);
  if (bareMatch) {
    const number = chineseToNumber(bareMatch[1]);
    if (number === null) return null;
    const unit = bareMatch[2];
    const title = (bareMatch[3] || '').trim();
    // 「一回到这里，他便……」这类正文不能因为以「一回」开头就当成章节。
    if (title.length > 40) return null;
    return {
      number,
      unit,
      title,
      raw,
      special: false,
      volume: unit === '卷',
      style: 'bare',
    };
  }

  const match = text.match(CHAPTER_RE);
  if (match) {
    const number = chineseToNumber(match[1]);
    if (number === null) return null;
    const unit = match[2];
    return {
      number,
      unit,
      title: (match[3] || '').trim(),
      raw,
      special: false,
      volume: unit === '卷' || unit === '集' || unit === '部' || unit === '篇',
      style: /^\d+$/.test(normalizeDigits(match[1])) ? 'arabic' : 'chinese',
    };
  }

  const special = text.match(SPECIAL_RE);
  if (special) {
    return {
      number: null,
      unit: 'special',
      title: (special[2] || '').trim(),
      raw,
      special: true,
      volume: false,
      style: 'special',
    };
  }

  const english = text.match(ENGLISH_RE);
  if (english) {
    const number = /^\d+$/.test(english[2]) ? Number(english[2]) : romanToNumber(english[2]);
    return {
      number,
      unit: 'chapter',
      title: (english[3] || '').trim(),
      raw,
      special: false,
      volume: false,
      style: 'english',
    };
  }

  return null;
}

export function countChars(text) {
  return String(text || '').replace(/\s/g, '').length;
}

/**
 * 统一章节标题：
 *   第一章 雨夜      → 《书名》（第1章）雨夜
 *   第001章：旧信    → 《书名》（第1章）旧信
 *   第2章            → 《书名》（第2章）
 * 原标题为空时不补标题；书名会去掉重复的《》。
 */
export function formatChapterTitle(block, bookName = '') {
  if (!block || block.kind !== 'chapter') return '';
  const book = String(bookName || '')
    .replace(/^《+/, '')
    .replace(/》+$/, '')
    .trim() || '未命名';
  const title = String(block.chapterTitle || '').trim().replace(/\s+/g, ' ');
  const number = block.chapterNumber;
  const unit = block.chapterUnit;

  if (number !== null && number !== undefined && (['章', '节', '回'].includes(unit) || unit === 'paren')) {
    return `《${book}》（第${number}章）${title}`;
  }
  if (number !== null && number !== undefined && unit === '卷') {
    return `《${book}》（第${number}卷）${title}`;
  }

  const raw = String(block.text || block.core || '').trim().replace(/\s+/g, ' ');
  const withoutBook = raw.replace(/^《[^》]+》\s*/, '');
  return `《${book}》${withoutBook}`;
}

/**
 * @param {string} rawText  保留不可见字符的原文（已统一 LF）
 * @param {string} baseText 不可见字符已清理的文本（行数必须一致）
 */
export function parseDocument(rawText, baseText, bookName = '') {
  const rawLines = String(rawText).split('\n');
  const baseLines = String(baseText).split('\n');
  // 清理不可见字符只会在行内增删，不会改变行数；真不一致时以短的一侧为准。
  let lineCount = Math.min(rawLines.length, baseLines.length);
  // 文件末尾的单个换行是正常的行终止符，不应被当成“文末空行”。
  if (lineCount > 0 && baseLines[lineCount - 1] === '' && String(baseText).endsWith('\n')) {
    lineCount -= 1;
  }

  const blocks = [];
  const chapters = [];
  const paragraphs = [];
  let chapterIndex = 0;
  let blankRun = null;
  let paragraphSeq = 0;

  const closeBlank = () => {
    if (!blankRun) return;
    blocks.push(blankRun);
    blankRun = null;
  };

  for (let index = 0; index < lineCount; index += 1) {
    const raw = rawLines[index];
    const base = baseLines[index];
    const lineNo = index + 1;

    if (!base.trim()) {
      if (!blankRun) {
        blankRun = {
          id: `G${String(blocks.length + 1).padStart(4, '0')}`,
          kind: 'blank',
          lineNo,
          lineNos: [],
          count: 0,
          chapterIndex,
        };
      }
      blankRun.lineNos.push(lineNo);
      blankRun.count += 1;
      continue;
    }
    closeBlank();

    const chapter = detectChapter(base);
    if (chapter) {
      chapterIndex += 1;
      const block = {
        id: `B${String(blocks.length + 1).padStart(4, '0')}`,
        kind: 'chapter',
        lineNo,
        raw,
        base,
        text: base.trim(),
        core: base.trim(),
        indent: (base.match(/^[ \t]*/)[0] || '').length,
        chapterIndex,
        chapterNumber: chapter.number,
        chapterUnit: chapter.unit,
        chapterTitle: chapter.title,
        chapterStyle: chapter.style,
        special: chapter.special,
        volume: chapter.volume,
      };
      block.formattedTitle = formatChapterTitle(block, bookName);
      blocks.push(block);
      chapters.push(block);
      continue;
    }

    paragraphSeq += 1;
    const leading = base.match(/^[ \t]*/)[0] || '';
    const block = {
      id: `B${String(blocks.length + 1).padStart(4, '0')}`,
      kind: 'paragraph',
      lineNo,
      raw,
      base,
      text: base,
      core: base.trim(),
      indent: leading.length,
      indentRaw: leading,
      chapterIndex,
      chapterNumber: null,
      chapterTitle: chapters.length ? chapters[chapters.length - 1].chapterTitle : '',
      paragraphSeq,
    };
    blocks.push(block);
    paragraphs.push(block);
  }
  closeBlank();

  // 去掉首尾空块，但保留它们在原文里的行号用于报告。
  const leadingBlank = blocks[0]?.kind === 'blank' ? blocks[0] : null;
  const trailingBlank = blocks[blocks.length - 1]?.kind === 'blank' ? blocks[blocks.length - 1] : null;

  const bodyText = paragraphs.map((block) => block.core).join('\n');
  const title = chapters.find((chapter) => chapter.chapterTitle)?.chapterTitle || '未命名稿件';

  return {
    title,
    rawText,
    baseText,
    lines: lineCount,
    blocks,
    chapters,
    paragraphs,
    leadingBlank,
    trailingBlank,
    stats: {
      chars: countChars(bodyText),
      charsWithTitle: countChars([...chapters.map((chapter) => chapter.text), ...paragraphs.map((block) => block.core)].join('')),
      paragraphs: paragraphs.length,
      chapters: chapters.filter((chapter) => !chapter.volume && !chapter.special).length,
      headings: chapters.length,
      blanks: blocks.filter((block) => block.kind === 'blank').reduce((sum, block) => sum + block.count, 0),
    },
  };
}
