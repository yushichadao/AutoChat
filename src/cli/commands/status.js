import process from 'node:process';
import fs from 'node:fs';
import { ROOT } from '../../core/paths.js';
import { section, line, json, hint } from '../ui.js';
import { loadConfig } from '../../core/config.js';
import { serviceStatus } from '../../tasks/service.js';
import { readContext } from '../../tasks/context.js';
import { PauseState } from '../../core/pause.js';

/**
 * autochat status —— 当前状态快照。
 * 职责分工：status 只回答「现在是什么状态」，问题与修复建议交给 doctor。
 */
export async function run(ctx) {
  const cfg = loadConfig({ rootDir: ROOT });
  const svc = await serviceStatus(ROOT);
  const pause = new PauseState({ file: `${cfg.dataDir}/paused` });
  const paused = pause.isPaused();
  const ctxInfo = readContext(ROOT);
  const rateLimit = readRateLimitStats(cfg.dataDir);

  const state = {
    running: svc.running,
    pid: svc.pid,
    autoReply: cfg.ai.enabled ? (paused ? 'paused' : 'running') : 'disabled',
    paused,
    model: cfg.ai.model,
    baseUrl: cfg.ai.baseUrl,
    selfMode: cfg.wechat.selfMode,
    listenChats: cfg.wechat.pollChats,
    chats: Object.keys(cfg.chats || {}),
    contextTurns: cfg.ai.contextTurns,
    contextSessions: ctxInfo.count,
    rateLimit,
  };

  if (ctx.flag('json')) {
    json(state);
    return;
  }

  section('助手服务');
  line(svc.running ? 'ok' : 'warn', svc.running ? '运行中' : '没有在运行',
    svc.running ? 'pid ' + svc.pid : '用 autochat start 启动');

  section('自动回复');
  if (!cfg.ai.enabled) {
    line('warn', '未启用', 'AI_ENABLED=0（只接收消息、不回复）· 重启后生效');
  } else if (paused) {
    line('warn', '已暂停', '仍在接收消息与记日志 · autochat resume 恢复');
  } else {
    line('ok', '运行中', 'autochat pause 可立刻暂停');
  }

  section('配置');
  line('ok', '模型', cfg.ai.model + ' @ ' + (cfg.ai.baseUrl ? cfg.ai.baseUrl : '(未配置)'));
  line('ok', '自消息判定', cfg.wechat.selfMode);
  line('ok', '监听会话', cfg.wechat.pollChats.join(', ') ? cfg.wechat.pollChats.join(', ') : '(未配置)');
  line('ok', '按会话配置', Object.keys(cfg.chats || {}).join(', ') ? Object.keys(cfg.chats).join(', ') : '(无)');
  line('ok', '上下文记忆', cfg.ai.contextTurns + ' 轮 / ' + cfg.ai.contextMaxChars + ' 字符预算 / ' + ctxInfo.count + ' 个会话');
  // 能力开关：与 GUI「高级项」对齐，CLI 侧也要能核对灰度状态
  const on = (v) => (v ? '开' : '关');
  line(cfg.ai.webSearch ? 'ok' : 'dim', '联网搜索', on(cfg.ai.webSearch) + '（' + (cfg.ai.webSearchProvider || 'tavily') + ' / ' + (cfg.ai.webSearchMode || 'auto') + '）');
  line(cfg.ai.aiTools ? 'ok' : 'dim', 'AI 工具调用', on(cfg.ai.aiTools) + '（白名单 ' + (cfg.ai.aiToolsAllow && cfg.ai.aiToolsAllow.length ? cfg.ai.aiToolsAllow.join(',') : '全部内置') + ' / 最多 ' + (cfg.ai.aiToolsMaxRounds || 3) + ' 轮）');
  line(cfg.ai.modelRouting ? 'ok' : 'dim', '双模型路由', on(cfg.ai.modelRouting) + (cfg.ai.lightModel ? '（轻量 ' + cfg.ai.lightModel + '）' : '（未配轻量模型，开了也只会用主模型）'));
  line(cfg.ai.docAnalysis ? 'ok' : 'dim', '文档解读', on(cfg.ai.docAnalysis));
  line(cfg.ai.longTaskNotice ? 'ok' : 'dim', '长任务提示', on(cfg.ai.longTaskNotice));

  section('限流（R16 / GAP5）');
  if (!rateLimit) {
    line('warn', '暂无计数', '服务未运行或还没产生限流事件');
  } else {
    const cfgLine = `冷却 ${rateLimit.cooldownMs}ms / 每小时上限 ${rateLimit.maxPerHour} / 并发上限 ${rateLimit.maxConcurrent}`;
    line('ok', '阈值', cfgLine);
    line('ok', '跳过计数', `冷却 ${rateLimit.cooldownHits} · 配额 ${rateLimit.quotaHits} · 并发 ${rateLimit.concurrentHits}（当前在途 ${rateLimit.inflight}）`);
  }
  hint('想排查问题用 autochat doctor（会给出修复顺序）');
}

/** 读限流统计快照（replier 进程每 10s 落盘一次，跨进程可见，见 R16）。 */
function readRateLimitStats(dataDir) {
  try {
    const f = `${dataDir}/rate-limit-stats.json`;
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
