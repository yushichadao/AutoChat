import { startBackground, stopService, serviceStatus } from '../../tasks/service.js';
import { PidFile } from '../../core/pause.js';
import { loadConfig } from '../../core/config.js';

/**
 * 助手服务启停接口（与命令行等价）。
 */
export const routes = {
  'POST /api/service': async ({ rootDir, body }) => {
    const b = await body();
    const { buildState } = await import('../state.js');

    if (b.action === 'stop') {
      const r = await stopService(rootDir);
      // 用户要求「stop 一键全关」：先回 200，再让本配置器进程退场（stopService 已放过当前进程）。
      // 稍等一会儿，确保 HTTP 响应已经发出，不要把正在回的响应掐掉。
      setTimeout(() => process.exit(0), 250).unref?.();
      return { status: 200, body: { ok: r.ok, message: r.message || '', state: await buildState(rootDir) } };
    }

    if (b.action === 'start') {
      const cfg = loadConfig({ rootDir });
      const pidFile = new PidFile({ file: cfg.dataDir + '/autochat.pid' });
      const cur = pidFile.read();
      const st = await serviceStatus(rootDir);
      if (cur && st.running) {
        return { status: 200, body: { ok: true, message: '服务已在运行（pid ' + cur + '）', state: await buildState(rootDir) } };
      }
      const started = await startBackground(rootDir);
      const deadline = Date.now() + 12000;
      let state = await buildState(rootDir);
      while (!state.running && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        state = await buildState(rootDir);
      }
      return {
        status: 200,
        body: { ok: started.ok && state.running, message: started.message || '', state },
      };
    }

    return { status: 400, body: { error: '未知操作' } };
  },
};
