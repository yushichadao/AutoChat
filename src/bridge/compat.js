import fs from 'node:fs';
import path from 'node:path';
import { describeSupport, resolveProfile } from './profiles.js';

/**
 * 把「微信版本」「DLL 实际能力」「用户配置」三者对齐，
 * 自动改掉跑不通的组合，并给出人类可读的结论。
 */
export function advise({ version, probe, cfg }) {
  const support = describeSupport(version);
  const notes = [];
  const warnings = [];
  const changes = {};

  if (!version) {
    warnings.push('读不到微信版本，跳过兼容性判断（可以用 WX_FORCE_VERSION 手动指定）');
  } else if (!support.ok) {
    warnings.push(support.text);
  } else if (support.warn) {
    warnings.push(support.text);
  } else {
    notes.push(support.text);
  }

  if (probe && probe.reachable) {
    if (probe.canSend === false) {
      warnings.push('探测不到发送接口（/SendTextMsg），无法回消息；确认 DLL 版本与微信版本一致');
    } else if (probe.canSend === true) {
      notes.push('发送接口可用');
    }

    if (cfg.receiveMode === 'webhook' && !probe.canReceivePush) {
      changes.receiveMode = 'poll';
      warnings.push('这个 DLL 没有回调能力，接收自动切到轮询（需要 WX_POLL_SQL）');
    }
    if (cfg.receiveMode !== 'webhook' && !probe.canQueryDb) {
      changes.receiveMode = 'webhook';
      warnings.push('这个 DLL 不支持 /QueryDB/execute，接收自动切到 webhook');
    }
    if (!probe.canSend && !probe.canReceivePush && !probe.canQueryDb) {
      warnings.push('DLL 只有部分接口可用，可能版本偏移已失效');
    }
  }

  // 轮询能不能拿到消息：手写 SQL 或按会话自动生成，两者有其一即可
  const hasPollSource = Boolean(cfg.pollSql) || (Array.isArray(cfg.pollChats) && cfg.pollChats.length > 0);
  if (!hasPollSource && (changes.receiveMode || cfg.receiveMode) !== 'webhook') {
    warnings.push(
      '没有配置 WX_POLL_SQL 也没有填 WX_POLL_CHATS，轮询拿不到消息；' +
        '只靠 DLL 回调的话收不到不支持回调的 DLL 的消息'
    );
  }

  return { support, notes, warnings, changes, profile: resolveProfile(version).profile };
}

/** 记录上次成功运行的微信版本，版本一变就提醒「偏移可能失效」。 */
export function trackVersion(dataDir, version) {
  const file = path.join(dataDir, 'state.json');
  let prev = null;
  try {
    if (fs.existsSync(file)) prev = JSON.parse(fs.readFileSync(file, 'utf8')).lastWeChatVersion || null;
  } catch {
    prev = null;
  }

  const changed = Boolean(prev && version && prev !== version);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ lastWeChatVersion: version || prev, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* 写不进去不影响主流程 */
  }
  return { prev, changed };
}
