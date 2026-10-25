import { ROOT } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { readEnvFile } from '../core/env-file.js';
import { safeEnv } from '../tasks/config.js';
import { readChats } from '../core/chats.js';
import { PauseState, PidFile } from '../core/pause.js';
import { installStatus } from '../tasks/install.js';
import { detectWeChat } from '../bridge/process.js';
import { isVersionLocked } from '../tasks/lock.js';
import { HookClient } from '../bridge/hook-client.js';
import { ContactCache } from '../bridge/contacts.js';

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

/** 给会话附上汉字名（群名 / 昵称）。hook 不可达就留空，不影响主流程。 */
async function attachContactNames(rootDir, memory, chats) {
  const ids = [];
  for (const m of memory || []) if (m.chatId) ids.push(m.chatId);
  for (const id of Object.keys(chats || {})) ids.push(id);
  if (!ids.length) return;
  try {
    const { hook, contacts } = getHookContacts(rootDir);
    const st = await hook.ping().catch(() => ({ ok: false }));
    if (!st.ok) return;
    await contacts.lookup(ids);
    for (const m of memory || []) {
      const nm = contacts.nameOf(m.chatId);
      if (nm) m.name = nm;
    }
    for (const [id, c] of Object.entries(chats || {})) {
      const nm = contacts.nameOf(id);
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

  const memory = [];
  const memFile = cfg.dataDir + '/ai-memory.json';
  const fs = await import('node:fs');
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
  await attachContactNames(rootDir, memory, chats);

  return {
    rootDir,
    running: pid ? await isRunningPid(pid) : false,
    pid,
    gate: sw.status(),
    installed: inst,
    autoStart: inst.autoStart,
    env: safeEnv(readEnvFile(rootDir + '/.env')),
    chats,
    memory,
    config: {
      ai: {
        enabled: cfg.ai.enabled,
        deprecatedMasterSwitch: cfg.ai.deprecatedMasterSwitch,
        baseUrl: cfg.ai.baseUrl,
        model: cfg.ai.model,
        personaFile: cfg.ai.personaFile,
        groupReply: cfg.ai.groupReply,
        contextTurns: cfg.ai.contextTurns,
        contextTtlMs: cfg.ai.contextTtlMs,
        contextMaxChars: cfg.ai.contextMaxChars,
        maxPerHour: cfg.ai.maxPerHour,
        cooldownMs: cfg.ai.cooldownMs,
      },
      wechat: {
        selfId: cfg.wechat.selfId,
        selfMode: cfg.wechat.selfMode,
        receiveMode: cfg.wechat.receiveMode,
        pollChats: cfg.wechat.pollChats,
        dllPath: cfg.wechat.dllPath,
        installDir: cfg.wechat.installDir,
      },
    },
    wechatVersion: wechat ? wechat.version : null,
    versionLocked: await isVersionLocked(),
  };
}

async function isRunningPid(pid) {
  const { isRunning } = await import('../core/win.js');
  return isRunning(pid);
}
