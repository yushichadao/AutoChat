import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createLogger } from '../core/logger.js';
import { ROOT } from '../core/paths.js';
import { detectWeChat, listWeChatProcesses, hasModuleLoaded, isPortOpen } from './process.js';
import { injectDll, deployProxyDll, killWeChat, launchWeChat, isElevated } from './injector.js';
import { detectBuiltinDll } from '../tasks/autodll.js';
import { HookClient } from './hook-client.js';
import { PROFILES, describeSupport } from './profiles.js';
import { writeEditableEnv } from '../tasks/config.js';

/** '4.1.10.27' → [4,1,10,27]，解析失败的项记 0。 */
function parts(version) {
  return String(version || '').split('.').map((n) => {
    const v = parseInt(n, 10);
    return Number.isFinite(v) ? v : 0;
  });
}

/**
 * 选「要重装到的目标微信版本」：从 PROFILES 里挑与本机版本同系列、且最接近的那条。
 * 找不到同系列就退而求其次取全局最接近。返回的是 profile（含 .wechat / .dll）。
 */
export function pickReinstallTarget(version) {
  const cur = parts(version);
  const sameMajor = PROFILES.filter((p) => parts(p.wechat)[0] === cur[0]);
  const pool = sameMajor.length ? sameMajor : PROFILES;
  let best = pool[0];
  let bestDist = Infinity;
  for (const p of pool) {
    const q = parts(p.wechat);
    const dist =
      Math.abs((q[0] - cur[0]) * 1e9 + (q[1] - cur[1]) * 1e6 + (q[2] - cur[2]) * 1e3 + (q[3] - cur[3]));
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  return best;
}

/** 以管理员权限启动本地微信安装包（逆版本安装）。不阻塞、不等安装完成。 */
function launchInstaller(p) {
  return new Promise((resolve) => {
    const safe = String(p).replace(/'/g, "''");
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${safe}' -Verb RunAs`],
      { windowsHide: true },
      () => resolve()
    );
  });
}

/** 项目的 Releases 页：便携发布包（含与 hook DLL 对应版本的获取指引）都在这里。 */
const RELEASES_URL = 'https://github.com/yushichadao/AutoChat/releases';

/** 文件 sha256，读不到返回 null（被占用/不存在不抛错）。 */
export function fileHash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 判断 inject 模式是否必须先改走代理模式（部署正确 DLL + 重启微信）。
 *
 * 微信启动只加载安装目录下的 version.dll；运行时不重启地注入，若装目录那份
 * 与「该微信版本该用的 DLL」不一致，会被旧的那份抢走 30001 端口、读不到数据。
 * 因此只要安装目录那份不是正确的，就必须经代理模式重新部署并重启。
 *
 * `hash` 返回 null 视为「文件不存在 / 读不到」——默认用 sha256，单测可注入。
 *
 * @returns {{use:boolean, dllPath?:string, reason?:string}}
 */
export function needsProxyDeploy({ installDir, configured, expected, hash = fileHash } = {}) {
  const deployed = installDir ? path.join(installDir, 'version.dll') : '';
  const d = hash(deployed);
  const e = expected ? hash(expected) : null;
  const c = configured ? hash(configured) : null;

  // 装错版本：必须部署正确的那份（配置恰好就是正确版就用配置，否则用内置匹配版）
  if (d && e && d !== e) {
    const dllPath = (c && c === e) ? configured : expected;
    return { use: true, dllPath, reason: '安装目录 hook DLL 与微信版本不匹配' };
  }
  // 安装目录那份与配置不一致（版本未必错，但抢端口的会是目录那份）
  if (d && c && c !== d) {
    return { use: true, dllPath: configured, reason: '安装目录 hook DLL 与配置不一致' };
  }
  return { use: false };
}

/**
 * 对应常见 hook 管理器的做法：
 * 找到微信进程 → 注入 hook DLL → 等进程内的 HTTP 就绪。
 */
export class HookLifecycle {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    this.install = null;
    this.pid = null;
    this.injection = null;
  }

  async resolveInstall() {
    if (this.install) return this.install;
    this.install = await detectWeChat(this.cfg.installDir);
    if (!this.install) throw new Error('找不到微信安装目录，请设置 WX_INSTALL_DIR');
    this.log.info(`微信 ${this.install.version || '未知版本'} → ${this.install.exe}`);
    return this.install;
  }

  async waitForPort(timeoutMs = this.cfg.readyTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isPortOpen(this.cfg.host, this.cfg.port)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** proxy 模式：DLL 以 version.dll 形式放进安装目录，重启微信由系统加载。 */
  async applyProxyMode(reason = '') {
    if (reason) this.log.warn(`运行时注入未成功（${reason}），改用代理模式`);
    if (!this.cfg.dllPath) throw new Error('代理模式需要 WX_DLL_PATH');

    const install = await this.resolveInstall();
    const target = await deployProxyDll(install.dir, this.cfg.dllPath);
    this.log.info(`已部署 ${target}，正在重启微信`);

    await killWeChat(this.cfg.processName);
    await new Promise((r) => setTimeout(r, 1500));

    const args = [`StartPort=${this.cfg.port}`];
    if (this.cfg.receiveMode !== 'poll') {
      // DLL 在本机回调，用回环地址；token 只能靠 URL 传（DLL 不会带自定义请求头）
      const host = this.cfg.webhookBind === '0.0.0.0' ? '127.0.0.1' : this.cfg.webhookBind || '127.0.0.1';
      let url = `http://${host}:${this.cfg.webhookPort}/wechat`;
      if (this.cfg.webhookToken) url += `?token=${encodeURIComponent(this.cfg.webhookToken)}`;
      args.push(`CallBackURL=${url}`);
    }
    await launchWeChat(install.exe, args);

    if (!(await this.waitForPort())) throw new Error(`${this.cfg.readyTimeoutMs}ms 内 hook 端口未就绪`);
    this.log.info(`hook 服务已就绪 http://${this.cfg.host}:${this.cfg.port}`);
    return { mode: 'proxy', target };
  }

  /** inject 模式：对已登录的微信进程直接注入，不重启。 */
  async applyInjectMode() {
    if (!this.cfg.dllPath) throw new Error('inject 模式需要 WX_DLL_PATH');
    if (!fs.existsSync(this.cfg.dllPath)) throw new Error(`DLL 不存在: ${this.cfg.dllPath}`);

    const install = await this.resolveInstall();

    // 微信启动只加载安装目录下的 version.dll。若那份不是该版本该用的 DLL，
    // 运行时不重启地注入会被旧那份抢端口、读不到数据 —— 必须先部署正确 DLL 并重启。
    const builtin = await detectBuiltinDll(ROOT, install.dir).catch(() => null);
    const decision = needsProxyDeploy({
      installDir: install.dir,
      configured: this.cfg.dllPath,
      expected: builtin && builtin.path,
    });
    if (decision.use) {
      if (decision.dllPath && decision.dllPath !== this.cfg.dllPath) {
        this.log.info(`改用正确 DLL 部署：${decision.dllPath}`);
        this.cfg.dllPath = decision.dllPath;
      }
      return this.applyProxyMode(decision.reason);
    }

    let procs = await listWeChatProcesses(this.cfg.processName);
    if (!procs.length) {
      this.log.warn('微信未运行，先启动它');
      await launchWeChat(install.exe);
      await new Promise((r) => setTimeout(r, 8000));
      procs = await listWeChatProcesses(this.cfg.processName);
    }
    if (!procs.length) throw new Error('仍未发现微信主进程');

    const dllName = path.basename(this.cfg.dllPath);
    for (const proc of procs) {
      const loaded = await hasModuleLoaded(proc.pid, dllName);
      if (loaded) {
        this.log.info(`进程 ${proc.pid} 已加载 ${dllName}，跳过注入`);
        this.pid = proc.pid;
        break;
      }
      const elevated = await isElevated();
      if (!elevated) this.log.warn('当前不是管理员权限，注入大概率会失败');
      const res = await injectDll(proc.pid, this.cfg.dllPath);
      if (res.ok) {
        this.log.info(`已注入进程 ${proc.pid}（模块句柄 ${res.detail}）`);
        this.pid = proc.pid;
        break;
      }
      this.log.warn(`注入进程 ${proc.pid} 失败: ${res.detail}`);
    }

    if (!this.pid) return { ok: false, reason: '所有进程注入失败' };
    if (!(await this.waitForPort())) return { ok: false, reason: '注入后 hook 端口未就绪' };
    this.log.info(`hook 服务已就绪 http://${this.cfg.host}:${this.cfg.port}`);
    return { ok: true, pid: this.pid };
  }

  /**
   * 一键自动补齐：检测「微信版本」和「hook DLL」哪里不对，就补哪里。
   *  - 微信完全没装 → 引导安装（不内置、不下载微信安装包）。
   *  - 微信版本不被精确支持 → 若配了 WX_INSTALLER_PATH 就启动对应版本安装包（用户完成安装后回来）；
   *    否则给出精确到版本的引导（指向官方 / GitHub Releases 获取方式）。
   *  - hook DLL 装错 / 没装 → 部署项目匹配的 DLL 并重启微信（proxy 模式，已含注入兜底）。
   *  - 最后用 IsLogin 验证是否真的可用。
   */
  async autoRepair() {
    const steps = [];
    const install = await this.resolveInstall().catch(() => null);
    const version = (install && install.version) || '';
    const support = describeSupport(version);

    // ① 微信完全没装 → 引导安装
    if (!version) {
      return {
        ok: false,
        phase: 'wechat-missing',
        steps,
        releaseUrl: RELEASES_URL,
        message:
          '本机没检测到微信。请先安装微信（建议装到与 hook DLL 匹配的版本），' +
          '再去 GitHub Releases 获取「与 hook DLL 对应版本的 AutoChat 便携发布包」。装完回来点「重新修复」。',
      };
    }

    // ② 微信版本不被精确支持 → 重装对应版本
    if (support.level !== 'exact') {
      const target = pickReinstallTarget(version);
      // 兜底：目标版本与当前一致＝逻辑矛盾（精确支持却走到这里），绝不能让用户「重装到同一个版本」
      if (target && target.wechat === version) {
        return {
          ok: false,
          phase: 'wechat',
          steps,
          targetVersion: version,
          releaseUrl: RELEASES_URL,
          message:
            `微信 ${version} 已有适配档案（${target.dllLabel || target.dll}），不该走到「重装」这一步。\n` +
            `这通常是修复流程的内部判断出错，请运行 autochat doctor 看具体卡在哪一项，并把日志带去反馈。`,
        };
      }
      const inst = this.cfg.installerPath;
      const hasConfigured = Boolean(inst);
      const envLine = 'WX_INSTALLER_PATH=D:\\downloads\\WeChatSetup-' + target.wechat + '.exe';
      if (!inst || !fs.existsSync(inst)) {
        return {
          ok: false,
          phase: 'wechat',
          steps,
          targetVersion: target.wechat,
          envLine,
          releaseUrl: RELEASES_URL,
          message:
            `微信 ${version} 不在支持列表（最近适配：${target.wechat} → ${target.dllLabel || target.dll}，${target.license}）。\n` +
            (hasConfigured
              ? `你 .env 里的 WX_INSTALLER_PATH 指向「${inst}」，但该文件不存在 —— 请确认路径正确，或换成已下载好的安装包路径（在下方「微信安装包」里改并保存）。\n`
              : `需要重装到 ${target.wechat}：\n` +
                `1) 去 GitHub Releases 获取「与 hook DLL 对应版本的 AutoChat 便携发布包」（其说明里给出微信安装包获取方式）；\n` +
                `2) 把安装包路径填到 .env：\n${envLine}\n`) +
            `本工具不内置、不转发微信安装包。`,
        };
      }
      steps.push(`启动微信安装包，重装到 ${target.wechat}：${inst}`);
      await launchInstaller(inst);
      return {
        ok: false,
        phase: 'wechat-install',
        needsUser: true,
        targetVersion: target.wechat,
        envLine,
        releaseUrl: RELEASES_URL,
        steps,
        message:
          `已启动微信安装包（可能弹 UAC）。请完成安装：先退出微信并备份聊天记录 → 安装 ${target.wechat} → ` +
          `装完回到这里点「重新修复 / 刷新」。`,
      };
    }

    // ③ DLL 不对 → 部署项目匹配的 DLL（并重启微信）
    const builtin = await detectBuiltinDll(ROOT, install && install.dir).catch(() => null);
    const want = (builtin && builtin.path) || '';
    const dllPath = this.cfg.dllPath || want;
    if (!dllPath) {
      return {
        ok: false,
        phase: 'dll',
        steps,
        message: `找不到与微信 ${version} 匹配的 hook DLL；需要自备同版本 DLL，或补充该版本的内置方案。`,
      };
    }
    if (dllPath !== this.cfg.dllPath) {
      // 把 WX_DLL_PATH 自动指到匹配的那份，省得用户手动改
      this.cfg.dllPath = dllPath;
      try { await writeEditableEnv({ WX_DLL_PATH: dllPath }); } catch { /* 非致命 */ }
    }

    const dec = needsProxyDeploy({ installDir: install && install.dir, configured: dllPath, expected: want });
    if (dec.use) {
      this.log.warn(`${dec.reason} → 部署正确 DLL 并重启微信`);
      await this.applyProxyMode(dec.reason);
      steps.push(`已部署 ${dllPath} 并重启微信`);
    } else {
      steps.push('安装目录的 DLL 已与微信版本匹配，无需重部署');
    }

    // ④ 终极校验：读 IsLogin
    const login = await this.verifyLogin();
    steps.push(
      login === true ? 'hook 已就绪且微信已登录（IsLogin=1）'
        : login === false ? 'hook 已就绪，但微信未登录（IsLogin=0）—— 请先在微信里登录'
        : 'hook 未响应，无法确认登录态'
    );
    // message 必须给全：ok=false 却 message 为空时，界面只能弹「未能自动修复」，
    // 用户完全不知道卡在哪（曾真实出现：DLL 已就位、只是 hook 没响应）。
    const why =
      login === true
        ? ''
        : login === false
          ? `hook 已就绪但微信未登录（IsLogin=0）`
          : `hook 端口 ${this.cfg.host}:${this.cfg.port} 在 ${this.cfg.readyTimeoutMs}ms 内没有响应`;
    return {
      ok: login === true,
      phase: 'done',
      login,
      steps,
      message:
        login === true
          ? `微信 ${version} + ${path.basename(dllPath)} 已就位，hook 可用且已登录。`
          : `${why}。` +
            (login === false
              ? '请先在这个微信里登录，然后点「重新修复」。'
              : '请确认微信正在运行；若刚部署过 DLL，需要完全退出微信（含托盘）后重新打开。'),
    };
  }

  /** 轮询 hook 状态接口，读 IsLogin。最多等 readyTimeoutMs。 */
  async verifyLogin(timeoutMs = this.cfg.readyTimeoutMs) {
    const hook = new HookClient({
      host: this.cfg.host,
      port: this.cfg.port,
      endpoints: this.cfg.endpoints,
      dbQueryTimeoutMs: 3000,
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await hook.confirmLogin(3000).catch(() => null);
      if (r === true) return true;
      if (r === false) return false; // 明确未登录（IsLogin=0 且读不到本机账号）
      await new Promise((res) => setTimeout(res, 1000));
    }
    return null;
  }

  async start() {
    const install = await this.resolveInstall();
    if (install.major && install.major < 4) {
      this.log.warn(`当前微信 ${install.version} 是 3.x，DLL 需要对应 3.x 版本，别混用 4.x 的`);
    }

    if (this.cfg.mode === 'proxy') return this.applyProxyMode();

    const injected = await this.applyInjectMode();
    if (injected.ok) return injected;
    // inject 失败不再静默切换代理模式：proxy 会 kill 微信并重启、改变登录态，可能出乎用户意料。
    // 明确报错并交由用户决定（例如改 WX_INJECT_MODE=proxy 或排查 DLL / 管理员权限）。
    this.log.error(`注入失败，未自动切换代理模式（避免意外重启微信改变登录态）：${injected.reason}`);
    return injected;
  }
}

export { createLogger };
