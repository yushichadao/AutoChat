/**
 * 工具注册表（Skills 框架，§16.4）。
 *
 * 每个 skill = { name, description, parameters(JSON Schema), execute(args, ctx) }。
 * 内置：web_search（收编 §16.2 的 provider）、calculator、time。
 * 危险工具（发消息 / 删文件 / 外部写）默认不内置；如需扩展，必须显式登记并走白名单。
 *
 * execute 一律返回「可 JSON 序列化」的结构化结果（出错也返回 {error}，不抛），
 * 由调用方回填模型，避免一次工具异常打挂整轮对话。
 */
import path from 'node:path';
import { runSearch, WEB_SEARCH_PROVIDERS } from './web-search.js';
import { writeTextFile, writeDocx, writeXlsx } from './office.js';

const SKILLS = {
  web_search: {
    name: 'web_search',
    description: '检索网页获取最新信息（新闻 / 天气 / 股价 / 实时事实）。仅在需要外部最新资料时使用。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词' } },
      required: ['query'],
    },
    async execute(args, ctx) {
      const cfg = ctx && ctx.webSearchConfig;
      if (!cfg) return { error: '缺少联网搜索配置' };
      // 只有第三方服务商（tavily / serpapi / bing）需要 key；custom（自建，如 SearXNG）免 key
      const prov = WEB_SEARCH_PROVIDERS[cfg.provider] || WEB_SEARCH_PROVIDERS.tavily;
      if (prov.needsKey && !cfg.key) return { error: `未配置联网搜索密钥（AI_WEB_SEARCH_KEY，${cfg.provider} 需要）` };
      if (cfg.provider === 'custom' && !cfg.customEndpoint) return { error: 'custom 服务商需要配置 AI_WEB_SEARCH_CUSTOM_URL' };
      const r = await runSearch({
        query: args.query,
        config: {
          enabled: true,
          provider: cfg.provider || 'tavily',
          apiKey: cfg.key,
          mode: 'always', // 模型已决定调用，强制检索
          prefix: cfg.prefix || '/web',
          maxResults: cfg.maxResults || 5,
          maxChars: cfg.maxChars || 4000,
          customEndpoint: cfg.customEndpoint || '',
        },
      });
      if (!r) return { error: '联网搜索未返回结果' };
      return { context: r.context, results: r.results };
    },
  },
  calculator: {
    name: 'calculator',
    description: '计算数学表达式（四则运算、括号、% 与常用 Math 函数）。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '例如 (1+2)*3' } },
      required: ['expression'],
    },
    execute(args) {
      const expr = String((args && args.expression) || '');
      // 仅允许数字与运算符，禁绝任意代码执行
      if (!/^[\d+\-*/().%\s,Math.PIEe]+$/.test(expr)) return { error: '非法表达式' };
      let val;
      try {
        val = Function('"use strict";return (' + expr + ')')();
      } catch (e) {
        return { error: '计算失败：' + e.message };
      }
      return { result: val };
    },
  },
  time: {
    name: 'time',
    description: '返回当前日期与时间（用户所在时区）。',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai；可空' } },
      required: [],
    },
    execute(args) {
      const tz = (args && args.timezone) || 'Asia/Shanghai';
      const now = new Date();
      let s;
      try {
        s = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'long', timeZone: tz }).format(now);
      } catch {
        s = now.toString();
      }
      return { time: s, iso: now.toISOString() };
    },
  },
  /**
   * 生成办公文档文件（md / txt / docx / xlsx），用于「把文档作为文件发给用户」。
   * restricted：会落盘，按「危险工具默认禁用」原则不进默认白名单，须显式写进 AI_TOOLS_ALLOW。
   */
  write_doc: {
    name: 'write_doc',
    description: '生成办公文档文件（md / txt / docx / xlsx）。要把报告、表格等作为文件发给用户时用；返回的 marker 写进回复即可作为文件消息发送。',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '文件名（不含路径），如 季度报告.docx' },
        format: { type: 'string', description: 'md | txt | docx | xlsx' },
        content: { type: 'string', description: 'md/txt 正文' },
        paragraphs: { type: 'array', items: { type: 'string' }, description: 'docx 段落数组' },
        rows: { type: 'array', items: { type: 'array' }, description: 'xlsx 二维表格' },
      },
      required: ['filename', 'format'],
    },
    restricted: true,
    async execute(args, ctx) {
      const outDir = ctx && ctx.docOutDir;
      if (!outDir) return { error: '未配置文件输出目录' };
      const format = String((args && args.format) || '').toLowerCase();
      // 清洗：路径分隔符 → 下划线（杜绝穿越），再去掉前导点（避免 .. 之类只剩怪名字）
      const name = String((args && args.filename) || '').replace(/[\\/]/g, '_').replace(/^\.+/, '').trim();
      if (!name) return { error: '缺少文件名' };
      // 沙箱：只允许落在输出目录内，杜绝路径穿越
      const base = path.resolve(outDir);
      const target = path.resolve(base, name);
      if (target !== base && !target.startsWith(base + path.sep)) return { error: '文件名不合法' };
      try {
        let p;
        if (format === 'docx') {
          const paras = Array.isArray(args.paragraphs) ? args.paragraphs : [String(args.content || '')];
          p = writeDocx(target, { paragraphs: paras });
        } else if (format === 'xlsx') {
          p = writeXlsx(target, { rows: Array.isArray(args.rows) ? args.rows : [] });
        } else if (format === 'md' || format === 'txt') {
          p = writeTextFile(target, String(args.content || ''));
        } else {
          return { error: `不支持的 format：${format}` };
        }
        return { ok: true, path: p, marker: `[[file:${p}]]`, hint: '把 marker 写进回复，即可作为文件消息发送' };
      } catch (e) {
        return { error: String(e && e.message ? e.message : e) };
      }
    },
  },
};

/** 全部内置技能名（用于白名单缺省）；restricted 的需显式放行。 */
export function allSkillNames() {
  return Object.keys(SKILLS).filter((n) => !SKILLS[n].restricted);
}

/** 生成给模型的 tools 声明（仅含白名单内的技能）。 */
export function listToolDefs(allowed) {
  const names = Array.isArray(allowed) && allowed.length ? allowed : Object.keys(SKILLS);
  return names
    .filter((n) => SKILLS[n])
    .map((n) => ({
      type: 'function',
      function: { name: SKILLS[n].name, description: SKILLS[n].description, parameters: SKILLS[n].parameters },
    }));
}

/** 执行某个技能；未知 / 异常都返回结构化结果（不抛），便于回填模型。 */
export async function callTool(name, args, ctx) {
  const skill = SKILLS[name];
  if (!skill) return { error: `未知工具 ${name}` };
  try {
    return await skill.execute(args || {}, ctx || {});
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}
