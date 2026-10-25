import { buildState } from '../state.js';

/**
 * 状态与环境体检接口。
 * 约定：每个路由返回 { status, body }，由 server.js 统一写回。
 */
export const routes = {
  'GET /api/state': async ({ rootDir }) => ({
    status: 200,
    body: await buildState(rootDir),
  }),

  'GET /api/diagnose': async ({ rootDir }) => {
    const { diagnose } = await import('../../tasks/doctor.js');
    const r = await diagnose({ rootDir });
    return { status: 200, body: r };
  },
};
