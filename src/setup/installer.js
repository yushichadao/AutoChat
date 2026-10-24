import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { setEnvValues, readEnvFile } from '../cli/env-file.js';
import { deployProxyDll } from '../bridge/injector.js';
import { detectWeChat } from '../bridge/process.js';
import {
  isWindows,
  isElevated,
  setAutoStart,
  clearAutoStart,
  getAutoStart,
  createShortcut,
  removeShortcut,
  hasShortcut,
  shortcutPath,
  killProcess,
  isRunning,
} from './win.js';

/**
 * 安装 / 卸载。
 *
 * CLI（autochat install / uninstall）和图形化配置器走同一套逻辑，
 * 区别只是「谁来填参数」—— 命令行用参数，窗口用表单。
 *
 * 安装只做「不破坏现状」的事：
 *  · 写配置（.env / config.json），已存在就只补缺的
 *  · 可选注册开机自启、创建桌面快捷方式
 *  · 可选把 hook DLL 部署成 version.dll（proxy 模式）
 * 不下载任何东西、不改微信本体（除了那个可选的 version.dll，且留了 .bak）。
 */

export const AUTOSTART_NAME = 'AutoChat';
export const SHORTCUT_NAME = 'AutoChat 配置器';

function step(name, ok, detail = '') {
  return { name, ok, detail };
}

/** 环境体检：Node、微信、hook DLL。 */
export async function checkEnvironment({ rootDir = ROOT } = {}) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(step('Node 版本', major >= 18, `${process.version}（需要 18 以上）`));

  if (!isWindows) {
    checks.push(step('微信客户端', false, '当前不是 Windows，微信 hook 方案不适用'));
    return checks;
  }

  let wechat = null;
  const env = readEnvFile(path.join(rootDir, '.env'));
  const dir = env.WX_INSTALL_DIR || '';
  try {
    wechat = await detectWeChat(dir);
  } catch {
    wechat = null;
  }
  checks.push(
    step(
      '微信客户端',
      Boolean(wechat?.dir),
      wechat?.dir
        ? `${wechat.dir}（${wechat.version || '版本未知'}）`
        : '没有找到微信安装目录（可在 .env 里填 WX_INSTALL_DIR）'
    )
  );

  const dll = env.WX_DLL_PATH || '';
  checks.push(
    step(
      'hook DLL',
      Boolean(dll && fs.existsSync(dll)),
      dll
        ? fs.existsSync(dll)
          ? dll
          : `配置里的路径不存在：${dll}`
        : '未配置 WX_DLL_PATH（需要自备匹配的 DLL）'
    )
  );
  return checks;
}

/**
 * 执行安装。
 * @param {object} opts
 * @param {Record<string,string>} opts.env     要写进 .env 的键值
 * @param {string} opts.envFile                额外的 .env 文件（整体并入）
 * @param {Record<string,object>} opts.chats   要写进 config.json 的按会话配置
 * @param {boolean} opts.autostart             注册开机自启
 * @param {boolean} opts.shortcut              创建桌面快捷方式
 * @param {boolean} opts.deployDll             把 DLL 部署成 version.dll（proxy 模式）
 */
export async function install(opts = {}) {
  const rootDir = opts.rootDir || ROOT;
  const envFile = path.join(rootDir, '.env');
  const jsonFile = path.join(rootDir, 'config.json');
  const steps = [];

  try {
    if (!fs.existsSync(envFile)) {
      const tpl = path.join(rootDir, '.env.example');
      if (fs.existsSync(tpl)) fs.copyFileSync(tpl, envFile);
    }
    const updates = { ...(opts.env || {}) };
    if (opts.envFile) Object.assign(updates, readEnvFile(opts.envFile));
    if (Object.keys(updates).length) setEnvValues(envFile, updates);
    steps.push(step('写入 .env', true, envFile));
  } catch (err) {
    steps.push(step('写入 .env', false, err.message));
  }

  try {
    let json = {};
    if (fs.existsSync(jsonFile)) {
      try {
        json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      } catch {
        json = {};
      }
    }
    json.chats = { ...(json.chats || {}), ...(opts.chats || {}) };
    fs.writeFileSync(jsonFile, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    steps.push(step('写入 config.json', true, `${Object.keys(json.chats).length} 个会话`));
  } catch (err) {
    steps.push(step('写入 config.json', false, err.message));
  }

  if (opts.autostart) {
    // 不带引号：setAutoStart 会用 reg.exe 的外层双引号处理路径空格
    const cmd = `${process.execPath} ${path.join(rootDir, 'src', 'index.js')}`;
    const r = await setAutoStart(AUTOSTART_NAME, cmd);
    steps.push(step('注册开机自启', r.ok, r.ok ? AUTOSTART_NAME : r.message));
  }

  if (opts.shortcut) {
    const target = path.join(rootDir, 'src', 'cli', 'index.js');
    const r = await createShortcut(SHORTCUT_NAME, process.execPath, `"${target}" gui --window`, rootDir);
    steps.push(step('创建桌面快捷方式', r.ok, r.ok ? r.path : r.message));
  }

  if (opts.deployDll) {
    try {
      const env = readEnvFile(envFile);
      const dll = env.WX_DLL_PATH || opts.dllPath || '';
      const dir = env.WX_INSTALL_DIR || (await detectWeChat('').catch(() => null))?.dir || '';
      if (!dll || !dir) {

        steps.push(step('部署 hook DLL', false, '缺少 WX_DLL_PATH 或微信安装目录'));
      } else if (!(await isElevated())) {
        steps.push(step('部署 hook DLL', false, '需要管理员权限（请用管理员身份重跑）'));
      } else {
        const target = await deployProxyDll(dir, dll);
        steps.push(
          step('部署 hook DLL', true, `${target}（重启微信后生效，原文件备份为 version.dll.bak）`)
        );
      }
    } catch (err) {
      steps.push(step('部署 hook DLL', false, err.message));
    }
  }

  return { ok: steps.every((s) => s.ok), steps };
}

/**
 * 执行卸载。
 * @param {object} opts
 * @param {boolean} opts.purge   连配置与数据一起删
 */
export async function uninstall(opts = {}) {
  const rootDir = opts.rootDir || ROOT;
  const envFile = path.join(rootDir, '.env');
  const jsonFile = path.join(rootDir, 'config.json');
  const dataDir = path.join(rootDir, 'data');
  const steps = [];

  const pidFile = path.join(dataDir, 'autochat.pid');
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0;
  } catch {
    pid = 0;
  }
  if (pid && (await isRunning(pid))) {
    const r = await killProcess(pid);
    steps.push(step('停止服务', r.ok, r.ok ? `已结束进程 ${pid}` : r.message));
  } else {
    steps.push(step('停止服务', true, '没有正在运行的实例'));
  }
  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch {
    /* 忽略 */
  }

  const r = await clearAutoStart(AUTOSTART_NAME);
  steps.push(step('取消开机自启', r.ok, r.ok ? '' : r.message));

  const s = await removeShortcut(SHORTCUT_NAME);
  steps.push(step('删除桌面快捷方式', s.ok, s.ok ? '' : s.message));

  try {
    const env = readEnvFile(envFile);
    const dir = env.WX_INSTALL_DIR || (await detectWeChat('').catch(() => null))?.dir || '';
    const target = dir ? path.join(dir, 'version.dll') : '';
    const bak = target ? `${target}.bak` : '';
    if (target && fs.existsSync(bak)) {
      fs.copyFileSync(bak, target);
      fs.unlinkSync(bak);
      steps.push(step('还原微信目录', true, `已还原 ${target}`));
    } else {
      steps.push(step('还原微信目录', true, '没有需要还原的 version.dll'));
    }
  } catch (err) {
    steps.push(step('还原微信目录', false, err.message));
  }

  if (opts.purge) {
    try {
      if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
      steps.push(step('删除运行数据', true, dataDir));
    } catch (err) {
      steps.push(step('删除运行数据', false, err.message));
    }
    for (const f of [envFile, jsonFile]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
        steps.push(step(`删除 ${path.basename(f)}`, true, f));
      } catch (err) {
        steps.push(step(`删除 ${path.basename(f)}`, false, err.message));
      }
    }
  } else {
    steps.push(step('保留配置与数据', true, '要彻底清除请加 --purge'));
  }

  return { ok: steps.every((x) => x.ok), steps };
}

/** 安装状态（给 GUI 展示）。 */
export async function installStatus({ rootDir = ROOT } = {}) {
  const envFile = path.join(rootDir, '.env');
  const env = readEnvFile(envFile);
  const pidFile = path.join(rootDir, 'data', 'autochat.pid');
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0;
  } catch {
    pid = 0;
  }
  const autoStart = await getAutoStart(AUTOSTART_NAME);
  return {
    installed: fs.existsSync(envFile),
    envFile,
    autoStart,
    shortcut: hasShortcut(SHORTCUT_NAME),
    shortcutPath: shortcutPath(SHORTCUT_NAME),
    running: pid ? await isRunning(pid) : false,
    pid,
    dataDir: path.join(rootDir, 'data'),
  };
}
