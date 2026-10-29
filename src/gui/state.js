import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { readEnvFile } from '../core/env-file.js';
import { safeEnv } from '../tasks/config.js';
import { readChats } from '../core/chats.js';
import { PauseState, PidFile } from '../core/pause.js';
import { installStatus } from '../tasks/install.js';
import { detectWeChat } from '../bridge/process.js';
import { detectBuiltinDll } from '../tasks/autodll.js';
import { isVersionLocked } from '../tasks/lock.js';
import { HookClient } from '../bridge/hook-client.js';
import { ContactCache } from '../bridge/contacts.js';
import { explainReasoning } from '../core/reasoning.js';
import { loadPersona, buildBaseline, fillVars } from '../ai/persona.js';

/**
 * 密钥类字段给界面看的元信息：是否配置、已保存的真值、脱敏预览。
 * 界面默认就显示「有没有密钥」+ 真值（账号是本人本机跑，不外发到别处），
 * 让用户能确认密钥存在还是不存在、并支持「填了立即替换旧的」。
 * @param {Record<string,string>} env 原始 .env（未脱敏）
 * @param {string} key
 */
function secretInfo(env, key) {
  const raw = env && env[key] != null ? String(env[key]) : '';
  const present = Boolean(raw);
  return {
    present,
    value: raw,
    preview: present ? (raw.length > 8 ? raw.slice(0, 4) + '…' + raw.slice(-4) : '•'.repeat(raw.length)) : '',
  };
}

/**
 * 状态快照装配（图形化配置器）。
 *
 * 职责边界：**把「现在什么状态」组装成一份 JSON**，
 * 供界面渲染；不含任何写操作。
 */

/** 复用一个 hook 客户端与通讯录缓存，避免每次刷新都重建连接。 */
let _hook = null;
let _contacts = null;
let _hookKey = '';

export function getHookContacts(rootDir) {
  const cfg = loadConfig({ rootDir });
  const key = cfg.wechat.host + ':' + cfg.wechat.port;
  if (_hook && _hookKey === key) return { hook: _hook, contacts: _contacts };
  _hook = new HookClient({
    host: cfg.wechat.host,
    port: cfg.wechat.port,
    endpoints: cfg.wechat.endpoints,
    dbQueryTimeoutMs: 3000,
  });
  _contacts = new ContactCache({ hook: _hook });
  _hookKey = key;
  return { hook: _hook, contacts: _contacts };
}

/**
 * 探测微信登录状态（true/false/null=未知）。
 * 未登录时所有 QueryDB 都会失败，界面必须先说清楚，否则用户只会看到“搜不到/收不到”。
 * 15 秒缓存，避免 4 秒自动刷新反复打 ping。
 */
let _loginCache = { at: 0, key: '', value: null };
async function probeLogin(rootDir) {
  const cfg = loadConfig({ rootDir });
  const key = cfg.wechat.host + ':' + cfg.wechat.port;
  if (_loginCache.key === key && Date.now() - _loginCache.at < 15000) return _loginCache.value;
  let value = null;
  try {
    const { hook } = getHookContacts(rootDir);
    // confirmLogin 会在 IsLogin 误报成 0 时，用「本机账号能否从本地库读到」反证，规避假阴性
    value = await hook.confirmLogin();
  } catch {
    value = null;
  }
  _loginCache = { at: Date.now(), key, value };
  return value;
}

/**
 * 探测当前登录微信号（wxid + 昵称）。
 * 优先 hook /GetSelfProfile（实时、最准），失败再试本地库兜底；
 * 都拿不到返回 null，由上层回落 .env 的 WX_SELF_ID。
 * 15 秒缓存，避免刷新反复打 hook（与 probeLogin 同策略）。
 */
let _accountCache = { at: 0, key: '', value: null };
async function probeAccount(rootDir) {
  const cfg = loadConfig({ rootDir });
  const key = cfg.wechat.host + ':' + cfg.wechat.port;
  if (_accountCache.key === key && Date.now() - _accountCache.at < 15000) return _accountCache.value;
  let value = null;
  try {
    const { hook } = getHookContacts(rootDir);
    const st = await hook.ping().catch(() => ({ ok: false }));
    if (st.ok) {
      const prof = await hook.selfProfile().catch(() => null);
      if (prof && prof.wxid) {
        value = { wxid: prof.wxid, nickname: prof.nickname || '', source: 'hook' };
      } else {
        const acc = await hook.selfAccount().catch(() => '');
        if (acc) value = { wxid: acc, nickname: '', source: 'db' };
      }
    }
  } catch {
    value = null;
  }
  _accountCache = { at: Date.now(), key, value };
  return value;
}

/**
 * 微信目录里实际会被加载的 version.dll（DLL 劫持位）。
 *
 * 为什么必须单独算：微信启动时只认安装目录下的 version.dll，
 * 而配置里的 WX_DLL_PATH 可能指向别处（甚至另一份 DLL）。
 * 两者不一致时，跑起来的是磁盘上那份旧的 —— 典型症状就是 hook 能 ping 通、
 * 但 IsLogin=0、所有 QueryDB 报 “get database handle ... failed”。
 *
 * 按 size+mtime 缓存哈希，避免 4 秒刷新反复读 4MB 文件。
 */
let _dllCache = { key: '', value: null };
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function inspectDeployedDll(installDir, configured, expected) {
  const target = installDir ? path.join(installDir, 'version.dll') : '';
  if (!target || !fs.existsSync(target)) return null;
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return null;
  }
  const key = `${target}|${st.size}|${st.mtimeMs}|${configured || ''}|${expected || ''}`;
  if (_dllCache.key === key) return _dllCache.value;

  const safeHash = (f) => {
    try {
      return f && fs.existsSync(f) ? sha256(f) : '';
    } catch {
      return '';
    }
  };
  const deployedHash = safeHash(target);
  const configuredHash = safeHash(configured);
  const expectedHash = safeHash(expected);
  const value = {
    path: target,
    size: st.size,
    mtime: st.mtimeMs,
    isHook: st.size > 200 * 1024, // 真正的系统 version.dll 只有几十 KB
    configured: configured || '',
    expected: expected || '',
    // 微信目录里的这份 == 配置里的那份吗
    matches: Boolean(configuredHash) && configuredHash === deployedHash,
    // 微信目录里的这份 == 该微信版本应该用的内置 DLL 吗（false 说明拿错了版本）
    matchesExpected: expectedHash ? expectedHash === deployedHash : null,
  };
  _dllCache = { key, value };
  return value;
}

/** 给会话附上汉字名（群名 / 昵称）。hook 不可达就留空，不影响主流程。 */
async function attachContactNames(rootDir, memory, chats, accountWxid) {
  const ids = [];
  for (const m of memory || []) if (m.chatId) ids.push(m.chatId);
  for (const id of Object.keys(chats || {})) ids.push(id);
  if (!ids.length) return;
  try {
    const { hook, contacts } = getHookContacts(rootDir);
    contacts.setCurrentAccount(accountWxid);
    const st = await hook.ping().catch(() => ({ ok: false }));
    if (!st.ok) return;
    await contacts.lookup(ids, accountWxid);
    for (const m of memory || []) {
      const nm = contacts.nameOf(m.chatId, accountWxid);
      if (nm) m.name = nm;
    }
    for (const [id, c] of Object.entries(chats || {})) {
      const nm = contacts.nameOf(id, accountWxid);
      if (nm) c.name = nm;
    }
  } catch {
    /* 查联系人失败不影响状态快照 */
  }
}

/** 组装完整状态。 */
export async function buildState(rootDir = ROOT) {
  const cfg = loadConfig({ rootDir });
  const sw = new PauseState({ file: cfg.dataDir + '/paused' });
  const pid = new PidFile({ file: cfg.dataDir + '/autochat.pid' }).read();
  const inst = await installStatus({ rootDir });
  const wechat = await detectWeChat(cfg.wechat.installDir).catch(() => null);

  const builtin = await detectBuiltinDll(rootDir, cfg.wechat.installDir);
  const memory = [];
  const memFile = cfg.dataDir + '/ai-memory.json';
  if (fs.existsSync(memFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(memFile, 'utf8'));
      const bag = raw.sessions || raw;
      for (const [id, s] of Object.entries(bag)) {
        if (id === '__v') continue;
        const msgs = s.messages || [];
        memory.push({
          chatId: id,
          messages: msgs.length,
          updatedAt: s.updatedAt || 0,
          last: msgs.slice(-4).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 120) })),
        });
      }
    } catch {
      /* 坏文件就当没有 */
    }
  }

  const chats = readChats(rootDir);
  for (const c of Object.values(chats)) {
    if (c && typeof c === 'object') delete c.apiKey;
  }

  // 身份三要素的真值：优先「当前实时登录账号」，hook 不可达才回落 .env 静态值。
  // 必须在 attachContactNames 之前算出，否则 TDZ 引用 accountWxid 会令 buildState 抛错、/api/state 500。
  const liveAccount = await probeAccount(rootDir);
  const accountWxid = liveAccount?.wxid || cfg.wechat.selfId || '';
  const accountName = liveAccount?.nickname || cfg.wechat.selfName || accountWxid;
  const accountSource = liveAccount?.source || (cfg.wechat.selfId ? 'env' : 'unknown');
  await attachContactNames(rootDir, memory, chats, accountWxid);

  // 思考参数：按当前模型算好「这次到底会发什么字段」，界面直接显示
  const rx = explainReasoning({
    effort: cfg.ai.reasoningEffort,
    format: cfg.ai.reasoningFormat,
    budget: cfg.ai.reasoningBudget,
    model: cfg.ai.model,
    baseUrl: cfg.ai.baseUrl,
  });

  // 全局人设：界面要能展示「现在到底在用哪一份」，免得配了文件路径却读不到，
  // 助手悄悄退回内置默认人设而用户毫无察觉。
  const personaInfo = loadPersona(cfg, rootDir);
  const idVars = {
    account: accountName,
    persona: personaInfo.name,
    model: cfg.ai.model,
    baseUrl: cfg.ai.baseUrl,
  };
  // 界面要看到「底层人设始终在」：上层人设可以换，但这段永远追加在 system prompt 末尾
  const personaFence = buildBaseline(idVars);

  return {
    rootDir,
    account: { wxid: accountWxid, nickname: accountName, source: accountSource },
    running: pid ? await isRunningPid(pid) : false,
    pid,
    gate: sw.status(),
    installed: inst,
    autoStart: inst.autoStart,
    env: safeEnv(readEnvFile(rootDir + '/.env')),
    // 密钥类：界面要能直接看到「有没有、是什么」，所以这里回传已保存的真值（本机本账号，不外发）
    secrets: {
      aiApiKey: secretInfo(readEnvFile(rootDir + '/.env'), 'AI_API_KEY'),
      wxWebhookToken: secretInfo(readEnvFile(rootDir + '/.env'), 'WX_WEBHOOK_TOKEN'),
    },
    chats,
    memory,
    config: {
      ai: {
        enabled: cfg.ai.enabled,
        deprecatedMasterSwitch: cfg.ai.deprecatedMasterSwitch,
        baseUrl: cfg.ai.baseUrl,
        model: cfg.ai.model,
        personaFile: cfg.ai.personaFile,
        /** 人设名：没配就用文件名，再没有就是「AutoChat助手」 */
        personaName: personaInfo.name,
        /** 真正读到的人设文件路径（绝对路径 / 空表示没配或读不到） */
        personaFileResolved: personaInfo.file || '',
        /** file（人设文件）/ inline（内联文本）/ default（内置默认） */
        personaSource: personaInfo.source,
        /** 配了文件却读不到时标红提示 */
        personaMissing: Boolean(personaInfo.missing),
        /** 人设正文（占位符已换成真值，界面上看到的就是实际生效的内容） */
        personaText: fillVars(personaInfo.text, idVars).slice(0, 6000),
        /** 底层围栏：无论换什么人都设，这段都会追加在 system prompt 末尾 */
        personaFence,
        groupReply: cfg.ai.groupReply,
        contextTurns: cfg.ai.contextTurns,
        contextTtlMs: cfg.ai.contextTtlMs,
        contextMaxChars: cfg.ai.contextMaxChars,
        maxPerHour: cfg.ai.maxPerHour,
        cooldownMs: cfg.ai.cooldownMs,
        maxConcurrent: cfg.ai.maxConcurrent,
        triggerPrefix: cfg.ai.triggerPrefix,
        groupAtNames: cfg.ai.groupAtNames,
        privateRequirePrefix: cfg.ai.privateRequirePrefix,
        reasoningEffort: cfg.ai.reasoningEffort,
        reasoningFormat: cfg.ai.reasoningFormat,
        reasoningBudget: cfg.ai.reasoningBudget,
        // 这几个是「算好的解释」，界面直接显示（省得浏览器再实现一遍各家字段规则）
        reasoningResolvedFormat: rx.format,
        reasoningFormatLabel: rx.formatLabel,
        reasoningKind: rx.kind,
        reasoningPreview: rx.describe || '（不带任何思考参数）',
      },
      wechat: {
        selfId: cfg.wechat.selfId,
        selfMode: cfg.wechat.selfMode,
        pollExcludeSelf: cfg.wechat.pollExcludeSelf,
        receiveMode: cfg.wechat.receiveMode,
        pollChats: cfg.wechat.pollChats,
        dllPath: cfg.wechat.dllPath,
        installDir: cfg.wechat.installDir,
        installerPath: cfg.wechat.installerPath,
      },
    },
    wechatVersion: wechat ? wechat.version : null,
    wechatLogin: await probeLogin(rootDir),
    versionLocked: await isVersionLocked(),
    // 限流统计快照（replier 进程每 10s 落盘，见 R16 / GAP5）：三类独立跳过计数跨进程可见
    rateLimit: (() => {
      const f = cfg.dataDir + '/rate-limit-stats.json';
      try {
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
      } catch {
        return null;
      }
    })(),
    // 微信安装目录里实际加载的那份 version.dll（可能与配置的 DLL 不是同一份）
    deployedDll: inspectDeployedDll(
      (wechat && wechat.dir) || cfg.wechat.installDir,
      cfg.wechat.dllPath,
      builtin.path
    ),
    builtinDll: builtin,
  };
}

async function isRunningPid(pid) {
  const { isRunning } = await import('../core/win.js');
  return isRunning(pid);
}
