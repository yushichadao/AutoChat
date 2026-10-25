import { evaluateSteps, summarize } from '../../tasks/setup.js';

/**
 * 首启向导接口：给界面一套「每步什么状态、缺什么、下一步做什么」。
 * 与命令行向导共用 src/tasks/setup.js 的判断，不会两边说法不一致。
 */
export const routes = {
  'GET /api/onboarding': async ({ rootDir }) => {
    const steps = await evaluateSteps({ rootDir });
    return { status: 200, body: { steps, summary: summarize(steps) } };
  },
};
