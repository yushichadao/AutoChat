/**
 * 长期记忆摘要（MS2 / MS3 / MS4 / MS7）。
 *
 * 与「上下文（context）」的区别：
 *  · context（src/ai/memory.js）= 易失的原始转录窗口，TTL 过期即丢；
 *  · summary（本文件）= AI / 抽取得到的**结构化概括**，持久落盘、跨会话留存、可累积、可导出。
 *
 * 摘要结构（轻量、可累积）：
 *  {
 *    facts:       string[]  // 事实 / 约定 / 关键信息
 *    preferences: string[]  // 用户的偏好、好恶、要求
 *    events:     string[]  // 已发生的事件 / 计划
 *  }
 *
 * 默认用「抽取式」摘要（离线、零成本、永远可用）；CLI `autochat memory summary --rebuild`
 * 可在用户显式触发时用模型重算（AI 版）。两者写入同一个持久库，互不冲突。
 */
import fs from 'node:fs';
import path from 'node:path';

const SUMMARY_VERSION = 1;
const MAX_PER_FIELD = 60;

/** 抽取式摘要：从转录里按规则挑出偏好 / 事件 / 事实。确定性、无模型依赖。 */
export function extractiveSummary(transcript) {
  const facts = [];
  const preferences = [];
  const events = [];
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  for (const m of transcript || []) {
    if (m.role !== 'user') continue;
    const text = clean(m.content);
    if (!text) continue;
    // 事件优先（含「去/买/计划/明天」等动作），避免被偏好正则里的「要」误吞
    if (/(了|去|买|做|发生|约定|记得|计划|明天|下周|之后|出发|到达)/.test(text)) {
      events.push(text);
    } else if (/(喜欢|讨厌|想|需要|希望|偏好|不要|别|拒绝|爱|想要)/.test(text)) {
      preferences.push(text);
    } else {
      facts.push(text);
    }
  }
  return {
    facts: dedupe(facts).slice(-MAX_PER_FIELD),
    preferences: dedupe(preferences).slice(-MAX_PER_FIELD),
    events: dedupe(events).slice(-MAX_PER_FIELD),
  };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function mergeSummary(prev, next) {
  return {
    facts: dedupe([...(prev?.facts || []), ...(next?.facts || [])]).slice(-MAX_PER_FIELD),
    preferences: dedupe([...(prev?.preferences || []), ...(next?.preferences || [])]).slice(-MAX_PER_FIELD),
    events: dedupe([...(prev?.events || []), ...(next?.events || [])]).slice(-MAX_PER_FIELD),
  };
}

export class MemorySummary {
  constructor({ file = '', logger, interval = 8 } = {}) {
    this.file = file;
    this.log = logger;
    this.interval = Math.max(1, interval);
    /** chatId -> { summary, updatedAt, messageCount } */
    this.sessions = new Map();
    this.dirty = false;
    this.flushTimer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const bag = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
      for (const [chatId, s] of Object.entries(bag)) {
        if (!s || !s.summary) continue;
        this.sessions.set(chatId, {
          summary: s.summary,
          updatedAt: s.updatedAt || Date.now(),
          messageCount: s.messageCount || 0,
        });
      }
    } catch (err) {
      this.log?.debug?.(`记忆摘要读取失败，忽略: ${err.message}`);
    }
  }

  scheduleFlush() {
    if (!this.file || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 5000);
    this.flushTimer.unref?.();
  }

  flush() {
    if (!this.file || !this.dirty) return;
    try {
      const sessions = {};
      for (const [chatId, s] of this.sessions) sessions[chatId] = s;
      const payload = JSON.stringify({ __v: SUMMARY_VERSION, sessions });
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log?.debug?.(`记忆摘要写入失败: ${err.message}`);
    }
  }

  /** 把一段转录并入某会话的摘要（默认抽取式；传入 ai 则用模型重算）。 */
  async ingest(chatId, transcript, { ai } = {}) {
    let next;
    if (ai) {
      try {
        next = await summarizeWithAI(ai, transcript);
      } catch {
        next = extractiveSummary(transcript);
      }
    } else {
      next = extractiveSummary(transcript);
    }
    const prev = this.sessions.get(chatId);
    const summary = mergeSummary(prev?.summary, next);
    this.sessions.set(chatId, {
      summary,
      updatedAt: Date.now(),
      messageCount: transcript.length,
    });
    this.dirty = true;
    this.scheduleFlush();
    return summary;
  }

  get(chatId) {
    return this.sessions.get(chatId) || null;
  }

  all() {
    return [...this.sessions.entries()].map(([chatId, s]) => ({ chatId, ...s }));
  }

  clear(chatId) {
    if (chatId) this.sessions.delete(chatId);
    else this.sessions.clear();
    this.dirty = true;
    this.scheduleFlush();
  }

  /**
   * 导出为可读形态（MS3）。
   * @param {{format?:'diary'|'memory'|'log'|'journal', scope?:'global'|'chat', chatId?:string, asJson?:boolean}} opts
   */
  exportAs({ format = 'memory', scope = 'global', chatId = '', asJson = false } = {}) {
    const rows = scope === 'chat' && chatId ? this.all().filter((r) => r.chatId === chatId) : this.all();
    if (asJson) {
      return JSON.stringify(
        { format, scope, generatedAt: new Date().toISOString(), sessions: rows },
        null,
        2
      );
    }
    return renderMarkdown(format, rows);
  }
}

/** 让模型把转录压成结构化摘要（返回 {facts,preferences,events}）。 */
async function summarizeWithAI(ai, transcript) {
  const text = (transcript || [])
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').slice(0, 500)}`)
    .join('\n');
  const prompt = [
    { role: 'system', content: '你是记忆摘要器。把对话转录压缩为结构化摘要，只输出 JSON：{"facts":[事实/约定],"preferences":[用户偏好/好恶],"events":[已发生/计划的事件]}。不要解释，不要多余字段。' },
    { role: 'user', content: text || '(空)' },
  ];
  const res = await ai.chat(prompt);
  const raw = res && res.text ? res.text : '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return extractiveSummary(transcript);
  try {
    const obj = JSON.parse(jsonMatch[0]);
    return {
      facts: Array.isArray(obj.facts) ? obj.facts.map(String) : [],
      preferences: Array.isArray(obj.preferences) ? obj.preferences.map(String) : [],
      events: Array.isArray(obj.events) ? obj.events.map(String) : [],
    };
  } catch {
    return extractiveSummary(transcript);
  }
}

function renderMarkdown(format, rows) {
  if (!rows.length) return '# 记忆导出\n\n（还没有任何记忆摘要）\n';
  const head = `# 记忆导出 · ${format}\n\n> 生成时间：${new Date().toLocaleString()}\n`;
  const blocks = rows.map((r) => renderOne(format, r));
  return head + '\n' + blocks.join('\n\n') + '\n';
}

function renderOne(format, r) {
  const s = r.summary || {};
  const meta = `**会话**：${r.chatId}  ·  ${new Date(r.updatedAt).toLocaleString()}  ·  ${r.messageCount} 条`;
  const list = (title, arr) =>
    arr && arr.length ? `### ${title}\n` + arr.map((x) => `- ${x}`).join('\n') : `### ${title}\n_无_`;
  if (format === 'log') {
    const all = [...(s.facts || []), ...(s.preferences || []), ...(s.events || [])];
    return `${meta}\n\n` + (all.length ? all.map((x) => `- ${x}`).join('\n') : '_无记录_');
  }
  if (format === 'journal') {
    const lines = [
      meta,
      '',
      s.facts?.length ? `今日了解到：${s.facts.join('；')}` : '',
      s.preferences?.length ? `对方偏好：${s.preferences.join('；')}` : '',
      s.events?.length ? `相关事件：${s.events.join('；')}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }
  if (format === 'diary') {
    return [
      `## ${r.chatId}`,
      `_${new Date(r.updatedAt).toLocaleDateString()}_`,
      '',
      list('事实 / 约定', s.facts),
      '',
      list('偏好', s.preferences),
      '',
      list('事件', s.events),
    ].join('\n');
  }
  // memory（默认）：记忆卡片
  return [meta, '', list('事实 / 约定', s.facts), '', list('偏好', s.preferences), '', list('事件', s.events)].join('\n');
}
