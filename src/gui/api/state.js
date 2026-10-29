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

  // 群可用性（HI7）：与 /api/diagnose（环境 / 基础设施）并列的独立检查，
  // 只回答「哪些群在听 / 表可达 / 未启用」，输入仅来自 effectivePollChats，绝不自动发现群。
  'GET /api/chat-availability': async ({ rootDir }) => {
    const { checkChatAvailability } = await import('../../tasks/doctor.js');
    const r = await checkChatAvailability({ rootDir });
    return { status: 200, body: r };
  },
};
