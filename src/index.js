import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadConfig, validateConfig } from './core/config.js';
import { envFile, jsonFile } from './core/paths.js';
import { setEnvValues } from './core/env-file.js';
import { effectivePollChats } from './tasks/doctor.js';
import { createLogger } from './core/logger.js';
import { ChatProfiles } from './core/chats.js';
import { loadAccountConfig, accountMemoryFile, accountSummaryFile } from './core/account-profile.js';
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
import { patchGisLogin } from './bridge/patch-gislogin.js';
import { advise, trackVersion } from './bridge/compat.js';
import { AIClient } from './ai/client.js';
import { Memory } from './ai/memory.js';
import { AIReply } from './ai/replier.js';
import { BatchAggregator } from './ai/batch-aggregator.js';

/**
 * AutoChat：微信侧的本地 AI 助手。
 *
 * 只做微信一件事：把微信里收到的消息，按策略交给模型，再把回复发回微信。
 * 没有跨平台转发，没有外部协议对接 —— 所有行为都发生在你自己的微信账号里。
 */
async function main() {
  let cfg = loadConfig();
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

  // 自研 DLL 的 g_IsLogin 门控：部分版本上登录事件没把它置 1，导致 QueryDB 全空。
  // 扫内存定位被摘出模块列表的 DLL、把 g_IsLogin 写成 1（与旧方案一致）。非致命：失败只告警。
  // 但如果 hook 已经报告 IsLogin=1，就没有「门控没置 1」这个前提，不必扫内存：
  // 那一步要起 PowerShell + 扫进程内存，找不到自研 DLL 时会白等 5 轮（≈20s）才继续，
  // 拖慢启动、也让 e2e 的超时被打满。
  const loginFlag = status.ok ? (status.data && (status.data.IsLogin ?? status.data.isLogin)) : undefined;
  if (Number(loginFlag) === 1) {
    log.debug('hook 已报告 IsLogin=1，跳过 g_IsLogin 补丁');
  } else {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const pr = await patchGisLogin().catch((e) => ({ ok: false, detail: e.message }));
      if (pr.ok) {
        log.info('g_IsLogin 门控已补:', pr.detail);
        break;
      }
      if (attempt < 5) {
        log.warn(`g_IsLogin 补丁未生效(${pr.detail})，${attempt}/5 重试…`);
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        log.warn(`g_IsLogin 门控未补上（${pr.detail}）；若 QueryDB 返回空，需确认用的是自研 version.dll`);
      }
    }
  }

  // 本机微信 wxid：用于识别「自己发出去的消息」。
  // 读不到就必须靠 WX_SELF_ID 手工指定，否则会把助手自己的回复当成别人的提问。
  let wxid = cfg.wechat.selfId || '';
  // 账号名：报身份用（「账号名 + 人设名 + 模型名」里的第一项）。
  // 优先级：手工配的 WX_SELF_NAME > hook 读到的昵称 > wxid。
  // 多账号项目：昵称由 hook 按当前登录账号自动返回，无需为每个账号硬编码。
  // hook 在微信刚启动时尚未就绪，单次 selfProfile 可能失败并永久回落到 wxid，
  // 故重试几次，确保拿到本账号昵称再回落。
  let selfNick = cfg.wechat.selfName || '';
  let profile = null;
  for (let attempt = 1; attempt <= 3 && !profile; attempt++) {
    try {
      const p = await hook.selfProfile();
      if (p && p.wxid) profile = p;
    } catch (err) {
      if (attempt === 3) log.warn('读取微信资料失败，继续:', err.message);
    }
    if (!profile && attempt < 3) await new Promise((r) => setTimeout(r, 1000));
  }
  if (profile) {
    wxid = profile.wxid;
    if (!selfNick && profile.nickname) selfNick = String(profile.nickname);
    log.info(`当前微信账号 ${profile.nickname || ''} (${profile.wxid})`);
  }
  const selfName = selfNick || wxid || '';
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
  // 固化：自动探测到的本机 wxid 写回 .env 的 WX_SELF_ID（仅当原本为空，绝不覆盖用户手动指定的值）。
  // 这样「自己发的消息」判定与体检的「小号检查」无需手工填 WX_SELF_ID；
  // 且重启 / hook 短暂不可达时也有稳定值可用 —— 即「靠自己获取并固化」。
  if (!cfg.wechat.selfId && wxid) {
    try {
      const ef = envFile(ROOT);
      if (ef && fs.existsSync(ef)) {
        setEnvValues(ef, { WX_SELF_ID: wxid });
        log.info(`本机 wxid 已固化到 .env（WX_SELF_ID=${wxid}）`);
      }
    } catch (e) {
      log.warn('固化 WX_SELF_ID 失败（不影响运行）:', e.message);
    }
  }
  if (!wxid) {
    log.warn(
      '未能确认本机微信 wxid：请在 .env 设置 WX_SELF_ID=你的wxid。' +
        '否则数据库轮询会把助手自己发出的消息当成别人的提问，造成自问自答、刷屏与额度浪费'
    );
  }
  // 按账号隔离：用当前登录账号派生「本账号配置」——记忆 / 摘要 / 会话 / AI 配置各自成档。
  // 不读旧的全局 ai-memory.json / config.json.chats，避免不同号的数据串在一起（如大号消息漏给小号）。
  cfg = loadAccountConfig({ rootDir: ROOT, wxid });

  // 监听会话 = WX_POLL_CHATS ∪ 按会话配置里启用的会话（并集，见 effectivePollChats）。
  // 正常用法就是「先跑起来，再一个一个加群」，所以这里绝不能让 .env 里的旧列表盖掉新加的群。
  // 红线：只监听用户显式加入的会话，不做任何自动发现 —— 未经授权的群不读、不回。
  const listenChats = effectivePollChats(cfg);
  const pollPlan = buildPollPlan(listenChats, {
    limit: cfg.wechat.pollLimit,
    dbBase: cfg.wechat.pollDb,
    // 把每群的群聊策略带进 plan，供漏接补偿（reconcile）据此跳过 never / mention 群
    groupReplyFor: (id) => cfg.chats?.[id]?.groupReply || cfg.ai.groupReply,
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
    contacts: (() => { const c = new ContactCache({ hook, logger: createLogger('contact', cfg.logLevel) }); c.setCurrentAccount(wxid); return c; })(),
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
      reasoningEffort: cfg.ai.reasoningEffort,
      reasoningFormat: cfg.ai.reasoningFormat,
      reasoningBudget: cfg.ai.reasoningBudget,
      logger: createLogger('ai', cfg.logLevel),
    });
    memory = new Memory({
      maxTurns: cfg.ai.contextTurns,
      ttlMs: cfg.ai.contextTtlMs,
      maxChars: cfg.ai.contextMaxChars,
      file: accountMemoryFile(cfg.dataDir, wxid),
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
      summaryFile: accountSummaryFile(cfg.dataDir, wxid),
      hook,
      logger: createLogger('ai', cfg.logLevel),
      selfWxid: wxid,
      selfName,
      profiles,
      selfFilter,
      pauseState,
    });
    // 多消息合批（G33/R28）：batch 模式会话的消息先进聚合器攒窗口，single 模式/非窗口消息直接走原 handle。
    const aggregator = new BatchAggregator({
      cfg: cfg.ai,
      profiles,
      selfWxid: wxid,
      logger: createLogger('batch', cfg.logLevel),
      shouldReplyFn: (m) => air.shouldReply(m),
      onFlush: (chatId, synthetic) =>
        air.handle(synthetic).catch((err) => log.error('合批回复异常', err.message)),
    });
    receiver.on('message', (msg) => {
      let consumed = false;
      try {
        consumed = aggregator.push(msg);
      } catch (e) {
        log.error('消息聚合失败', e.message);
      }
      if (!consumed) air.handle(msg).catch((err) => log.error('AI 回复异常', err.message));
    });
    // 把「配置来源」也打出来：读的哪个 .env、有没有环境变量想抢配置。
    // 这样「我配了 A 却跑 B」当场就能看出来源，而不是靠猜。
    const src = cfg.configSource || {};
    const shadow = (src.shadowedEnv || []).length ? `｜已忽略环境变量覆盖 ${src.shadowedEnv.join(',')}` : '';
    log.info(
      `AI 已启用 model=${cfg.ai.model} base=${ai.baseUrl}｜群聊策略 ${cfg.ai.groupReply}` +
        `${cfg.ai.triggerPrefix ? `｜触发前缀 "${cfg.ai.triggerPrefix}"` : ''}` +
        `${cfg.ai.groupAtNames.length ? `｜@认可 ${cfg.ai.groupAtNames.join('/')}` : ''}` +
        `${Number.isFinite(cfg.ai.temperature) ? `｜温度 ${cfg.ai.temperature}` : ''}` +
        `${cfg.ai.reasoningEffort && cfg.ai.reasoningEffort !== 'off' ? `｜思考强度 ${cfg.ai.reasoningEffort}` : ''}` +
        `｜配置来源 ${src.envFile || '(未读到 .env)'}${shadow}`
    );
  } else {
    log.info('AI 未启用（AI_ENABLED=0），只接收不回复');
  }

  // 配置热重载：正常用法就是「先跑起来，再一个一个加群」，
  // 不能要求每加入一个会话就重启一次服务（重启还会把上下文记忆冲掉）。
  // .env / config.json 任一变化就就地更新三样东西：
  //   ① 监听列表 —— 新群立刻进轮询（先对齐水位，不会把历史消息回一遍）
  //   ② 按会话配置 —— 新群的 groupReply / 人设 / 模型覆盖立刻生效
  //   ③ 全局 AI 策略 —— 群聊策略、触发前缀、限流数值一起换
  // AI 客户端与上下文记忆不重建，避免打断正在进行的对话。
  const watchFiles = [envFile(ROOT), jsonFile(ROOT)];
  const cfgSig = () =>
    watchFiles
      .map((f) => {
        try {
          return String(fs.statSync(f).mtimeMs || 0);
        } catch {
          return '0';
        }
      })
      .join('|');
  let lastCfgSig = cfgSig();
  const reloadTimer = setInterval(() => {
    const sig = cfgSig();
    // 两个文件都不存在（还没配置过）时不重载，免得把运行中的配置清成默认值
    if (sig === lastCfgSig || sig === '0|0') return;
    lastCfgSig = sig;
    (async () => {
      const fresh = loadAccountConfig({ rootDir: ROOT, wxid });
      const ids = effectivePollChats(fresh);
      const res = await receiver.setPlan(
        buildPollPlan(ids, {
          limit: fresh.wechat.pollLimit,
          dbBase: fresh.wechat.pollDb,
          groupReplyFor: (id) => fresh.chats?.[id]?.groupReply || fresh.ai.groupReply,
        })
      );
      air?.applyConfig({ ...fresh.ai, selfMode: fresh.wechat.selfMode }, fresh.chats);
      // 首次使用：起服务时一个会话都没有，轮询当时没启动；现在有了就补启动
      if (res.added.length && !receiver.pollTimer) await receiver.startPoll();
      const changed = [];
      if (res.added.length) changed.push(`新增 ${res.added.join(', ')}`);
      if (res.removed.length) changed.push(`移除 ${res.removed.join(', ')}`);
      log.info(
        `配置已热更新：监听会话 ${ids.length} 个${changed.length ? `（${changed.join('；')}）` : ''}` +
          (air ? `｜群聊策略 ${fresh.ai.groupReply}` : '')
      );
    })().catch((err) => log.error(`配置热更新失败（继续沿用旧配置）: ${err.message}`));
  }, 3000);
  reloadTimer.unref?.();

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
  // 保活柄：零会话（未配置轮询）时，事件循环里若没有任何 ref 句柄，main() 一返回进程就静默退出。
  // 这个心跳必须 ref，保证「先空跑、再从 GUI 热加载加群」的用法能活下来。


  const shutdown = async (sig) => {
    log.info(`收到 ${sig}，正在退出`);
    clearInterval(timer);
    clearInterval(reloadTimer);
    memory?.flush();
    selfFilter.save();
    pidFile.clear();
    await receiver.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 常驻服务的兜底：一次偶发异常不该让助手直接消失。
  // 这里只记日志、继续跑（不退出），否则用户会莫名其妙发现「助手又不理人了」。
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
