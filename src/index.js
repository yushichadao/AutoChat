import path from 'node:path';
import process from 'node:process';
import { loadConfig, validateConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { ChatProfiles } from './core/chats.js';
import { ROOT } from './core/paths.js';
import { HookLifecycle } from './bridge/hook-lifecycle.js';
import { HookClient } from './bridge/hook-client.js';
import { DialectStore } from './bridge/dialect.js';
import { Receiver } from './bridge/receiver.js';
import { buildPollPlan } from './bridge/poll-sql.js';
import { SelfFilter } from './bridge/self-filter.js';
import { PauseState, PidFile, shouldYieldToExisting } from './core/pause.js';
import { ContactCache } from './bridge/contacts.js';
import { detectWeChat, isProcessAlive } from './bridge/process.js';
import { probeHook } from './bridge/probe.js';
import { advise, trackVersion } from './bridge/compat.js';
import { AIClient } from './ai/client.js';
import { Memory } from './ai/memory.js';
import { AIReply } from './ai/replier.js';

/**
 * AutoChat：微信侧的本地 AI 助手。
 *
 * 只做微信一件事：把微信里收到的消息，按策略交给模型，再把回复发回微信。
 * 没有跨平台转发，没有外部协议对接 —— 所有行为都发生在你自己的微信账号里。
 */
async function main() {
  const cfg = loadConfig();
  const log = createLogger('main', cfg.logLevel);

  // 单实例保护（要放在最前面）：两个助手同时跑会对着同一个群各回一遍，
  // 既重复回复又双倍烧额度。pid 文件里记着上一个实例的进程号。
  const pidFile = new PidFile({ file: path.join(cfg.dataDir, 'autochat.pid') });
  const existingPid = pidFile.read();
  if (shouldYieldToExisting(existingPid, process.pid, await isProcessAlive(existingPid))) {
    log.error(`已有实例在运行（pid ${existingPid}），本实例退出，避免重复回复`);
    log.error('要用新的实例，请先停掉旧的：autochat stop');
    process.exit(1);
  }
  pidFile.write();

  const problems = validateConfig(cfg);
  if (problems.length) {
    for (const p of problems) log.error(`配置错误: ${p}`);
    log.error('修正 .env 后重试，可参考 .env.example');
    process.exit(1);
  }

  log.info('==== AutoChat 微信助手 ====');
  log.info(`注入模式 ${cfg.wechat.mode}｜接收模式 ${cfg.wechat.receiveMode}`);
  log.info(
    '合规提示：仅用于本人账号与本人有权处理的消息。若把自动回复用于冒充他人、诈骗、骚扰等行为，' +
      '产生的法律责任由使用者自行承担，详见 LEGAL.md'
  );

  if (cfg.wechat.skipInject) {
    log.warn('已跳过注入（WX_SKIP_INJECT=1），假定 hook 服务已在运行');
  } else {
    const lifecycle = new HookLifecycle(cfg.wechat, createLogger('hook', cfg.logLevel));
    await lifecycle.start();
  }

  // 版本自适应：先看微信版本有没有已知方案，再看这个 DLL 实际支持哪些接口
  const install = await detectWeChat(cfg.wechat.installDir).catch(() => null);
  const version = cfg.wechat.forceVersion || install?.version || '';

  const probe = await probeHook(cfg.wechat.host, cfg.wechat.port);
  const advice = advise({ version, probe, cfg: cfg.wechat });
  for (const n of advice.notes) log.info(`兼容性: ${n}`);
  for (const w of advice.warnings) log.warn(`兼容性: ${w}`);
  if (advice.changes.receiveMode && advice.changes.receiveMode !== cfg.wechat.receiveMode) {
    log.warn(`接收模式自动调整 ${cfg.wechat.receiveMode} → ${advice.changes.receiveMode}`);
    cfg.wechat.receiveMode = advice.changes.receiveMode;
  }

  const track = trackVersion(cfg.dataDir, version);
  if (track.changed) {
    log.warn(`微信版本 ${track.prev} → ${version}，hook DLL 的内部偏移很可能已失效，先跑 tools/check-env.js`);
  }

  const hook = new HookClient({
    host: cfg.wechat.host,
    port: cfg.wechat.port,
    endpoints: cfg.wechat.endpoints,
    dialect: new DialectStore(path.join(cfg.dataDir, 'dialect.json'), createLogger('dialect', cfg.logLevel)),
    logger: createLogger('hook-ipc', cfg.logLevel),
    dbName: cfg.wechat.pollDb,
  });

  const status = await hook.ping();
  if (!status.ok) {
    log.error('hook 端口通了但状态接口不可用，请确认 DLL 版本与微信版本匹配');
  } else {
    log.info('hook 状态:', JSON.stringify(status.data));
  }

  // 本机微信 wxid：用于识别「自己发出去的消息」。
  // 读不到就必须靠 WX_SELF_ID 手工指定，否则会把机器人自己的回复当成别人的提问。
  let wxid = cfg.wechat.selfId || '';
  try {
    const profile = await hook.selfProfile();
    if (profile?.wxid) {
      wxid = profile.wxid;
      log.info(`当前微信账号 ${profile.nickname || ''} (${profile.wxid})`);
    }
  } catch (err) {
    log.warn('读取微信资料失败，继续:', err.message);
  }
  if (!wxid) {
    // 兜底：从本地 Message 库把本机 StrAccount 读出来
    try {
      const found = await hook.selfAccount();
      if (found) {
        wxid = found;
        log.info(`本机微信 wxid（从本地库读出）: ${wxid}`);
      }
    } catch {
      /* 读不到就靠 WX_SELF_ID */
    }
  }
  if (!wxid) {
    log.warn(
      '未能确认本机微信 wxid：请在 .env 设置 WX_SELF_ID=你的wxid。' +
        '否则数据库轮询会把机器人自己发出的消息当成别人的提问，造成自问自答、刷屏与额度浪费'
    );
  }

  // 按会话自动生成轮询计划（WX_POLL_CHATS）；没填就退回手写 SQL
  const pollPlan = buildPollPlan(cfg.wechat.pollChats, {
    limit: cfg.wechat.pollLimit,
    dbBase: cfg.wechat.pollDb,
  });

  // 暂停状态：data/paused 存在就停止回复；pid 文件给「停止服务」用
  const pauseState = new PauseState({
    file: path.join(cfg.dataDir, 'paused'),
    logger: createLogger('switch', cfg.logLevel),
  });
  if (pauseState.isPaused()) {
    log.warn('自动回复已暂停（data/paused 存在），本进程不会回复任何消息');
  }

  // 「这条是不是我自己发的」判定器
  const selfFilter = new SelfFilter({
    mode: cfg.wechat.selfMode,
    selfId: wxid,
    file: path.join(cfg.dataDir, 'sent-messages.json'),
    logger: createLogger('self', cfg.logLevel),
  });

  const receiver = new Receiver({
    cfg: {
      ...cfg.wechat,
      selfId: wxid,
      watermarkFile: path.join(cfg.dataDir, 'poll-state.json'),
    },
    hook,
    logger: createLogger('recv', cfg.logLevel),
    pollPlan,
    selfFilter,
    contacts: new ContactCache({ hook, logger: createLogger('contact', cfg.logLevel) }),
  });

  await receiver.start();

  // AI 自动回复
  let air = null;
  let memory = null;
  if (cfg.ai.enabled) {
    const ai = new AIClient({
      baseUrl: cfg.ai.baseUrl,
      apiKey: cfg.ai.apiKey,
      model: cfg.ai.model,
      timeoutMs: cfg.ai.timeoutMs,
      logger: createLogger('ai', cfg.logLevel),
    });
    memory = new Memory({
      maxTurns: cfg.ai.contextTurns,
      ttlMs: cfg.ai.contextTtlMs,
      maxChars: cfg.ai.contextMaxChars,
      file: path.join(cfg.dataDir, 'ai-memory.json'),
      logger: createLogger('ai-mem', cfg.logLevel),
    });
    const profiles = new ChatProfiles({ chats: cfg.chats, rootDir: ROOT, logger: createLogger('chat', cfg.logLevel) });
    if (profiles.size) {
      log.info(`按会话差异化配置 ${profiles.size} 个：${profiles.ids().join(', ')}`);
    }
    air = new AIReply({
      cfg: { ...cfg.ai, selfMode: cfg.wechat.selfMode },
      ai,
      memory,
      hook,
      logger: createLogger('ai', cfg.logLevel),
      selfWxid: wxid,
      profiles,
      selfFilter,
      pauseState,
    });
    receiver.on('message', (msg) => {
      air.handle(msg).catch((err) => log.error('AI 回复异常', err.message));
    });
    log.info(
      `AI 已启用 model=${cfg.ai.model} base=${ai.baseUrl}｜群聊策略 ${cfg.ai.groupReply}` +
        `${cfg.ai.triggerPrefix ? `｜触发前缀 "${cfg.ai.triggerPrefix}"` : ''}` +
        `${cfg.ai.groupAtNames.length ? `｜@认可 ${cfg.ai.groupAtNames.join('/')}` : ''}` +
        `${Number.isFinite(cfg.ai.temperature) ? `｜温度 ${cfg.ai.temperature}` : ''}`
    );
  } else {
    log.info('AI 未启用（AI_ENABLED=0），只接收不回复');
  }

  const timer = setInterval(() => {
    const recv = receiver.stats;
    const aiPart = air
      ? `｜AI 回复 ${air.stats.replied} 失败 ${air.stats.failed} 跳过 ${air.stats.skipped}` +
        ` 过滤 ${air.stats.filtered} 回声 ${air.stats.echo} 暂停 ${air.stats.paused} 会话 ${memory.size}`
      : '';
    const gate = pauseState.isPaused() ? '【自动回复已暂停】' : '';
    log.info(
      `${gate}状态 回调 ${recv.webhook} 轮询 ${recv.poll} 去重 ${recv.dropped} 自发 ${recv.selfDropped} 拒绝 ${recv.rejected}${aiPart}`
    );
    memory?.cleanup();
  }, 60000);
  timer.unref?.();

  const shutdown = async (sig) => {
    log.info(`收到 ${sig}，正在退出`);
    clearInterval(timer);
    memory?.flush();
    selfFilter.save();
    pidFile.clear();
    await receiver.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 常驻服务的兜底：一次偶发异常不该让助手直接消失。
  // 这里只记日志、继续跑（不退出），否则用户会莫名其妙发现「机器人又不理人了」。
  process.on('unhandledRejection', (err) => {
    log.error(`未处理的 Promise 异常（已忽略，服务继续运行）: ${err?.stack || err?.message || err}`);
  });
  process.on('uncaughtException', (err) => {
    log.error(`未捕获异常（已忽略，服务继续运行）: ${err?.stack || err?.message || err}`);
  });
}

main().catch((err) => {
  console.error('启动失败:', err?.stack || err?.message || err);
  process.exit(1);
});
