import process from 'node:process';
import {
  checkGate,
  getHome,
  missingHomeHint,
  readPreflight,
  renderSteps,
  runCli,
  runJson,
} from './cli.js';

/**
 * AutoChat 插件的工具层（与传输无关）。
 *
 * 同一份实现有两个出口：
 *   · DSH 插件（index.js）：注册成原生工具 `autochat_*`
 *   · MCP 服务器（lib/mcp.js）：注册成 MCP 工具
 * 两边行为必须一致 —— 所以只写一遍。
 */

/** 回执外壳：一行机读元信息 + 后面跟人读正文。 */
function envelope(action, extra = {}) {
  const { home, source } = getHome();
  return '【' + action + '】 ' + JSON.stringify({ action, home, homeSource: source, ...extra });
}

/** 提示：交互式的事在终端里做（插件不替人拍板）。 */
const INTERACTIVE_HINT =
  '这一步要人现场选（选模型来源 / 填密钥 / 选会话），插件不代劳：' +
  '用图形化配置器（autochat_open_console）或在 AutoChat 目录里跑 npm run setup。';

/* ------------------------------------------------------------------ *
 * 工具清单
 * ------------------------------------------------------------------ */

export const TOOL_SPECS = [
  {
    name: 'autochat_preflight',
    description:
      '看 AutoChat 的根本性配置七步走到哪一步了：Node 环境 / 微信客户端 / 版本锁 / hook DLL / 模型 / 小号 / 服务。' +
      '只读，绝不改动任何东西。任何写操作前先调它——本插件的其它写操作会照着这里的结论拦截。',
    parameters: {},
  },
  {
    name: 'autochat_doctor',
    description:
      '深度体检（autochat doctor）：hook 端口、微信登录态、数据库表、模型连通性、小号隔离、崩溃计数。' +
      '比 preflight 细，用来回答「为什么它不理我」。只读。',
    parameters: {},
  },
  {
    name: 'autochat_status',
    description: '运行快照：服务是否在跑、pid、自动回复是否暂停、当前模型、监听会话、上下文会话数。只读。',
    parameters: {},
  },
  {
    name: 'autochat_service',
    description:
      '启停助手服务（后台方式）。start 前会先查根本性配置，有阻断项就拒绝（除非 acknowledge_blocking=true）。' +
      '配置类改动（.env / config.json）都要 restart 才生效。',
    parameters: {
      action: { type: 'string', required: true, description: 'start / stop / restart / status' },
      acknowledge_blocking: {
        type: 'boolean',
        description: '明知根本性配置有阻断项仍要启动（一般不要用，只用于先看日志）',
      },
    },
  },
  {
    name: 'autochat_reply_gate',
    description:
      '暂停 / 恢复自动回复（立刻生效，暂停期间仍收消息、仍记日志）。' +
      'resume 前会查根本性配置，坏着的话恢复也没意义。',
    parameters: {
      action: { type: 'string', required: true, description: 'pause / resume / status' },
      reason: { type: 'string', description: '暂停原因，写进暂停哨兵文件，便于之后回忆' },
      acknowledge_blocking: { type: 'boolean', description: '明知有阻断项仍要恢复' },
    },
  },
  {
    name: 'autochat_config',
    description:
      '读 / 写 .env（autochat config）。读回来的敏感键（AI_API_KEY、WX_WEBHOOK_TOKEN）只会是 true/false。' +
      '写必须 confirm=true；键必须在 AutoChat 的白名单里，否则如实报告「没写进去」而不是假装成功。',
    parameters: {
      action: { type: 'string', required: true, description: 'get / set / unset' },
      key: { type: 'string', description: '单个键，如 AI_MODEL' },
      value: { type: 'string', description: '配合 key 使用' },
      confirm: { type: 'boolean', description: '写操作必须为 true' },
    },
  },
  {
    name: 'autochat_chats',
    description:
      '按会话配置（autochat chats）：list / add / remove / enable / disable。' +
      'add 会自动把会话补进 WX_POLL_CHATS（否则那个会话一条消息都收不到），并提示需要重启才生效。',
    parameters: {
      action: { type: 'string', required: true, description: 'list / add / remove / enable / disable' },
      id: { type: 'string', description: '会话 id（群 id 或好友 wxid）' },
    },
  },
  {
    name: 'autochat_apply_step',
    description:
      '自动执行根本性配置里「不需要人拍板」的几步：lock-version（锁微信版本）、detect-dll（匹配内置 DLL 并写 WX_DLL_PATH）、' +
      'deploy-dll（写进微信安装目录，可能要管理员）、fix-dll（重新匹配 + 部署）。必须 confirm=true。' +
      '「接模型」这类要现场选的步骤会被拒绝并让你走向导。',
    parameters: {
      step: { type: 'string', required: true, description: 'lock-version / detect-dll / deploy-dll / fix-dll' },
      confirm: { type: 'boolean', required: true, description: '要动系统 / 微信目录，必须为 true' },
    },
  },
  {
    name: 'autochat_model',
    description:
      '模型相关：test（用当前 .env 配置真发一次请求）/ list（列服务端模型）/ service-status / service-start / service-stop（本机 Ollama 之类的本地模型服务）。',
    parameters: {
      action: { type: 'string', required: true, description: 'test / list / service-status / service-start / service-stop' },
    },
  },
  {
    name: 'autochat_logs',
    description: '看后台服务日志尾部（data/autochat.out / autochat.err）。排查「不理人」的第一现场。',
    parameters: {
      lines: { type: 'number', description: '行数，默认 200，最大 2000' },
      err: { type: 'boolean', description: '看错误日志而不是标准输出' },
    },
  },
  {
    name: 'autochat_version',
    description: 'AutoChat 与运行环境版本（判断插件和主体是不是同一份、Node 够不够）。',
    parameters: {},
  },
  {
    name: 'autochat_open_console',
    description: '打开图形化配置器（浏览器界面）。凡是需要人点着配的东西都在那里；插件只负责拉起，不代点。',
    parameters: {},
  },
];

/* ------------------------------------------------------------------ *
 * 实现
 * ------------------------------------------------------------------ */

async function toolPreflight() {
  const pre = await readPreflight();
  if (!pre.steps.length) {
    return (
      envelope('preflight', { ok: false, error: '读不到初始化步骤，先看 CLI 能不能跑' }) +
      '\n\n' +
      pre.raw
    );
  }
  return (
    envelope('preflight', { summary: pre.summary }) +
    '\n\n' +
    renderSteps(pre.steps, pre.summary) +
    '\n\n' +
    (pre.summary.bad
      ? '这些阻断项在启动服务 / 恢复回复 / 部署 DLL 时会被拦住；不要跳过。'
      : '没有阻断项。下一步一般就是 autochat_service，action 传 start。') +
    '\n\n原始数据：\n' +
    JSON.stringify({ steps: pre.steps, summary: pre.summary }, null, 2)
  );
}

async function toolDoctor() {
  const r = await runJson(['doctor', '--json'], { timeoutMs: 60000 });
  const items = (r.data && r.data.items) || [];
  if (!items.length) {
    return envelope('doctor', { ok: false, error: '体检没有返回结果' }) + '\n\n' + (r.out.trim() || r.err.trim());
  }
  const lines = items.map((it) => {
    const head = `${it.level === 'ok' ? '✓' : it.level === 'warn' ? '!' : '✗'} ${it.name}：${it.detail || ''}`;
    return it.next ? `${head}\n   → ${it.next}` : head;
  });
  const bad = items.filter((i) => i.level === 'bad');
  return (
    envelope('doctor', { ok: bad.length === 0, blocking: bad.length, warn: items.filter((i) => i.level === 'warn').length }) +
    '\n\n' +
    lines.join('\n') +
    '\n\n原始数据：\n' +
    JSON.stringify(r.data, null, 2)
  );
}

async function toolStatus() {
  const r = await runJson(['status', '--json'], { timeoutMs: 30000 });
  if (!r.data) {
    return envelope('status', { ok: false, error: '读不到状态' }) + '\n\n' + (r.out.trim() || r.err.trim());
  }
  return envelope('status', { ok: true }) + '\n\n' + JSON.stringify(r.data, null, 2);
}

async function toolVersion() {
  const r = await runJson(['version', '--json'], { timeoutMs: 20000 });
  return (
    envelope('version', { ok: Boolean(r.data) }) +
    '\n\n' +
    (r.data ? JSON.stringify(r.data, null, 2) : r.out.trim() || r.err.trim())
  );
}

async function toolService(args) {
  const action = String(args.action || 'status').toLowerCase();

  if (action === 'status') return toolStatus();

  if (action === 'start') {
    const pre = await readPreflight();
    const gate = checkGate(pre, 'service.start');
    if (gate.blocked.length && !args.acknowledge_blocking) {
      return (
        envelope('service.start', { ok: false, blocked: true }) +
        '\n\n有阻断项没解决，先解决再启动（这不是插件的额外要求，是 autochat setup 的门槛）：\n' +
        gate.blocked.map((s) => `✗ ${s.title}：${s.detail}\n   → ${s.next || ''}`).join('\n') +
        '\n\n' +
        renderSteps(pre.steps, pre.summary) +
        '\n\n确实要无视这些先跑起来（例如只是想看看日志）：把 acknowledge_blocking 设为 true。'
      );
    }
    const r = await runCli(['start', '--background'], { timeoutMs: 90000 });
    const st = await runJson(['status', '--json'], { timeoutMs: 30000 });
    const running = Boolean(st.data && st.data.running);
    return (
      envelope('service.start', { ok: running, running, warned: gate.warned.map((s) => s.title) }) +
      '\n\n' +
      (r.out.trim() || '(无输出)') +
      (r.err.trim() ? '\n\nstderr:\n' + r.err.trim() : '') +
      '\n\n当前状态：\n' +
      JSON.stringify(st.data || null, null, 2) +
      (running ? '' : '\n\n没起来的话看日志：autochat_logs，lines 传 200，err 传 true')
    );
  }

  if (action === 'stop') {
    const r = await runJson(['stop', '--json'], { timeoutMs: 60000 });
    return envelope('service.stop', { ok: Boolean(r.data && r.data.ok) }) + '\n\n' + JSON.stringify(r.data || r.out.trim(), null, 2);
  }

  if (action === 'restart') {
    const stop = await runJson(['stop', '--json'], { timeoutMs: 60000 });
    const st = await toolService({ action: 'start', acknowledge_blocking: args.acknowledge_blocking });
    return envelope('service.restart', { stopped: Boolean(stop.data && stop.data.ok) }) + '\n\n' + st;
  }

  return envelope('service', { ok: false, error: '未知 action：' + action }) + '\n\n可用：start / stop / restart / status';
}

async function toolReplyGate(args) {
  const action = String(args.action || 'status').toLowerCase();
  const reason = String(args.reason || 'DSH 插件暂停').slice(0, 200);

  const st = await runJson(['status', '--json'], { timeoutMs: 30000 });
  const paused = Boolean(st.data && st.data.paused);

  if (action === 'status') {
    return (
      envelope('gate.status', { paused, autoReply: st.data && st.data.autoReply }) +
      '\n\n' +
      JSON.stringify(st.data || null, null, 2)
    );
  }

  if (action === 'pause') {
    const r = await runJson(['pause', reason, '--json'], { timeoutMs: 20000 });
    return envelope('gate.pause', { ok: Boolean(r.data && r.data.ok) }) + '\n\n' + JSON.stringify(r.data || r.out.trim(), null, 2);
  }

  if (action === 'resume') {
    const pre = await readPreflight();
    const gate = checkGate(pre, 'gate.resume');
    if (gate.blocked.length && !args.acknowledge_blocking) {
      return (
        envelope('gate.resume', { ok: false, blocked: true }) +
        '\n\n恢复前这些还是坏的，恢复后也不会回消息：\n' +
        gate.blocked.map((s) => `✗ ${s.title}：${s.detail}`).join('\n')
      );
    }
    const r = await runJson(['resume', '--json'], { timeoutMs: 20000 });
    return envelope('gate.resume', { ok: Boolean(r.data && r.data.ok) }) + '\n\n' + JSON.stringify(r.data || r.out.trim(), null, 2);
  }

  return envelope('gate', { ok: false, error: '未知 action：' + action }) + '\n\n可用：pause / resume / status';
}

/** 读回 .env（敏感键在 CLI 侧已被脱敏成 boolean）。 */
async function readEnv() {
  const r = await runJson(['config', 'get', '--json'], { timeoutMs: 20000 });
  return r.data || {};
}

async function toolConfig(args) {
  const action = String(args.action || 'get').toLowerCase();

  if (action === 'get') {
    const env = await readEnv();
    if (!Object.keys(env).length) {
      return (
        envelope('config.get', { ok: false, error: '.env 还没有任何可读配置' }) +
        '\n\n跑一次 npm run setup（初始化向导）生成 .env。'
      );
    }
    const key = args.key ? String(args.key) : '';
    return (
      envelope('config.get', { ok: true, note: '值为 true/false 的是敏感键，只回传「是否已配置」' }) +
      '\n\n' +
      JSON.stringify(key ? { [key]: env[key] } : env, null, 2)
    );
  }

  if (action === 'set' || action === 'unset') {
    if (!args.confirm) {
      return (
        envelope('config.' + action, { ok: false, error: '写 .env 需要显式确认' }) +
        '\n\n改配置会影响正在跑的助手：请把 confirm 设为 true 再来一次。' +
        '\n形状：{"action":"set","key":"AI_MODEL","value":"qwen2.5:7b","confirm":true}'
      );
    }

    const entries = {};
    if (args.key) entries[String(args.key)] = action === 'unset' ? '' : args.value == null ? '' : String(args.value);
    if (!args.key) {
      return envelope('config.' + action, { ok: false, error: '缺少 key' }) + '\n\n一次改一个键，便于确认与回滚。';
    }
    const pairs = Object.entries(entries);
    for (const [k] of pairs) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) {
        return envelope('config.set', { ok: false, error: '键名不合法：' + k }) + '\n\n键名要用 .env 里的写法，例如 AI_MODEL。';
      }
    }

    const cliArgs = ['config', 'set'];
    for (const [k, v] of pairs) cliArgs.push(`${k}=${v}`);

    const before = await readEnv();
    const r = await runCli(cliArgs, { timeoutMs: 20000 });
    const after = await readEnv();

    // 白名单外的键会被 tasks/config.js 静默丢弃 —— 通过「前后对比」如实报告，
    // 而不是假装写成功了。
    const applied = [];
    const ignored = [];
    for (const [k, v] of pairs) {
      const now = after[k];
      const hit = now === true || String(now) === String(v);
      const changed = JSON.stringify(before[k]) !== JSON.stringify(after[k]);
      if (hit || changed) applied.push(k);
      else ignored.push(k);
    }

    return (
      envelope('config.' + action, { ok: ignored.length === 0, applied, ignored }) +
      '\n\n' +
      (r.out.trim() || '(无输出)') +
      (ignored.length
        ? '\n\n注意：这些键没被写进去（不在可改白名单里，或值被 CLI 判定为无效）：' + ignored.join('、')
        : '') +
      '\n\n配置类改动要重启助手服务才生效：autochat_service，action 传 restart'
    );
  }

  return envelope('config', { ok: false, error: '未知 action：' + action }) + '\n\n可用：get / set / unset';
}

async function toolChats(args) {
  const action = String(args.action || 'list').toLowerCase();
  const id = args.id ? String(args.id).trim() : '';

  if (action === 'list') {
    const r = await runJson(['chats', 'list', '--json'], { timeoutMs: 20000 });
    const chats = r.data || {};
    const keys = Object.keys(chats);
    return (
      envelope('chats.list', { ok: true, count: keys.length }) +
      '\n\n' +
      (keys.length
        ? keys.map((k) => `· ${k}：${chats[k] && chats[k].enabled === false ? '已停用' : '参与回复'}`).join('\n')
        : '（空）还没有为任何群 / 好友单独配置') +
      '\n\n原始数据：\n' +
      JSON.stringify(chats, null, 2)
    );
  }

  if (!id) return envelope('chats.' + action, { ok: false, error: '缺少会话 id（群 id 或 wxid）' });

  if (action === 'add') {
    const r = await runCli(['chats', 'add', id], { timeoutMs: 20000 });
    // 与图形化配置器同样的并集同步：加进 config.json 还不够，
    // WX_POLL_CHATS 里没有它就一条消息都收不到。
    const env = await readEnv();
    const cur = String(env.WX_POLL_CHATS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let synced = false;
    if (!cur.includes(id)) {
      cur.push(id);
      await runCli(['config', 'set', 'WX_POLL_CHATS=' + cur.join(',')], { timeoutMs: 20000 });
      const after = await readEnv();
      synced = String(after.WX_POLL_CHATS || '')
        .split(',')
        .map((s) => s.trim())
        .includes(id);
    }
    return (
      envelope('chats.add', { ok: true, id, pollChatsSynced: synced }) +
      '\n\n' +
      (r.out.trim() || '(无输出)') +
      '\n\nWX_POLL_CHATS = ' +
      cur.join(',') +
      (synced ? '（已自动补上这个会话）' : '（本来就在里面 / 没写进去）') +
      '\n\n改了监听会话要重启服务才生效：autochat_service，action 传 restart'
    );
  }

  if (action === 'remove' || action === 'rm') {
    const r = await runCli(['chats', 'rm', id], { timeoutMs: 20000 });
    return envelope('chats.remove', { ok: true, id }) + '\n\n' + (r.out.trim() || '(无输出)');
  }

  if (action === 'enable' || action === 'disable') {
    const r = await runCli(['chats', action, id], { timeoutMs: 20000 });
    return envelope('chats.' + action, { ok: true, id }) + '\n\n' + (r.out.trim() || '(无输出)');
  }

  return envelope('chats', { ok: false, error: '未知 action：' + action }) + '\n\n可用：list / add / remove / enable / disable';
}

/** 根本性配置里「能自动化、且不替人拍板」的那几步。 */
const STEP_COMMANDS = {
  'lock-version': { args: ['lock', '--json'], what: '锁定微信版本（阻断自动更新）', timeoutMs: 60000 },
  'detect-dll': {
    args: ['autodll', '--json', '--write'],
    what: '按微信版本匹配内置 hook DLL 并写入 WX_DLL_PATH',
    timeoutMs: 45000,
  },
  'deploy-dll': { args: ['install', '--deploy-dll', '--json'], what: '把配置的 hook DLL 写进微信安装目录', timeoutMs: 180000 },
};

async function toolApplyStep(args) {
  const step = String(args.step || '').toLowerCase();
  const known = Object.keys(STEP_COMMANDS).concat(['fix-dll']);
  if (!known.includes(step)) {
    return (
      envelope('apply_step', { ok: false, error: '未知 step：' + step, known }) +
      '\n\n可用：' +
      known.join(' / ') +
      '\n\n「接一个模型」「加入监听会话」这类要人现场选的步骤请走向导：' +
      INTERACTIVE_HINT
    );
  }

  if (!args.confirm) {
    return (
      envelope('apply_step', { ok: false, error: '要动微信目录 / 系统设置，需要显式确认' }) +
      '\n\n把 confirm 设为 true 再来一次。' +
      '\n注意 deploy-dll 会写微信安装目录（可能需要管理员权限），且要重启微信才生效。'
    );
  }

  // fix-dll：先按版本重新匹配，再部署（对应向导卡的「改用匹配的 DLL」）
  if (step === 'fix-dll') {
    const pre = await readPreflight();
    const gate = checkGate(pre, 'step.fix-dll');
    if (gate.blocked.length) {
      return (
        envelope('apply_step.fix-dll', { ok: false, blocked: true }) +
        '\n\n' +
        gate.blocked.map((s) => `✗ ${s.title}：${s.detail}`).join('\n')
      );
    }
    const a = await runJson(['autodll', '--json', '--write'], { timeoutMs: 45000 });
    const b = await runJson(['install', '--deploy-dll', '--json'], { timeoutMs: 180000 });
    const after = await readPreflight();
    return (
      envelope('apply_step.fix-dll', { ok: Boolean(b.data && b.data.ok), detect: a.data, deploy: b.data }) +
      '\n\n' +
      renderSteps(after.steps, after.summary) +
      '\n\n部署后必须重启微信：hook DLL 只在微信启动时加载。'
    );
  }

  const cmd = STEP_COMMANDS[step];
  const pre = await readPreflight();
  const gate = checkGate(pre, 'step.' + step);
  if (gate.blocked.length) {
    return (
      envelope('apply_step.' + step, { ok: false, blocked: true }) +
      '\n\n' +
      gate.blocked.map((s) => `✗ ${s.title}：${s.detail}\n   → ${s.next || ''}`).join('\n')
    );
  }

  const r = await runJson(cmd.args, { timeoutMs: cmd.timeoutMs });
  const after = await readPreflight();
  return (
    envelope('apply_step.' + step, { ok: !(r.data && r.data.ok === false), what: cmd.what, result: r.data }) +
    '\n\n' +
    (r.out.trim() || r.err.trim() || '(无输出)') +
    '\n\n现在的七步：\n' +
    renderSteps(after.steps, after.summary) +
    (step === 'deploy-dll' ? '\n\n部署完记得重启微信（hook DLL 只在启动时加载）。' : '')
  );
}

async function toolModel(args) {
  const action = String(args.action || 'test').toLowerCase();

  if (action === 'test') {
    const r = await runJson(['model', 'test', '--json'], { timeoutMs: 90000 });
    const d = r.data || {};
    return (
      envelope('model.test', { ok: Boolean(d.ok), model: d.model, ms: d.ms }) +
      '\n\n' +
      (d.ok ? String(d.reply || '') : d.title ? `${d.title}：${d.detail || ''}` : JSON.stringify(d, null, 2)) +
      '\n\n原始数据：\n' +
      JSON.stringify(d, null, 2)
    );
  }

  if (action === 'list') {
    const r = await runJson(['model', 'list', '--json'], { timeoutMs: 45000 });
    return envelope('model.list', { ok: Boolean(r.data && r.data.ok) }) + '\n\n' + JSON.stringify(r.data, null, 2);
  }

  if (action === 'service-status') {
    const r = await runJson(['model', 'service', 'status', '--json'], { timeoutMs: 45000 });
    return envelope('model.service', { ok: true }) + '\n\n' + JSON.stringify(r.data, null, 2);
  }

  if (action === 'service-start' || action === 'service-stop') {
    const sub = action === 'service-start' ? 'start' : 'stop';
    const r = await runCli(['model', 'service', sub], { timeoutMs: 180000 });
    return (
      envelope('model.service.' + sub, { ok: r.code === 0 }) +
      '\n\n' +
      (r.out.trim() || '(无输出)') +
      (r.err.trim() ? '\n\nstderr:\n' + r.err.trim() : '')
    );
  }

  return envelope('model', { ok: false, error: '未知 action：' + action }) + '\n\n可用：test / list / service-status / service-start / service-stop';
}

async function toolLogs(args) {
  const lines = Math.max(1, Math.min(2000, Number(args.lines) || 200));
  const cliArgs = ['logs', '--json', '--lines', String(lines)];
  if (args.err) cliArgs.push('--err');
  const r = await runJson(cliArgs, { timeoutMs: 20000 });
  const d = r.data || {};
  return (
    envelope('logs', { ok: true, file: d.file, exists: d.exists, truncated: d.truncated }) +
    '\n\n' +
    (Array.isArray(d.lines) && d.lines.length
      ? d.lines.join('\n')
      : '(没有日志：把服务用后台方式启动才有 data/autochat.out)')
  );
}

/**
 * 打开图形化配置器。
 *
 * 它是需要人点的一套界面（在浏览器窗口里），所以这里只负责把它拉起来，
 * 不试图把界面塞进对话框。令牌 URL 由它自己打开，插件不接触。
 */
async function toolOpenConsole() {
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const { home } = getHome();
  if (!home) {
    return envelope('console', { ok: false, error: '没找到 AutoChat 安装目录' }) + '\n\n' + missingHomeHint();
  }
  const existing = await runJson(['status', '--json'], { timeoutMs: 20000 });
  const child = spawn(process.execPath, [path.join(home, 'src', 'cli', 'index.js'), 'gui'], {
    cwd: home,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return (
    envelope('console', { ok: true, pid: child.pid, serviceRunning: Boolean(existing.data && existing.data.running) }) +
    '\n\n已拉起图形化配置器（默认 http://127.0.0.1:8788，令牌链接由它自己打开）。' +
    '\n关掉它不会停掉正在跑的助手服务。' +
    '\n端口被占时会自动复用已运行的那个，不会起第二个。'
  );
}

const HANDLERS = {
  autochat_preflight: () => toolPreflight(),
  autochat_doctor: () => toolDoctor(),
  autochat_status: () => toolStatus(),
  autochat_service: (a) => toolService(a),
  autochat_reply_gate: (a) => toolReplyGate(a),
  autochat_config: (a) => toolConfig(a),
  autochat_chats: (a) => toolChats(a),
  autochat_apply_step: (a) => toolApplyStep(a),
  autochat_model: (a) => toolModel(a),
  autochat_logs: (a) => toolLogs(a),
  autochat_version: () => toolVersion(),
  autochat_open_console: () => toolOpenConsole(),
};

/**
 * 执行一个工具，返回给模型看的文本。
 * @param {string} name 工具名
 * @param {object} args 参数
 * @returns {Promise<string>}
 */
export async function runTool(name, args = {}) {
  const fn = HANDLERS[name];
  if (!fn) throw new Error('未知工具：' + name);
  try {
    return await fn(args || {});
  } catch (err) {
    return (
      envelope(name, { ok: false, error: '执行失败' }) +
      '\n\n' +
      (err && err.stack ? err.stack : String(err)) +
      '\n\n如果 AutoChat 目录不对，先用 autochat_version 看一眼当前操作的路径。'
    );
  }
}

/**
 * 从回执文本里解析出机读元信息（第一行的 JSON）。
 * MCP 传输层用它判断「这次调用是不是被拒绝了」。
 * @param {string} text
 * @returns {{action?: string, ok?: boolean, [k: string]: any}|null}
 */
export function parseEnvelope(text) {
  const m = /^【[^】]+】\s*(\{.*\})\s*$/m.exec(String(text || ''));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** 供外部（MCP 服务器）复用的工具名列表。 */
export function toolNames() {
  return TOOL_SPECS.map((t) => t.name);
}
