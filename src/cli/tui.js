/**
 * 终端交互引导器（TUI）。
 *
 * 设计目标：**新手完全自动化**——检测环境、锁版本、自动选 DLL、配模型、设小号、
 * 启动注入，一条路走到底，不用读文档、不用开浏览器。
 *
 * 零依赖：只用 Node 内置的 raw mode + ANSI 转义做菜单/输入，不引入 blessed/ink 等，
 * 与项目「零运行时依赖」原则一致。GUI（浏览器窗口）适合改配置，TUI 适合第一次跑通。
 *
 * 实际工作都委托给已验证的模块（installer / probe / process），TUI 只做导航与展示。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROOT } from '../config.js';
import { readEnvFile, setEnvValues } from './env-file.js';
import { checkEnvironment, resolveBuiltinDll, lockWeChatUpdate } from '../setup/installer.js';
import { detectWeChat } from '../bridge/process.js';
import { discoverLocal, groupedProviders, listModels, testChat } from '../ai/probe.js';
import { resolveProfile } from '../bridge/profiles.js';
import { isWindows } from '../setup/win.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function clear() {
  process.stdout.write('\x1b[2J\x1b[H');
}
function write(s) {
  process.stdout.write(s);
}

/** 上下键导航菜单，回车确认，返回选中项的 value（allowCancel 时 Esc 返回 undefined）。 */
function menu(title, items, { allowCancel = false } = {}) {
  return new Promise((resolve) => {
    let sel = 0;
    const render = () => {
      clear();
      write(`${C.bold}${title}${C.reset}\n\n`);
      items.forEach((it, i) => {
        const mark = i === sel ? `${C.cyan}▶ ${C.reset}` : '  ';
        const label = i === sel ? `${C.cyan}${it.label}${C.reset}` : it.label;
        write(`${mark}${label}\n`);
      });
      write(`\n${C.dim}↑/↓ 选择 · Enter 确认${allowCancel ? ' · Esc 取消' : ''}${C.reset}\n`);
    };
    render();
    const onData = (buf) => {
      const s = buf.toString();
      if (s === '\x1b[A') {
        sel = (sel - 1 + items.length) % items.length;
        render();
      } else if (s === '\x1b[B') {
        sel = (sel + 1) % items.length;
        render();
      } else if (s === '\r' || s === '\n') {
        cleanup();
        resolve(items[sel].value);
      } else if (s === '\x1b' && allowCancel) {
        cleanup();
        resolve(undefined);
      }
    };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/** 文本输入：临时退出 raw mode 用 readline，结束保持非 raw（menu 会重新开启）。 */
async function input(prompt, def = '') {
  process.stdin.setRawMode(false);
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${prompt}${def ? ` ${C.dim}[${def}]${C.reset}` : ''}: `);
  rl.close();
  return String(a).trim() || def;
}

async function confirm(prompt) {
  const a = (await input(`${prompt} ${C.dim}(Y/n)${C.reset}`, 'Y')).toLowerCase();
  return a === '' || a === 'y' || a === 'yes';
}

/** 展示信息，按任意键继续。 */
function info(title, lines, hint = '按任意键继续') {
  return new Promise((resolve) => {
    clear();
    write(`${C.bold}${title}${C.reset}\n\n`);
    for (const l of lines) write(`  ${l}\n`);
    write(`\n${C.dim}${hint}${C.reset}\n`);
    const onData = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      resolve();
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function runStep(label, fn) {
  process.stdout.write(`  ${C.dim}…${C.reset} ${label}\n`);
  try {
    const r = await fn();
    process.stdout.write(`  ${C.green}✓${C.reset} ${label}\n`);
    return r;
  } catch (e) {
    process.stdout.write(`  ${C.red}✗${C.reset} ${label}：${e?.message || e}\n`);
    return null;
  }
}

/** 第 4 步：配模型（TUI 版，复用 probe 的探测与测试）。 */
async function configureModel(envFile) {
  const found = (await runStep('扫描本机已启动的模型服务', () => discoverLocal())) || [];
  const groups = groupedProviders();
  const options = [];
  for (const d of found) {
    options.push({ id: d.providerId, label: `本机 ${d.name}（已启动）`, baseUrl: d.baseUrl, model: d.models[0] || '', models: d.models, online: true });
  }
  for (const g of groups) {
    for (const p of g.items) {
      if (found.some((d) => d.providerId === p.id)) continue;
      options.push({ id: p.id, label: p.name, baseUrl: p.baseUrl, model: p.model || '', provider: p });
    }
  }
  if (!options.length) {
    await info('没有可选的模型来源', ['请先启动 Ollama / LM Studio，或确认云端地址。']);
    return;
  }

  const chosen = await menu('选择模型来源', options.map((o) => ({ label: o.label, value: o })));
  if (!chosen) return;
  const provider = chosen.provider;
  let base = chosen.baseUrl;
  let model = chosen.model;
  let key = '';

  if (provider?.needsKey) {
    key = await input('API Key（没有先回车跳过）', '');
    if (provider?.keyHint) process.stdout.write(`  ${C.dim}${provider.keyHint}${C.reset}\n`);
  }

  if (chosen.models?.length) {
    const m = await menu('选择模型', chosen.models.map((x) => ({ label: x, value: x })));
    model = m || chosen.model;
  } else if (base) {
    const list = await listModels({ baseUrl: base, apiKey: key }).catch(() => ({ ok: false, models: [] }));
    if (list.ok && list.models.length) {
      const m = await menu('选择模型', list.models.map((x) => ({ label: x, value: x })));
      model = m || provider?.model;
    } else {
      model = await input('模型名', provider?.model || '');
    }
  }

  const r = await runStep('测试模型连通性', () =>
    base && model ? testChat({ baseUrl: base, apiKey: key, model }) : Promise.resolve({ ok: false })
  );
  if (r && r.ok) {
    await info('模型测试成功', [`${model} @ ${base}`, `模型回答：${r.reply}`]);
  } else if (r) {
    await info('模型测试未通过', [r.detail || '可稍后在 .env 手动修正，不影响继续']);
  }

  if (await confirm('保存模型配置？')) {
    const updates = { AI_BASE_URL: base, AI_MODEL: model, AI_ENABLED: '1', AI_MASTER_SWITCH: '1' };
    if (key) updates.AI_API_KEY = key;
    setEnvValues(envFile, updates);
  }
}

/** 第 5 步：小号 / 同号模式 + 人设 + 监听会话。 */
async function configureSelf(envFile) {
  const mode = await menu('电脑微信登录的是？', [
    { label: '小号（推荐：手机主号 + 电脑小号登录，互不影响）', value: 'sender' },
    { label: '同号（电脑微信就是你手机号同号）', value: 'id' },
  ]);
  if (mode === 'id') {
    await info('同号方案提醒', ['必须用 id 模式，否则会把自己发的消息当成别人的回。已为你选 id。']);
  }
  const persona = await input('人设文件路径（可选，如 ./data/persona-default.md，回车跳过）', '');
  const pollChats = await input('要监听的会话 wxid（逗号分隔，可留空后用 autochat chats add）', '');
  const updates = { WX_SELF_MODE: mode || 'sender' };
  if (persona) updates.AI_PERSONA_FILE = persona;
  if (pollChats) updates.WX_POLL_CHATS = pollChats;
  setEnvValues(envFile, updates);
}

/** TUI 入口。 */
export async function runTui() {
  if (!isWindows) {
    console.log('TUI 引导器仅适用于 Windows（微信 hook 仅 Windows）。请改用 autochat setup 或 autochat gui。');
    return;
  }
  if (!process.stdin.isTTY) {
    console.log('TUI 需要交互式终端（TTY）。在管道 / 重定向场景下请用 autochat setup。');
    return;
  }
  const envFile = path.join(ROOT, '.env');

  await info('AutoChat 引导（一站式自动配置）', [
    `${C.dim}全程在你自己电脑上，不连接外部平台，不碰他人账号。${C.reset}`,
    `${C.dim}模型可选手本地（零出网）或云端（只发到你指定的地址）。${C.reset}`,
    `${C.dim}用小号隔离主号，随时可 autochat pause 暂停 / autochat uninstall 卸载。${C.reset}`,
  ]);

  // 1. 环境体检
  const checks = await runStep('环境体检', () => checkEnvironment({ rootDir: ROOT }));
  if (checks) {
    await info(
      '环境体检结果',
      checks.map((c) => `${c.ok ? C.green + '✓' : C.yellow + '!'} ${c.name} ${C.dim}${c.detail || ''}${C.reset}`)
    );
  }

  // 2. 锁版本（阻断自动更新）
  if (await confirm('锁定微信版本以阻断自动更新？（推荐：DLL 与版本强绑定，版本一变就失效）')) {
    const r = await runStep('锁住微信版本', () => lockWeChatUpdate());
    if (r && !r.ok) await info('锁版本未完成', [r.detail]);
  }

  // 3. 选 DLL（自动匹配内置，否则手动）
  const wechat = await runStep('检测微信安装', () => detectWeChat('').catch(() => null));
  let dll = readEnvFile(envFile).WX_DLL_PATH || '';
  if (!dll && wechat?.version) {
    const builtin = resolveBuiltinDll(wechat.version, ROOT);
    const lv = resolveProfile(wechat.version).level;
    if (builtin) {
      if (
        await confirm(
          `检测到微信 ${wechat.version}，使用内置 DLL ${C.cyan}${path.relative(ROOT, builtin)}${C.reset}${lv === 'exact' ? '' : '（版本近似匹配，可能需手动换）'}？`
        )
      ) {
        dll = builtin;
        setEnvValues(envFile, { WX_DLL_PATH: builtin });
      }
    } else {
      await info('未找到匹配的内置 DLL', [`微信 ${wechat.version} 暂无内置方案，请手动提供 WX_DLL_PATH（见 README 版本档案）。`]);
    }
  }
  if (!dll) {
    dll = await input('DLL 绝对路径（WX_DLL_PATH）', dll);
    if (dll) setEnvValues(envFile, { WX_DLL_PATH: dll });
  }

  // 4. 配模型
  await configureModel(envFile);

  // 5. 小号模式
  await configureSelf(envFile);

  // 6. 注入方式（可选 proxy；默认 inject 在启动时完成）
  const useProxy = await confirm('是否把 DLL 部署到微信目录（proxy 模式，需管理员）？默认用 inject 注入选 n');
  if (useProxy) {
    setEnvValues(envFile, { WX_INJECT_MODE: 'proxy' });
    await info('proxy 模式', ['请用管理员身份运行：autochat install --deploy-dll 部署 version.dll，然后重启微信再启动服务。']);
  }

  // 7. 启动（接管进程）
  await info('准备启动', [
    `${C.dim}请确认微信已登录（建议小号）。接下来会启动服务并注入微信。${C.reset}`,
    `${C.dim}启动后，用主号给小号发“你好”验证是否自动回复。${C.reset}`,
    `${C.dim}启动后会进入服务进程；停止：autochat stop / pause。${C.reset}`,
  ]);
  await import('../index.js');
}
