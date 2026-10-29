import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { section, line, json, hint } from '../ui.js';
import { readContext } from '../../tasks/context.js';
import { MemorySummary, extractiveSummary } from '../../ai/memory-summary.js';
import { AIClient } from '../../ai/client.js';

/**
 * autochat memory —— 长期记忆摘要：查看 / 生成 / 导出 / 清空。
 * 与 `autochat context`（易失转录）不同，这里是持久的结构化摘要，可跨会话留存、可导出。
 */
function summaryStore(rootDir = ROOT) {
  const dataDir = loadConfig({ rootDir }).dataDir;
  return new MemorySummary({ file: path.join(dataDir, 'ai-memory-summary.json'), logger: { debug() {}, warn() {} } });
}

/** 用当前配置的模型构建一个 AIClient（仅 --rebuild 用）。 */
function buildAI(rootDir = ROOT) {
  const cfg = loadConfig({ rootDir }).ai;
  if (!cfg.enabled || !cfg.baseUrl) return null;
  return new AIClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    reasoningEffort: cfg.reasoningEffort,
    reasoningFormat: cfg.reasoningFormat,
    reasoningBudget: cfg.reasoningBudget,
  });
}

export async function run(ctx) {
  const sub = (ctx.positional[0] || 'list').toLowerCase();
  const chatId = ctx.positional[1] || ctx.opt('chat');
  const store = summaryStore(ROOT);

  if (sub === 'export') {
    const format = ctx.opt('format', 'memory');
    const scope = chatId ? 'chat' : 'global';
    const asJson = ctx.flag('json');
    const out = store.exportAs({ format, scope, chatId, asJson });
    if (ctx.flag('out')) {
      fs.writeFileSync(ctx.opt('out'), out, 'utf8');
      line('ok', '已导出', ctx.opt('out'));
      return;
    }
    if (asJson) json(JSON.parse(out));
    else console.log(out);
    return;
  }

  if (sub === 'clear') {
    store.clear(chatId || '');
    line('ok', '已清空记忆摘要', chatId || '全部');
    if (chatId) store.flush();
    else store.flush();
    return;
  }

  if (sub === 'summarize' || sub === 'summary') {
    // 从当前上下文转录并入摘要库（MS2）。默认抽取式；--rebuild 用模型重算。
    const ctxInfo = readContext(ROOT);
    if (!ctxInfo.exists || !ctxInfo.sessions.length) {
      line('warn', '还没有任何上下文转录，先用一会儿再来。');
      return;
    }
    const ai = ctx.flag('rebuild') ? buildAI(ROOT) : null;
    if (ctx.flag('rebuild') && !ai) hint('未配置可用模型，回退到抽取式摘要');
    let count = 0;
    for (const s of ctxInfo.sessions) {
      if (chatId && s.chatId !== chatId) continue;
      const transcript = s.last.length
        ? readTranscript(ROOT, s.chatId)
        : [];
      if (!transcript.length) continue;
      await store.ingest(s.chatId, transcript, { ai });
      count += 1;
    }
    store.flush();
    line('ok', '已生成摘要', `${count} 个会话`);
    if (!ctx.flag('rebuild')) hint('默认抽取式摘要（离线）。--rebuild 可改用模型重算。');
    return;
  }

  // list（默认）
  const all = store.all();
  if (ctx.flag('json')) {
    json({ count: all.length, sessions: all });
    return;
  }
  section('长期记忆摘要');
  if (!all.length) {
    line('warn', '(还没有记忆摘要)');
    hint('对话若干轮后会自动生成；或手动 `autochat memory summarize`');
    return;
  }
  for (const r of all) {
    const s = r.summary;
    const n = (s.facts?.length || 0) + (s.preferences?.length || 0) + (s.events?.length || 0);
    line('ok', r.chatId, `${n} 条 · ${new Date(r.updatedAt).toLocaleString()}`);
  }
  hint('导出：autochat memory export --format diary|memory|log|journal [--chat <id>] [--json]');
}

/** 读某会话的完整转录（供 --rebuild 重算）。 */
function readTranscript(rootDir, chatId) {
  const info = readContext(rootDir);
  try {
    const raw = JSON.parse(fs.readFileSync(info.file, 'utf8'));
    const bag = raw.sessions || {};
    return (bag[chatId]?.messages || []).map((m) => ({ role: m.role, content: m.content }));
  } catch {
    return [];
  }
}
