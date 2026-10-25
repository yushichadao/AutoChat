#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROOT, loadConfig } from '../config.js';
import { MasterSwitch, PidFile } from '../bridge/switch.js';
import { readEnvFile, setEnvValues } from './env-file.js';
import { diagnose } from '../setup/diagnose.js';
import { listModels, testChat, discoverLocal, explainError } from '../ai/probe.js';
import { groupedProviders } from '../ai/providers.js';
import { install, uninstall, checkEnvironment } from '../setup/installer.js';
import { isRunning, killProcess } from '../setup/win.js';
import { HookClient } from '../bridge/hook-client.js';
import { createLogger } from '../logger.js';

/**
 * 命令行入口。
 *
 * 设计原则：**每件事都能用命令行做完**，图形化配置器只是同一套逻辑的另一种皮。
 * 总闸相关命令（pause / resume / stop）放在最显眼的位置 ——
 * 自动化最怕的是停不下来，所以「怎么停下来」必须好找。
 */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const args = process.argv.slice(2);
const cmd = (args[0] || '').toLowerCase();
const rest = args.slice(1);
const flag = (name) => rest.includes(`--${name}`);
const opt = (name, def = '') => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : def;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--'));

const envFile = path.join(ROOT, '.env');
const jsonFile = path.join(ROOT, 'config.json');
const dataDir = loadConfig({ rootDir: ROOT }).dataDir;

function line(level, name, detail) {
  const icon = level === 'ok' ? '\u2713' : level === 'warn' ? '!' : '\u2717';
  const color = level === 'ok' ? C.green : level === 'warn' ? C.yellow : C.red;
  console.log(`  ${color}${icon}${C.reset} ${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`);
}

function section(title) {
  console.log(`\n${C.bold}${title}${C.reset}`);
}

/** 哨兵文件里记的是两行：时间 + 原因。取原因那行给人看。 */
function gateReason(reason) {
  const lines = String(reason || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const why = lines.find((l) => l.startsWith('reason:'));
  const when = lines.find((l) => l.startsWith('paused at'));
  const parts = [];
  if (why) parts.push(why.slice('reason:'.length).trim());
  if (when) parts.push(`(${when.slice('paused at'.length).trim()})`);
  return parts.join(' ');
}

function readMemoryCount() {
  try {
    const file = path.join(dataDir, 'ai-memory.json');
    if (!fs.existsSync(file)) return 0;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bag = raw.sessions || raw;
    return Object.keys(bag).filter((k) => k !== '__v').length;
  } catch {
    return 0;
  }
}

async function cmdStatus() {
  const cfg = loadConfig({ rootDir: ROOT });
  const sw = new MasterSwitch({ file: path.join(cfg.dataDir, 'paused') });
  const pid = new PidFile({ file: path.join(cfg.dataDir, 'autochat.pid') }).read();
  const running = pid ? await isRunning(pid) : false;
  const gate = sw.status();

  section('\u670d\u52a1');
  line(
    running ? 'ok' : 'warn',
    running ? `\u8fd0\u884c\u4e2d\uff08pid ${pid}\uff09` : '\u6ca1\u6709\u5728\u8fd0\u884c',
    running ? '' : '\u7528 autochat start \u542f\u52a8'
  );
  line(
    gate.paused ? 'warn' : 'ok',
    gate.paused ? '\u603b\u95f8\uff1a\u5df2\u6682\u505c' : '\u603b\u95f8\uff1a\u6253\u5f00',
    gate.paused ? gateReason(gate.reason) : ''
  );

  section('\u914d\u7f6e');
  line('ok', '\u6a21\u578b', `${cfg.ai.model} @ ${cfg.ai.baseUrl || '(\u672a\u914d\u7f6e)'}`);
  line(cfg.ai.enabled ? 'ok' : 'warn', 'AI', cfg.ai.enabled ? '\u5df2\u542f\u7528' : '\u672a\u542f\u7528\uff08AI_ENABLED=0\uff09');
  line(cfg.wechat.selfMode === 'id' ? 'warn' : 'ok', '\u81ea\u6d88\u606f\u5224\u5b9a', cfg.wechat.selfMode);
  line('ok', '\u76d1\u542c\u4f1a\u8bdd', cfg.wechat.pollChats.join(', ') || '(\u672a\u914d\u7f6e)');
  line('ok', '\u6309\u4f1a\u8bdd\u914d\u7f6e', Object.keys(cfg.chats).join(', ') || '(\u65e0)');
  line(
    'ok',
    '\u4e0a\u4e0b\u6587',
    `${cfg.ai.contextTurns} \u8f6e / ${cfg.ai.contextMaxChars} \u5b57\u7b26\u9884\u7b97 / TTL ${Math.round(cfg.ai.contextTtlMs / 60000)} \u5206\u949f`
  );
  line('ok', '\u5df2\u5b58\u4f1a\u8bdd\u6570', String(readMemoryCount()));
}

async function cmdDoctor() {
  section('\u73af\u5883\u4f53\u68c0');
  const { items } = await diagnose({ rootDir: ROOT });
  for (const it of items) line(it.level, it.name, it.detail);
  section('\u63d0\u793a');
  console.log(
    '  \u673a\u5668\u4eba\u4e0d\u7406\u4eba\uff0c\u591a\u534a\u662f\u8fd9\u4e09\u4ef6\u4e8b\u4e4b\u4e00\uff1a\u2460 AI \u6ca1\u542f\u7528 \u2461 \u603b\u95f8\u88ab\u62c9\u4e0b \u2462 \u7fa4\u91cc\u53ea\u6709\u4f60\u81ea\u5df1\u5728\u8bf4\u8bdd\uff08\u8be5\u7528\u53cc\u8d26\u53f7\u65b9\u6848\uff09'
  );
}

function cmdPause() {
  const sw = new MasterSwitch({ file: path.join(dataDir, 'paused') });
  const reason = positional.join(' ') || '\u547d\u4ee4\u884c\u6682\u505c';
  const r = sw.pause(reason);
  console.log(
    r.ok
      ? `${C.green}\u5df2\u6682\u505c\u81ea\u52a8\u56de\u590d${C.reset} ${C.dim}\uff08\u539f\u56e0\uff1a${reason}\uff09${C.reset}`
      : `${C.red}${r.message}${C.reset}`
  );
  console.log(`${C.dim}\u6062\u590d\uff1aautochat resume${C.reset}`);
}

function cmdResume() {
  const sw = new MasterSwitch({ file: path.join(dataDir, 'paused') });
  const r = sw.resume();
  console.log(r.ok ? `${C.green}\u5df2\u6062\u590d\u81ea\u52a8\u56de\u590d${C.reset}` : `${C.red}${r.message}${C.reset}`);
}

async function cmdStop() {
  const pidFile = new PidFile({ file: path.join(dataDir, 'autochat.pid') });
  const pid = pidFile.read();
  if (!pid || !(await isRunning(pid))) {
    console.log(`${C.yellow}\u6ca1\u6709\u5728\u8fd0\u884c\u7684\u5b9e\u4f8b${C.reset}`);
    pidFile.clear();
    return;
  }
  const r = await killProcess(pid);
  if (r.ok) pidFile.clear();
  console.log(
    r.ok ? `${C.green}\u5df2\u505c\u6b62\uff08pid ${pid}\uff09${C.reset}` : `${C.red}\u505c\u6b62\u5931\u8d25\uff1a${r.message}${C.reset}`
  );
}

function readChats() {
  if (!fs.existsSync(jsonFile)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    return raw.chats || {};
  } catch {
    return {};
  }
}

function writeChats(chats) {
  let raw = {};
  if (fs.existsSync(jsonFile)) {
    try {
      raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    } catch {
      raw = {};
    }
  }
  raw.chats = chats;
  fs.writeFileSync(jsonFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

function cmdChats() {
  const sub = (positional[0] || 'list').toLowerCase();
  const chats = readChats();
  if (sub === 'list') {
    section(`\u6309\u4f1a\u8bdd\u914d\u7f6e\uff08${Object.keys(chats).length}\uff09`);
    for (const [id, c] of Object.entries(chats)) {
      line(c?.enabled === false ? 'warn' : 'ok', id, `\u7fa4\u7b56\u7565 ${c?.groupReply || '(\u7ee7\u627f\u5168\u5c40)'}`);
    }
    if (!Object.keys(chats).length) console.log('  \uff08\u7a7a\uff09');
    return;
  }
  const id = positional[1];
  if (!id) {
    console.log(`${C.yellow}\u7528\u6cd5\uff1aautochat chats add|rm|enable|disable <\u4f1a\u8bddid>${C.reset}`);
    return;
  }
  if (sub === 'add') {
    chats[id] = { enabled: true, ...(chats[id] || {}) };
    writeChats(chats);
    console.log(`${C.green}\u5df2\u52a0\u5165 ${id}${C.reset}`);
  } else if (sub === 'rm') {
    delete chats[id];
    writeChats(chats);
    console.log(`${C.green}\u5df2\u79fb\u9664 ${id}${C.reset}`);
  } else if (sub === 'enable' || sub === 'disable') {
    chats[id] = { ...(chats[id] || {}), enabled: sub === 'enable' };
    writeChats(chats);
    console.log(`${C.green}${sub === 'enable' ? '\u5df2\u542f\u7528' : '\u5df2\u505c\u7528'} ${id}${C.reset}`);
  }
  console.log(`${C.dim}\u8bb0\u5f97\u540c\u65f6\u628a ${id} \u52a0\u8fdb .env \u7684 WX_POLL_CHATS \u624d\u80fd\u6536\u5230\u5b83\u7684\u6d88\u606f${C.reset}`);
}

function cmdContext() {
  const file = path.join(dataDir, 'ai-memory.json');
  if (!fs.existsSync(file)) {
    console.log('\u8fd8\u6ca1\u6709\u4e0a\u4e0b\u6587\u8bb0\u5f55');
    return;
  }
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.log('\u4e0a\u4e0b\u6587\u6587\u4ef6\u635f\u574f');
    return;
  }
  const bag = raw.sessions || raw;
  const chatId = positional[0];
  if (flag('clear')) {
    if (chatId) {
      delete bag[chatId];
      fs.writeFileSync(file, JSON.stringify({ __v: 1, sessions: bag }, null, 2));
      console.log(`${C.green}\u5df2\u6e05\u7a7a ${chatId} \u7684\u4e0a\u4e0b\u6587${C.reset}`);
    } else {
      fs.writeFileSync(file, JSON.stringify({ __v: 1, sessions: {} }, null, 2));
      console.log(`${C.green}\u5df2\u6e05\u7a7a\u5168\u90e8\u4e0a\u4e0b\u6587${C.reset}`);
    }
    return;
  }
  section('\u4e0a\u4e0b\u6587\u4f1a\u8bdd');
  for (const [id, s] of Object.entries(bag)) {
    if (id === '__v') continue;
    if (chatId && id !== chatId) continue;
    const msgs = s.messages || [];
    console.log(`\n${C.cyan}${id}${C.reset} ${C.dim}${msgs.length} \u6761 \u00b7 ${new Date(s.updatedAt || 0).toLocaleString()}${C.reset}`);
    for (const m of msgs.slice(-10)) {
      console.log(`  ${m.role === 'user' ? '\u203a' : '\u2039'} ${String(m.content).slice(0, 100)}`);
    }
  }
}

/** 测试当前配置的模型能不能用 —— 只说人话。 */
async function cmdTest() {
  const cfg = loadConfig({ rootDir: ROOT });
  section('测试模型连接');
  line('ok', '接口地址', cfg.ai.baseUrl || '(没填，先跑 autochat setup)');
  line('ok', '模型名', cfg.ai.model || '(没填)');
  line(cfg.ai.apiKey ? 'ok' : 'warn', '密钥', cfg.ai.apiKey ? '已配置' : '未配置（本地模型一般不用）');
  console.log(`  ${C.dim}正在测试，请稍等…${C.reset}`);
  const r = await testChat({
    baseUrl: cfg.ai.baseUrl,
    apiKey: cfg.ai.apiKey,
    model: cfg.ai.model,
    timeoutMs: cfg.ai.timeoutMs,
  });
  console.log('');
  if (r.ok) {
    line('ok', `成功！耗时 ${r.ms} 毫秒`, `模型 ${r.model}`);
    console.log(`  ${C.dim}模型回答：${r.reply}${C.reset}`);
    return;
  }
  line('bad', r.title || '没成功', '');
  console.log(`  ${r.detail || ''}`);
  if (r.error && r.detail) console.log(`  ${C.dim}技术细节：${r.error}${C.reset}`);
}

/** 列出服务端到底有哪些模型。 */
async function cmdModels() {
  const cfg = loadConfig({ rootDir: ROOT });
  section('可用的模型');
  console.log(`  ${C.dim}地址 ${cfg.ai.baseUrl || '(没填)'}${C.reset}`);
  const r = await listModels({ baseUrl: cfg.ai.baseUrl, apiKey: cfg.ai.apiKey });
  if (!r.ok) {
    const ex = explainError(new Error(r.error), { baseUrl: cfg.ai.baseUrl });
    line('bad', ex.title, '');
    console.log(`  ${ex.detail}`);
    console.log(`  ${C.dim}技术细节：${r.error}${C.reset}`);
    return;
  }
  if (!r.models.length) {
    line('warn', '连上了，但没返回任何模型', '地址可能不是 /v1 根目录');
    return;
  }
  line('ok', `找到 ${r.models.length} 个模型`, '');
  for (const m of r.models) console.log(`    ${m === cfg.ai.model ? C.green + '*' : ' '} ${m}${m === cfg.ai.model ? '  ← 现在用的' : ''}`);
  console.log(`  ${C.dim}换成别的：autochat config set AI_MODEL=模型名${C.reset}`);
}

/** 列出所有支持的接入方式。 */
function cmdProviders() {
  section('可以这样接模型');
  const groups = groupedProviders();
  for (const g of groups) {
    console.log(`\n  ${C.bold}${g.group}${C.reset}`);
    for (const p of g.items) {
      console.log(`    ${C.cyan}${p.id.padEnd(12)}${C.reset}${p.name}`);
      console.log(`      ${C.dim}地址 ${p.baseUrl || '（自己填）'}｜模型 ${p.model || '（自己填）'}｜${p.needsKey ? '需要密钥' : '不要密钥'}${C.reset}`);
    }
  }
  console.log(`\n  ${C.dim}一键配置：autochat setup${C.reset}`);
  console.log(`  ${C.dim}只想换地址和模型：autochat config set AI_BASE_URL=... AI_MODEL=...${C.reset}`);
}

/** 初始化向导：一步步问，答完就能用。面向完全不懂代码的人。 */
async function cmdSetup() {
  // 真人交互用 readline；被管道/重定向喂输入时一次性读完再按行取，
  // 否则 readline 会在 EOF 后关闭，问第二题就崩。
  const isTty = Boolean(process.stdin.isTTY);
  let rl = null;
  let pending = [];
  if (isTty) {
    const readline = await import('node:readline/promises');
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  } else {
    const raw = await new Promise((resolve) => {
      let s = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => {
        s += d;
      });
      process.stdin.on('end', () => resolve(s));
      process.stdin.on('error', () => resolve(s));
    });
    pending = raw
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x !== '');
  }

  const ask = async (q, def = '') => {
    const hint = def ? ` ${C.dim}[直接回车=${def}]${C.reset}` : '';
    if (!isTty) {
      const a = pending.shift() ?? '';
      console.log(`${q}${hint}：${a}`);
      return String(a).trim();
    }
    let a = '';
    try {
      a = String((await rl.question(`${q}${hint}：`) || '')).trim();
    } catch {
      a = '';
    }
    const bad = guardInput(a);
    if (bad) {
      console.log(`  ${C.yellow}${bad}${C.reset}`);
      return ask(q, def);
    }
    return a;
  };

  try {
    console.log(`\n${C.bold}AutoChat 初始化向导${C.reset} ${C.dim}—— 照着答就行，答错了可以重来${C.reset}`);
    console.log(`${C.dim}只问 5 步，随时按 Ctrl+C 退出${C.reset}`);

    // ── 第 1 步：模型从哪来 ──────────────────────────────────────────
    const found = await discoverLocal();
    const groups = groupedProviders();
    const options = [];
    for (const d of found) {
      options.push({
        id: d.providerId,
        name: `本机 ${d.name}（已启动）`,
        baseUrl: d.baseUrl,
        model: d.models[0] || '',
        models: d.models,
        online: true,
      });
    }
    for (const g of groups) {
      for (const p of g.items) {
        if (found.some((d) => d.providerId === p.id)) continue;
        options.push({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, provider: p });
      }
    }

    console.log(`\n${C.bold}第 1 / 4 步${C.reset} ${C.dim}模型从哪来？${C.reset}`);
    if (found.length) {
      console.log(`  ${C.dim}先看看你电脑上已经在跑的：${C.reset}`);
      options.forEach((o, i) => {
        const tag = o.online ? `${C.green}● 在线${C.reset}` : `${C.dim}○${C.reset}`;
        console.log(`    ${C.bold}${i + 1}${C.reset}) ${tag} ${o.name}  ${C.dim}${o.baseUrl}${C.reset}`);
      });
    } else {
      console.log(`  ${C.dim}没在本机扫到已启动的模型服务（Ollama / LM Studio 之类）。${C.reset}`);
      options.forEach((o, i) => {
        console.log(`    ${C.bold}${i + 1}${C.reset}) ${o.name}  ${C.dim}${o.baseUrl || '自己填地址'}${C.reset}`);
      });
    }
    const pickRaw = await ask('  选哪个（输入编号）', '1');
    let idx = Number(pickRaw) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) idx = 0;
    const chosen = options[idx];
    const provider = chosen.provider || providersById(chosen.id);
    let base = chosen.baseUrl;
    let model = chosen.model;

    if (provider?.steps?.length) {
      console.log(`\n  ${C.dim}「${provider.name}」要怎么开始：${C.reset}`);
      provider.steps.forEach((s, i) => console.log(`    ${i + 1}) ${s}`));
      if (provider.tip) console.log(`    ${C.yellow}注意：${provider.tip}${C.reset}`);
    }

    // ── 第 2 步：密钥 ───────────────────────────────────────────────
    let key = '';
    const needKey = provider ? provider.needsKey : true;
    if (needKey) {
      console.log(`\n${C.bold}第 2 / 4 步${C.reset} ${C.dim}密钥（API Key）${C.reset}`);
      if (provider?.keyHint) console.log(`  ${C.dim}${provider.keyHint}${C.reset}`);
      if (provider?.keyUrl) console.log(`  ${C.dim}申请地址：${provider.keyUrl}${C.reset}`);
      key = await ask('  把密钥粘进来（没有就先回车跳过）');
      if (!key) console.log(`  ${C.yellow}没填密钥 —— 云端服务一般会拒绝请求，之后可以再补：autochat config set AI_API_KEY=...${C.reset}`);
    } else {
      console.log(`\n${C.bold}第 2 / 4 步${C.reset} ${C.dim}密钥${C.reset}`);
      console.log(`  ${C.green}本地模型不需要密钥，跳过。${C.reset}`);
    }

    // ── 第 3 步：模型名 ─────────────────────────────────────────────
    console.log(`\n${C.bold}第 3 / 4 步${C.reset} ${C.dim}用哪个模型？${C.reset}`);
    if (chosen.models && chosen.models.length) {
      // 默认项：优先用服务商推荐的模型（一般是通用能力最好的那个），找不到才用第一个
      const prefer = provider?.model && chosen.models.includes(provider.model) ? provider.model : chosen.models[0];
      const defaultNo = String(chosen.models.indexOf(prefer) + 1);
      chosen.models.slice(0, 8).forEach((m, i) => {
        console.log(`    ${C.bold}${i + 1}${C.reset}) ${m}${m === prefer ? ` ${C.dim}← 推荐${C.reset}` : ''}`);
      });
      const pickModel = await ask('  选哪个（输入编号，直接回车用推荐的那个）', defaultNo);
      const mi = Number(pickModel) - 1;
      model = chosen.models[mi] || prefer;
    } else {
      const list = await listModels({ baseUrl: base, apiKey: key }).catch(() => ({ ok: false, models: [] }));
      if (list.ok && list.models.length) {
        const prefer = provider?.model && list.models.includes(provider.model) ? provider.model : list.models[0];
        const defaultNo = String(list.models.indexOf(prefer) + 1);
        console.log(`  ${C.dim}这个服务上有这些模型：${C.reset}`);
        list.models.slice(0, 8).forEach((m, i) => {
          console.log(`    ${C.bold}${i + 1}${C.reset}) ${m}${m === prefer ? ` ${C.dim}← 推荐${C.reset}` : ''}`);
        });
        const pickModel = await ask('  选哪个（输入编号，直接回车用推荐的那个）', defaultNo);
        const mi = Number(pickModel) - 1;
        model = list.models[mi] || prefer;
      } else {
        model = (await ask('  模型名（不知道就先回车）', provider?.model || '')) || provider?.model || '';
      }
    }

    // ── 第 4 步：试一下 ─────────────────────────────────────────────
    console.log(`\n${C.bold}第 4 / 4 步${C.reset} ${C.dim}试一下能不能用${C.reset}`);
    console.log(`  ${C.dim}地址 ${base}｜模型 ${model || '(没填)'}${C.reset}`);
    let ok = false;
    let result = null;
    if (base && model) {
      console.log(`  ${C.dim}正在测试…${C.reset}`);
      result = await testChat({ baseUrl: base, apiKey: key, model });
      ok = result.ok;
    }
    if (ok) {
      line('ok', `成功！耗时 ${result.ms} 毫秒`, '');
      console.log(`  ${C.dim}模型回答：${result.reply}${C.reset}`);
    } else if (result) {
      line('bad', result.title || '没成功', '');
      console.log(`  ${result.detail || ''}`);
      if (result.error) console.log(`  ${C.dim}技术细节：${result.error}${C.reset}`);
    } else {
      line('warn', '没填全地址和模型名', '可以先保存，之后再改');
    }

    // ── 第 5 步：小号 / 同号 + 人设 + 监听会话 ─────────────────────
    console.log(`\n${C.bold}第 5 / 5 步${C.reset} ${C.dim}小号方案 / 人设（决定机器人怎么识别「自己发的消息」）${C.reset}`);
    console.log(`  ${C.dim}电脑微信登录的是小号还是你主号？${C.reset}`);
    console.log(`    1) 小号（推荐：手机主号 + 电脑小号登录，互不影响）`);
    console.log(`    2) 同号（电脑微信就是你手机号同号）`);
    const modeRaw = await ask('  选哪个（1/2，默认 1）', '1');
    const selfMode = modeRaw.trim() === '2' ? 'id' : 'sender';
    if (selfMode === 'id') {
      console.log(`  ${C.yellow}同号方案必须用 id 模式，否则会把自己发的消息当别人的回。${C.reset}`);
    }
    const persona = await ask('  人设文件路径（可选，如 ./data/persona-default.md，直接回车跳过）', '');
    const pollChats = await ask('  要监听的会话 wxid（逗号分隔，可留空后用 autochat chats add）', '');

    const save = (await ask('  要保存吗？', 'Y')).toLowerCase();
    if (save === '' || save === 'y' || save === 'yes') {
      const updates = { AI_BASE_URL: base, AI_MODEL: model, AI_ENABLED: '1', AI_MASTER_SWITCH: '1', WX_SELF_MODE: selfMode };
      if (persona) updates.AI_PERSONA_FILE = persona;
      if (pollChats) updates.WX_POLL_CHATS = pollChats;
      if (key) updates.AI_API_KEY = key;
      const r = setEnvValues(envFile, updates);
      console.log(`\n  ${C.green}已保存：${r.changed.join('、')}${C.reset}`);
      console.log(`  ${C.dim}下一步：autochat doctor 看体检，autochat start 启动服务${C.reset}`);
    } else {
      console.log(`\n  ${C.dim}没有保存。${C.reset}`);
    }
  } finally {
    rl?.close();
  }
}

/** 向导输入守卫：这里只填内容，不接受命令。 */
function guardInput(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (t.length > 300) return '输入太长了，检查一下是不是粘错了东西';
  if (/^[-/\\]/.test(t)) return '这里只填内容，不用以 - 或 / 开头';
  if (/[;&|`]/.test(t)) return '这里不能包含 ; & | ` 这些符号';
  return null;
}

function providersById(id) {
  const all = groupedProviders().flatMap((g) => g.items);
  return all.find((p) => p.id === id) || null;
}

function cmdConfig() {  const sub = (positional[0] || 'get').toLowerCase();
  const env = readEnvFile(envFile);
  if (sub === 'get') {
    const key = positional[1];
    if (!key) {
      section('.env');
      for (const [k, v] of Object.entries(env)) {
        const shown = /KEY|SECRET|TOKEN|PASSWORD/i.test(k) ? `${String(v).slice(0, 4)}****` : v;
        console.log(`  ${C.cyan}${k}${C.reset}=${shown}`);
      }
      return;
    }
    console.log(env[key] ?? '');
    return;
  }
  if (sub === 'set') {
    const updates = {};
    for (const pair of positional.slice(1)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      updates[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    if (!Object.keys(updates).length) {
      console.log(`${C.yellow}\u7528\u6cd5\uff1aautochat config set KEY=VALUE [KEY2=VALUE2]${C.reset}`);
      return;
    }
    const r = setEnvValues(envFile, updates);
    console.log(`${C.green}\u5df2\u66f4\u65b0\uff1a${r.changed.join('\u3001')}${C.reset}`);
    console.log(`${C.dim}\u6539\u5b8c\u8981\u91cd\u542f\u670d\u52a1\u624d\u751f\u6548${C.reset}`);
  }
}

async function cmdInstall() {
  const envUpdates = {};
  for (const pair of positional) {
    const eq = pair.indexOf('=');
    if (eq > 0) envUpdates[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  section('\u73af\u5883\u68c0\u67e5');
  for (const c of await checkEnvironment({ rootDir: ROOT })) line(c.ok ? 'ok' : 'warn', c.name, c.detail);
  section('\u5b89\u88c5');
  const r = await install({
    rootDir: ROOT,
    env: envUpdates,
    autostart: flag('autostart'),
    shortcut: flag('shortcut'),
    deployDll: flag('deploy-dll'),
    lock: flag('lock'),
  });
  for (const s of r.steps) line(s.ok ? 'ok' : 'bad', s.name, s.detail);
  console.log(
    r.ok
      ? `\n${C.green}\u5b89\u88c5\u5b8c\u6210${C.reset}`
      : `\n${C.yellow}\u5b89\u88c5\u5b8c\u6210\uff0c\u4f46\u6709\u6b65\u9aa4\u6ca1\u6210\u529f${C.reset}`
  );
}

async function cmdUninstall() {
  section('\u5378\u8f7d');
  const r = await uninstall({ rootDir: ROOT, purge: flag('purge') });
  for (const s of r.steps) line(s.ok ? 'ok' : 'bad', s.name, s.detail);
}

async function cmdGui() {
  const { startGui } = await import('../setup/server.js');
  // 默认就打开单例浏览器窗口（单开独立窗口、不新建选项卡）；--no-window 可关闭自动打开（CI / 远程场景）
  await startGui({ rootDir: ROOT, port: Number(opt('port', '8788')), window: !flag('no-window') });
}

/** 探测本机微信 wxid：检查自动获取（hook / 本地库）是否正常，省得翻启动日志。 */
async function cmdSelf() {
  const cfg = loadConfig({ rootDir: ROOT });
  const hook = new HookClient({
    host: cfg.wechat.host,
    port: cfg.wechat.port,
    endpoints: cfg.wechat.endpoints,
    logger: createLogger('hook-ipc', cfg.logLevel),
    dbName: cfg.wechat.pollDb,
  });

  section('本机微信 wxid 探测（用于识别「自己发出的消息」）');
  line(cfg.wechat.selfId ? 'ok' : 'warn', 'WX_SELF_ID 配置', cfg.wechat.selfId || '（未配置，将自动获取）');

  let fromProfile = '';
  try {
    const prof = await hook.selfProfile();
    fromProfile = prof?.wxid || '';
    if (fromProfile) {
      line('ok', 'hook /GetSelfProfile', `${prof.nickname ? prof.nickname + ' ' : ''}(${fromProfile})`);
    } else {
      line('warn', 'hook /GetSelfProfile', '未返回 wxid（DLL 不支持 / 未登录 / 字段名不匹配）');
    }
  } catch (e) {
    line('warn', 'hook /GetSelfProfile', e.message);
  }

  let fromDb = '';
  if (!fromProfile) {
    try {
      fromDb = await hook.selfAccount();
      if (fromDb) line('ok', '本地库兜底', fromDb);
      else line('warn', '本地库兜底', '未查到（表/列名不匹配或库不可读）');
    } catch (e) {
      line('warn', '本地库兜底', e.message);
    }
  }

  const final = cfg.wechat.selfId || fromProfile || fromDb;
  console.log('');
  line(
    final ? 'ok' : 'warn',
    '最终用于「排除自己消息」的 wxid',
    final || '（拿不到，将禁用基于 id 的过滤，可能自问自答）'
  );
}

function printHelp() {
  console.log(`
${C.bold}AutoChat${C.reset} \u2014\u2014 \u5fae\u4fe1\u4fa7\u7684\u672c\u5730 AI \u52a9\u624b

${C.bold}\u7b2c\u4e00\u6b21\u7528${C.reset}
  autochat setup                \u521d\u59cb\u5316\u5411\u5bfc\uff1a\u4e00\u6b65\u6b65\u7167\u7740\u7b54\u5c31\u80fd\u7528\uff08\u63a8\u8350\uff09
  autochat providers            \u770b\u6709\u54ea\u4e9b\u6a21\u578b\u53ef\u4ee5\u63a5\uff08\u672c\u5730 / \u4e91\u7aef\uff09
  autochat test                 \u6d4b\u8bd5\u73b0\u5728\u7684\u6a21\u578b\u914d\u7f6e\u80fd\u4e0d\u80fd\u7528
  autochat models               \u5217\u51fa\u670d\u52a1\u7aef\u6709\u54ea\u4e9b\u6a21\u578b

${C.bold}\u8fd0\u884c${C.reset}
  autochat start                \u524d\u53f0\u542f\u52a8\u670d\u52a1
  autochat status               \u72b6\u6001\u603b\u89c8\uff08\u670d\u52a1 / \u603b\u95f8 / \u914d\u7f6e / \u4e0a\u4e0b\u6587\uff09
  autochat doctor               \u73af\u5883\u4f53\u68c0\uff1a\u4e3a\u4ec0\u4e48\u673a\u5668\u4eba\u4e0d\u7406\u6211
  autochat gui [--no-window]   图形化配置器（默认自动打开单例独立浏览器窗口；--no-window 关闭自动打开）
  autochat self                探测本机微信 wxid（检查自动获取是否正常）

${C.bold}\u603b\u95f8${C.reset}\uff08\u81ea\u52a8\u5316\u6700\u6015\u505c\u4e0d\u4e0b\u6765\uff0c\u6240\u4ee5\u653e\u6700\u524d\u9762\uff09
  autochat pause [\u539f\u56e0]      \u7acb\u523b\u505c\u6b62\u81ea\u52a8\u56de\u590d\uff08\u4ecd\u63a5\u6536\u3001\u4ecd\u8bb0\u65e5\u5fd7\uff09
  autochat resume              \u6062\u590d\u81ea\u52a8\u56de\u590d
  autochat stop                \u505c\u6389\u6574\u4e2a\u670d\u52a1\u8fdb\u7a0b

${C.bold}\u7ba1\u7406${C.reset}
  autochat chats list|add|rm|enable|disable <\u4f1a\u8bddid>
  autochat context [\u4f1a\u8bddid] [--clear]   \u67e5\u770b / \u6e05\u7a7a\u4e0a\u4e0b\u6587
  autochat config get|set      \u8bfb\u5199 .env\uff08set \u4fdd\u7559\u6ce8\u91ca\uff09
  autochat install [--autostart] [--shortcut] [--deploy-dll] [--lock] [KEY=VALUE ...]
  autochat uninstall [--purge]
`);
}

const COMMANDS = {
  status: cmdStatus,
  doctor: cmdDoctor,
  pause: cmdPause,
  resume: cmdResume,
  stop: cmdStop,
  chats: cmdChats,
  context: cmdContext,
  config: cmdConfig,
  setup: cmdSetup,
  test: cmdTest,
  models: cmdModels,
  providers: cmdProviders,
  install: cmdInstall,
  uninstall: cmdUninstall,
  gui: cmdGui,
  self: cmdSelf,
  help: printHelp,
};

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }
  if (cmd === 'start') {
    await import('../index.js');
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`${C.red}\u672a\u77e5\u547d\u4ee4\uff1a${cmd}${C.reset}`);
    printHelp();
    process.exitCode = 1;
    return;
  }
  await fn();
}

main().catch((err) => {
  console.error(`${C.red}\u6267\u884c\u5931\u8d25\uff1a${err?.stack || err?.message || err}${C.reset}`);
  process.exit(1);
});
