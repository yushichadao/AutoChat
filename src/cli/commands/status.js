import process from 'node:process';
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
  hint('想排查问题用 autochat doctor（会给出修复顺序）');
}
