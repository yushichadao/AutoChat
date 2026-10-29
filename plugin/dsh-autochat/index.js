import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { setHome } from './lib/cli.js';
import { createSkillProvider } from './lib/skill.js';
import { TOOL_SPECS, runTool } from './lib/tools.js';

/**
 * AutoChat 的 DeepSeek Harness 插件。
 *
 * 定位：**外壳 + 拦截器**，不是第二套 AutoChat。
 *   · 所有判定（七步够不够）与落盘（.env / config.json）仍然由 AutoChat 本体的
 *     `src/tasks/` 完成 —— 插件把动作翻译成一次 `autochat` CLI 调用。
 *   · 插件额外做一件本体不做的事：**在根本性配置没走完时拦住写操作**，
 *     避免出现「服务起来了但根本不可能回消息」这种假就绪。
 */

/** Cordis 插件名（不是模型看到的工具名）。 */
export const name = 'autochat';

/** 需要的服务：工具注册表 + 技能注册表。 */
export const inject = ['tools', 'skills'];

/**
 * 插件配置。
 * `home` 可指定 AutoChat 安装目录（要含 src/cli/index.js）；
 * 留空时按 AUTOCHAT_HOME → 从插件目录往上找 → 常见安装位置 的顺序自动认。
 */
export const Config = Schema.object({
  home: Schema.string().default(''),
});

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{home?: string}} config 插件配置（已按 Config 校验并补默认值）
 */
export function apply(ctx, config) {
  // 先认目录：配置优先，其次环境变量 AUTOCHAT_HOME，最后自动探测。
  const home = (config && typeof config.home === 'string' ? config.home : '').trim();
  setHome(home);

  for (const spec of TOOL_SPECS) {
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters || {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
          return runTool(spec.name, args || {});
        },
      })
    );
  }

  ctx.skills.registerProvider(() => createSkillProvider());
}
