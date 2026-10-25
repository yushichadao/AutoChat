import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from '../core/paths.js';
import { setEnvValues, readEnvFile } from '../core/env-file.js';
import { deployProxyDll } from '../bridge/injector.js';
import { detectWeChat } from '../bridge/process.js';
import { resolveProfile } from '../bridge/profiles.js';
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
} from '../core/win.js';

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
  let dllOk = Boolean(dll && fs.existsSync(dll));
  let dllDetail;
  if (dll) {
    dllDetail = fs.existsSync(dll) ? dll : `配置里的路径不存在：${dll}`;
  } else if (wechat?.version) {
    const builtin = resolveBuiltinDll(wechat.version, rootDir);
    dllDetail = builtin
      ? `未配置，但已匹配到内置 DLL（微信 ${wechat.version}），可在配置器一键写入`
      : '未配置 WX_DLL_PATH（没有匹配本机微信的内置 DLL，需要自备）';
  } else {
    dllDetail = '未配置 WX_DLL_PATH（需要自备匹配的 DLL）';
  }
  checks.push(step('hook DLL', dllOk, dllDetail));
  return checks;
}

/** 执行一段 PowerShell，返回 { ok, out, err }。 */
function runPs(script, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(err?.message || '') })
    );
  });
}

/**
 * 锁住微信版本：把 update 目录替换成同名只读文件，微信无法再下载更新。
 * 路径为用户目录（%APPDATA%\Tencent\xwechat\update），不需要管理员权限。
 * 还原见 uninstall（或手动删除该只读文件）。
 */
export async function lockWeChatUpdate() {
  const { ok, out, err } = await runPs(
    "$up = Join-Path $env:APPDATA 'Tencent\\xwechat\\update';" +
      "if(Test-Path $up){ Remove-Item $up -Recurse -Force -ErrorAction SilentlyContinue };" +
      "New-Item -ItemType File -Path $up -Force | Out-Null;" +
      "(Get-Item $up).IsReadOnly = $true;" +
      "Write-Output 'locked'"
  );
  if (!ok) return { ok: false, detail: err || out || 'PowerShell 执行失败' };
  return { ok: true, detail: '已把 update 目录替换为只读文件，微信无法自动下载更新' };
}

const BUILTIN_AIXED = 'tools/wxhook/WeChat-Hook-main/version-aixed.dll';
const BUILTIN_MILOIRA = [
  'tools/wxhook/mini.dll',
  'tools/wxhook/mini2.dll',
  'tools/wxhook/mini_c.dll',
  'tools/wxhook/mini_gcc16.dll',
  'tools/wxhook/version-gcc16.dll',
];

/**
 * 按微信版本匹配项目内置的自制 DLL（项目已附带，clone 自带）。
 * 返回绝对路径；无匹配返回 null。
 */
export function resolveBuiltinDll(version, rootDir = ROOT) {
  const r = resolveProfile(version);
  if (!r.profile) return null;
  const d = r.profile.dll.toLowerCase();
  if (d.includes('aixed')) {
    if (r.profile.wechat === '4.1.10.27') {
      const p = path.join(rootDir, BUILTIN_AIXED);
      return fs.existsSync(p) ? p : null;
    }
    return null;
  }
  if (d.includes('miloira')) {
    for (const c of BUILTIN_MILOIRA) {
      const p = path.join(rootDir, c);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  return null;
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

  // ── 锁住微信版本（阻断自动更新）──
  if (opts.lock) {
    try {
      const r = await lockWeChatUpdate();
      steps.push(step('锁住微信版本', r.ok, r.detail));
    } catch (err) {
      steps.push(step('锁住微信版本', false, err.message));
    }
  }

  // ── 自动选 DLL：未显式指定时，按检测到的微信版本匹配内置 DLL ──
  if (!opts.env?.WX_DLL_PATH && !opts.dllPath) {
    const wechat = await detectWeChat(opts.env?.WX_INSTALL_DIR || '').catch(() => null);
    if (wechat?.version) {
      const builtin = resolveBuiltinDll(wechat.version, rootDir);
      if (builtin) {
        opts.env = { ...(opts.env || {}), WX_DLL_PATH: builtin };
        const lv = resolveProfile(wechat.version).level;
        steps.push(
          step(
            '自动选 DLL',
            true,
            `${path.relative(rootDir, builtin)}（微信 ${wechat.version}${lv === 'exact' ? '' : '，版本近似匹配，可能需手动换'}）`
          )
        );
      }
    }
  }

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

  // 开机自启：默认以前台方式启动；--service 走后台模式（脱离登录会话，关终端也在跑）
  if (opts.autostart || opts.service) {
    const entry = path.join(rootDir, 'src', 'cli', 'index.js');
    const cmd = opts.service
      ? `${process.execPath} ${entry} start --background`
      : `${process.execPath} ${entry} start`;
    const r = await setAutoStart(AUTOSTART_NAME, cmd);
    steps.push(
      step(
        '注册开机自启',
        r.ok,
        r.ok ? AUTOSTART_NAME + (opts.service ? '（后台模式）' : '') : r.message
      )
    );
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
