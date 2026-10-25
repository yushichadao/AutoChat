import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from '../core/logger.js';
import { detectWeChat, listWeChatProcesses, hasModuleLoaded, isPortOpen } from './process.js';
import { injectDll, deployProxyDll, killWeChat, launchWeChat, isElevated } from './injector.js';

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
