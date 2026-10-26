/**
 * 不可见字符扫描。
 *
 * 原则：
 *  - 零宽 / 方向控制 / 变体选择符 / BOM：删掉；
 *  - 各种“看起来像空格”的字符：换成普通空格，避免把词粘在一起；
 *  - 制表符：换成 4 个空格（之后再由缩进规则统一成 5 个）；
 *  - 记录到码点和位置，HMI 才能在原文里把“看不见的东西”标出来。
 */

const REMOVE = new Map([
  [0x0000, 'NUL'],
  [0x0008, 'BACKSPACE'],
  [0x000b, 'VT'],
  [0x000c, 'FF'],
  [0x000e, 'SO'],
  [0x000f, 'SI'],
  [0x007f, 'DEL'],
  [0x00ad, '软连字符'],
  [0x034f, '组合字素连接符'],
  [0x061c, '阿拉伯字母标记'],
  [0x115f, '朝鲜文填充符'],
  [0x1160, '朝鲜文中声符'],
  [0x17b4, '高棉文固有元音'],
  [0x17b5, '高棉文固有元音'],
  [0x180b, '蒙古文自由变体选择符'],
  [0x180c, '蒙古文自由变体选择符'],
  [0x180d, '蒙古文自由变体选择符'],
  [0x180e, '蒙古文元音分隔符'],
  [0x200b, '零宽空格'],
  [0x200c, '零宽不连字'],
  [0x200d, '零宽连字'],
  [0x200e, '从左到右标记'],
  [0x200f, '从右到左标记'],
  [0x202a, '从左到右嵌入'],
  [0x202b, '从右到左嵌入'],
  [0x202c, '方向格式结束'],
  [0x202d, '从左到右覆盖'],
  [0x202e, '从右到左覆盖'],
  [0x2060, '单词连接符'],
  [0x2061, '函数应用'],
  [0x2062, '不可见乘号'],
  [0x2063, '不可见分隔符'],
  [0x2064, '不可见加号'],
  [0x2066, '从左到右隔离'],
  [0x2067, '从右到左隔离'],
  [0x2068, '首个强方向隔离'],
  [0x2069, '方向隔离结束'],
  [0x3164, '朝鲜文填充符'],
  [0xfeff, 'BOM / 零宽不换行空格'],
  [0xffa0, '朝鲜文半角填充符'],
  [0xfff9, '行间注释开始'],
  [0xfffa, '行间注释分隔'],
  [0xfffb, '行间注释结束'],
  [0xfffe, '非字符'],
  [0xffff, '非字符'],
]);

const SPACE = new Map([
  [0x0009, '制表符'],
  [0x00a0, '不换行空格'],
  [0x1680, '欧甘文空格'],
  [0x2000, 'En Quad'],
  [0x2001, 'Em Quad'],
  [0x2002, 'En Space'],
  [0x2003, 'Em Space'],
  [0x2004, '三分之一 Em Space'],
  [0x2005, '四分之一 Em Space'],
  [0x2006, '六分之一 Em Space'],
  [0x2007, '数字空格'],
  [0x2008, '标点空格'],
  [0x2009, '窄空格'],
  [0x200a, '发丝空格'],
  [0x202f, '窄不换行空格'],
  [0x205f, '数学空格'],
  [0x3000, '全角空格'],
]);

function isControl(code) {
  return (code >= 0x01 && code <= 0x08)
    || (code >= 0x0b && code <= 0x1f)
    || (code >= 0x7f && code <= 0x9f);
}

function isVariationSelector(code) {
  return (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function category(code) {
  if (REMOVE.has(code)) return { action: 'remove', name: REMOVE.get(code) };
  if (SPACE.has(code)) return { action: 'space', name: SPACE.get(code) };
  if (isControl(code)) return { action: 'remove', name: '控制字符' };
  if (isVariationSelector(code)) return { action: 'remove', name: '变体选择符' };
  if (code === 0x2800) return { action: 'remove', name: '盲文空白' };
  return null;
}

/**
 * @param {string} text
 * @returns {{
 *   cleaned: string,
 *   found: Array<{code:number, hex:string, name:string, action:string, count:number, samples:Array<{index:number,line:number}>}>,
 *   marksByLine: Map<number, Array<{index:number, code:number, hex:string, name:string, action:string}>>,
 *   total: number, kinds: number
 * }}
 */
function isCjk(char) {
  return Boolean(char) && /[\u3400-\u9fff\u3000-\u303f]/.test(char);
}

export function scanInvisible(text) {
  const found = new Map();
  const marksByLine = new Map();
  const chars = [...String(text)];
  let cleaned = '';
  let line = 1;
  let lineIndex = 0;
  let total = 0;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const code = char.codePointAt(0);
    const hit = category(code);
    if (!hit) {
      cleaned += char;
      if (char === '\n') {
        line += 1;
        lineIndex = 0;
      } else {
        lineIndex += 1;
      }
      continue;
    }

    total += 1;
    const hex = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    if (!found.has(code)) {
      found.set(code, {
        code,
        hex,
        name: hit.name,
        action: hit.action,
        count: 0,
        samples: [],
      });
    }
    const entry = found.get(code);
    entry.count += 1;
    if (entry.samples.length < 5) entry.samples.push({ index: lineIndex, line });

    if (!marksByLine.has(line)) marksByLine.set(line, []);
    marksByLine.get(line).push({ index: lineIndex, code, hex, name: hit.name, action: hit.action });

    if (hit.action === 'space') {
      // 全角空格 / NBSP 如果夹在两个汉字之间，多半是排版噪音：收掉；
      // 行首缩进或中英文之间则保留一个普通空格。ASCII 空格不在扫描范围，
      // 所以“第一章 雨夜”里的标题空格不会被误删。
      const previous = cleaned.at(-1) || '';
      const next = chars[index + 1] || '';
      const betweenCjk = isCjk(previous) && isCjk(next);
      const replacement = code === 0x0009 ? '    ' : betweenCjk ? '' : ' ';
      cleaned += replacement;
    }
    lineIndex += 1;
  }

  const normalized = cleaned.replace(/[ \t]+([，。！？；：、])/g, '$1');
  const list = [...found.values()].sort((a, b) => b.count - a.count || a.code - b.code);
  return {
    cleaned: normalized,
    found: list,
    marksByLine,
    total,
    kinds: list.length,
  };
}

/** 短标签，HMI 里把不可见字符显示成一个可读的红色小标记。 */
export function invisibleLabel(code) {
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  if (SPACE.has(code) || code === 0x0020) return { short: '␠', name: SPACE.get(code) || '空格', hex };
  if (code === 0x200b) return { short: 'ZW', name: '零宽空格', hex };
  if (code === 0x200c) return { short: 'ZWNJ', name: '零宽不连字', hex };
  if (code === 0x200d) return { short: 'ZWJ', name: '零宽连字', hex };
  if (code === 0xfeff) return { short: 'BOM', name: 'BOM', hex };
  if (code === 0x00ad) return { short: 'SHY', name: '软连字符', hex };
  if (code === 0x202e) return { short: 'RLO', name: '从右到左覆盖', hex };
  if (isVariationSelector(code)) return { short: 'VS', name: '变体选择符', hex };
  if (code === 0x3000) return { short: '□', name: '全角空格', hex };
  return { short: '∅', name: REMOVE.get(code) || '不可见字符', hex };
}
