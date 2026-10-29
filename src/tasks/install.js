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
      ? `未配置，但发布包已自带匹配的 DLL（微信 ${wechat.version}），可在配置器一键写入`
      : `未配置 WX_DLL_PATH（发布包里没有对应微信 ${wechat.version} 的适配 DLL，可改用受支持的版本或自备）`;
  } else {
    dllDetail = '未配置 WX_DLL_PATH（先让程序识别到微信安装目录，发布包自带适配 DLL）';
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

const BUILTIN_AC = 'tools/wxhook/version-ac-4.1.10.27.dll';
const BUILTIN_MILOIRA = [
  'tools/wxhook/mini.dll',
  'tools/wxhook/mini2.dll',
  'tools/wxhook/mini_c.dll',
  'tools/wxhook/mini_gcc16.dll',
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
      // 4.1.10.27 的自制 DLL 已统一改名为 version-ac-4.1.10.27.dll（原 483840 构建，
      // 支持 send，接收走 DB 轮询）。旧的 aixed(main)/gcc16 构建已弃用：
      // aixed 在 4.1.10.27 上启动即 0xc0000005 崩溃，gcc16 为冗余兜底，均不再保留。
      const ac = path.join(rootDir, BUILTIN_AC);
      return fs.existsSync(ac) ? ac : null;
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

  // ── 自动选 DLL：优先沿用已配置的（用户自制）DLL；没有再按版本匹配内置 ──
  if (!opts.env?.WX_DLL_PATH && !opts.dllPath) {
    const existing = fs.existsSync(envFile) ? readEnvFile(envFile) : {};
    const configured = String(existing.WX_DLL_PATH || '').trim();
    if (configured && fs.existsSync(configured)) {
      steps.push(step('沿用已配置的 DLL（优先）', true, configured));
    } else {
      const wechat = await detectWeChat(existing.WX_INSTALL_DIR || opts.env?.WX_INSTALL_DIR || '').catch(() => null);
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
  /**
   * 演练模式（--dry-run）：只报告「会做什么」，**不真的动任何东西**。
   * 之前这个参数只是 CLI 标题里写着「卸载（演练，不改任何文件）」，任务层根本没实现，
   * 跑 --dry-run 照样会停掉服务、删掉快捷方式 —— 演练个锤子。
   */
  const dryRun = Boolean(opts.dryRun);
  const tag = dryRun ? '（演练）' : '';

  const pidFile = path.join(dataDir, 'autochat.pid');
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0;
  } catch {
    pid = 0;
  }
  if (pid && (await isRunning(pid))) {
    if (dryRun) {
      steps.push(step('停止服务', true, `${tag}会结束进程 ${pid}`));
    } else {
      const r = await killProcess(pid);
      steps.push(step('停止服务', r.ok, r.ok ? `已结束进程 ${pid}` : r.message));
    }
  } else {
    steps.push(step('停止服务', true, '没有正在运行的实例'));
  }
  if (!dryRun) {
    try {
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch {
      /* 忽略 */
    }
  }

  if (dryRun) {
    const has = await getAutoStart(AUTOSTART_NAME);
    steps.push(
      step(
        '取消开机自启',
        true,
        has ? `${tag}会删除自启项 ${AUTOSTART_NAME}` : `${tag}没有自启项，无需处理`
      )
    );
  } else {
    const r = await clearAutoStart(AUTOSTART_NAME);
    steps.push(step('取消开机自启', r.ok, r.ok ? '' : r.message));
  }

  if (dryRun) {
    const link = shortcutPath(SHORTCUT_NAME);
    steps.push(
      step(
        '删除桌面快捷方式',
        true,
        fs.existsSync(link) ? `${tag}会删除 ${link}` : '本来就没有快捷方式'
      )
    );
  } else {
    const s = await removeShortcut(SHORTCUT_NAME);
    steps.push(step('删除桌面快捷方式', s.ok, s.ok ? '' : s.message));
  }

  try {
    const env = readEnvFile(envFile);
    const dir = env.WX_INSTALL_DIR || (await detectWeChat('').catch(() => null))?.dir || '';
    const target = dir ? path.join(dir, 'version.dll') : '';
    const bak = target ? `${target}.bak` : '';
    if (target && fs.existsSync(bak)) {
      if (dryRun) {
        steps.push(step('还原微信目录', true, `${tag}会还原 ${target}`));
      } else {
        fs.copyFileSync(bak, target);
        fs.unlinkSync(bak);
        steps.push(step('还原微信目录', true, `已还原 ${target}`));
      }
    } else {
      steps.push(step('还原微信目录', true, '没有需要还原的 version.dll'));
    }
  } catch (err) {
    steps.push(step('还原微信目录', false, err.message));
  }

  if (opts.purge) {
    if (dryRun) {
      steps.push(step('删除运行数据', true, `${tag}会删除 ${dataDir}`));
      for (const f of [envFile, jsonFile]) {
        steps.push(step(`删除 ${path.basename(f)}`, true, `${tag}会删除 ${f}`));
      }
    } else {
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
    }
  } else {
    steps.push(step('保留配置与数据', true, '要彻底清除请加 --purge'));
  }

  // ── 可选：把程序目录整个移入回收站 ──
  // 只在这里、且只在显式勾选时做。回收站可还原，比 rm -rf 安全，
  // 但仍然是「把程序本体从磁盘上挪走」，所以必须作为独立一步报出来。
  if (opts.recycle) {
    if (dryRun) {
      steps.push(step('移入回收站', true, `${tag}会把程序目录 ${rootDir} 移入回收站`));
    } else {
      const r = await sendToRecycleBin(rootDir);
      steps.push(
        step('移入回收站', r.ok, r.ok ? `已移入回收站：${rootDir}` : (r.message || '失败'))
      );
    }
  }

  return { ok: steps.every((x) => x.ok), steps };
}

/**
 * 把目录移入回收站（可还原，不是直接删除）。
 *
 * 用 Windows 自带的 Microsoft.VisualBasic.FileIO.FileSystem —— 不引入任何依赖。
 * 注意：如果目录正被占用（比如配置器自己就在这个目录里跑），Windows 会拒绝，
 * 这时如实报错，绝不静默跳过。
 *
 * @param {string} dir 绝对路径
 * @returns {Promise<{ok:boolean, message?:string}>}
 */
export async function sendToRecycleBin(dir) {
  const target = String(dir || '').trim();
  if (!target) return { ok: false, message: '没有指定目录' };
  if (!fs.existsSync(target)) return { ok: false, message: '目录不存在：' + target };
  // PowerShell 单引号拼接路径（双引号会把路径里的 \n / \t 当转义字符）—— 路径里的单引号写成 ''
  const safe = target.replace(/'/g, "''");
  const ps =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('" + safe + "','OnlyErrorDialogs','SendToRecycleBin')";
  const r = await runPs(ps);
  if (!r.ok) {
    const msg = String(r.err || r.out || '').trim();
    return { ok: false, message: msg ? /被占用|正在使用|used by another/i.test(msg) ? '目录正被占用（请先关掉配置器窗口再试）：' + msg : msg : '移入回收站失败' };
  }
  return { ok: true };
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
