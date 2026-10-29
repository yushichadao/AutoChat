/**
 * 模型路由与长任务判定（§16.5）。
 *
 * 两条设计口径（用户 2026-10-27 定）：
 *  1. 默认一个模型：路由关闭时，始终用用户配的 AI_MODEL，行为可预测。
 *  2. 高级模式：按复杂度在两个「都由用户指定」的模型间切换 ——
 *     轻量模型（AI_LIGHT_*）打简单任务，复杂任务升级到主模型（AI_MODEL）。
 *
 * 复杂度判定走**纯规则**：不读模型、不额外调一次接口。
 * 这一点是硬要求 —— 若为判复杂度再调一次模型，就又落回「时间太长」的老问题。
 */

/** 命中即视为「复杂」的显式标记（分析 / 总结 / 写代码 / 详细解释 …）。 */
const COMPLEX_MARKERS = /分析|总结|总结下|详细|为什么|代码|写个|写一段|翻译|对比|比较|解释|方案|规划|报告|推理|证明/i;

/** 文本超过这个长度即视为复杂（长问题通常真的需要更强的模型）。 */
const LONG_TEXT_CHARS = 200;

/** 短到这个长度以下、又没有任何重活标记的，才可能是「瞬时小工具」（查时间 / 算个数）。 */
const QUICK_TEXT_CHARS = 16;

/**
 * 生成型任务标记（用户 2026-10-27 指出的漏洞）：
 * 写代码 / 长文这类请求**不调工具、不联网、没附件**，但输出本身就长、生成本身就慢 ——
 * 「回复时间长」未必来自工具，也可能纯粹来自生成量。
 * 所以它们既算复杂（升级主模型），也算长任务（先发提示），不能只看工具信号。
 */
const CODE_MARKERS = /代码|写个|写一段|编写|实现|函数|function|class|脚本|程序|调试|重构|debug|算法/i;
const LONGFORM_MARKERS = /写一篇|写一份|长文|文章|论文|报告|总结下|详细说说|展开讲|方案书|润色|翻译一下/i;

/**
 * 判定本次该用哪个模型。
 *
 * 只在「路由开启」时才有意义；路由关闭时调用方应始终用主模型。
 * @param {object} ctx
 * @param {string} [ctx.text] 用户文本
 * @param {boolean} [ctx.hasAttachment] 带附件（文档解读，天然是重活）
 * @param {boolean} [ctx.willSearch] 本次会触发联网搜索
 * @param {boolean} [ctx.toolsOn] 本次会走工具调用循环（多轮）
 * @returns {{tier:'light'|'main', reason:string}} tier=light 用轻量模型，main 用主模型
 */
export function pickModelTier({ text = '', hasAttachment = false, willSearch = false, toolsOn = false } = {}) {
  const t = String(text || '');
  if (hasAttachment) return { tier: 'main', reason: '带附件（文档解读）' };
  if (willSearch) return { tier: 'main', reason: '需要联网检索' };
  if (toolsOn) return { tier: 'main', reason: '需要工具调用（多轮）' };
  // 生成型任务：不用工具，但生成量大、耗时长，仍应交给主模型
  if (CODE_MARKERS.test(t)) return { tier: 'main', reason: '代码 / 程序类（生成慢）' };
  if (LONGFORM_MARKERS.test(t)) return { tier: 'main', reason: '长文写作（生成慢）' };
  if (t.length > LONG_TEXT_CHARS) return { tier: 'main', reason: `文本较长（${t.length} 字）` };
  if (COMPLEX_MARKERS.test(t)) return { tier: 'main', reason: '含复杂任务标记' };
  return { tier: 'light', reason: '简单问答' };
}

/**
 * 长任务提示文案。空串表示「不算长任务、不需要先发占位」。
 *
 * 微信不支持对已发消息原地替换，所以这里不是「原地占位」，而是：
 * 先发一条真消息（正在XX中……），结果**另起一条新消息**发在下面。
 * @param {object} ctx 同 pickModelTier
 * @returns {string} 提示文案；'' 表示不需要提示
 */
export function longTaskLabel({ hasAttachment = false, willSearch = false, toolsOn = false, text = '' } = {}) {
  const t = String(text || '');
  if (hasAttachment) return '正在解析文件……';
  if (willSearch) return '正在联网检索……';
  // 工具调用（多轮）：默认都先提示「正在处理」——写文件、多轮工具通常不快。
  // 唯一例外：能看出是「瞬时小工具」的场景才不打扰，否则每条「现在几点」都弹占位很烦。
  // 判定看语义标记而不是字数：「生成一份报告发我」只有 8 字，却要真去写一份 docx。
  if (toolsOn) {
    const heavy = isHeavyText(t);
    // 没有文本可判（如纯图片 / 语音）时按重活处理，宁可多提示一次也别让用户干等
    if (!t.trim() || heavy) return '正在处理……';
    return '';
  }
  // 生成型任务：不用工具也慢，同样值得先告知用户（calculator/time 等瞬时工具不再无差别提示「正在处理」）
  if (CODE_MARKERS.test(t)) return '正在编写代码……';
  if (LONGFORM_MARKERS.test(t)) return '正在撰写……';
  return '';
}

/**
 * 这段文本看起来像「重活」吗（命中生成型 / 复杂标记，或本身就够长）。
 * 用来把「现在几点」这类瞬时工具调用，和「生成一份报告发我」这类短但很慢的请求区分开。
 * @param {string} t
 * @returns {boolean}
 */
export function isHeavyText(t) {
  const s = String(t || '');
  if (CODE_MARKERS.test(s) || LONGFORM_MARKERS.test(s) || COMPLEX_MARKERS.test(s)) return true;
  return s.trim().length >= QUICK_TEXT_CHARS;
}

/** 是否属于「长任务」（需要先发一条占位提示）。 */
export function isLongTask(ctx = {}) {
  return Boolean(longTaskLabel(ctx));
}
