import { groupedProviders, listModels, testChat, discoverLocal, reviewConfig } from '../../tasks/model.js';
import { modelServiceStatus, startModelService, stopModelService } from '../../tasks/model-service.js';
import { loadConfig } from '../../core/config.js';

/**
 * 模型相关接口：服务商预设、本机发现、模型列表、配置点评、连通性测试、本地模型服务启停。
 */
export const routes = {
  'GET /api/ai/providers': async () => ({ status: 200, body: { groups: groupedProviders() } }),

  'GET /api/ai/discover': async () => ({ status: 200, body: { found: await discoverLocal() } }),

  'POST /api/ai/models': async ({ body }) => {
    const b = await body();
    const r = await listModels({ baseUrl: b.base, apiKey: b.key || '' });
    return { status: 200, body: r };
  },

  'POST /api/ai/review': async ({ body }) => {
    const b = await body();
    return { status: 200, body: { tips: reviewConfig({ baseUrl: b.base, apiKey: b.key, model: b.model }) } };
  },

  'POST /api/ai/test': async ({ body }) => {
    const b = await body();
    const r = await testChat({
      baseUrl: b.base,
      apiKey: b.key || '',
      model: b.model,
      timeoutMs: Number(b.timeoutMs) || 20000,
    });
    return { status: 200, body: r };
  },

  'GET /api/model-service': async ({ rootDir }) => {
    const cfg = loadConfig({ rootDir });
    const r = await modelServiceStatus({ rootDir, baseUrl: cfg.ai.baseUrl });
    return { status: 200, body: r };
  },

  'POST /api/model-service/start': async ({ rootDir, body }) => {
    const b = await body();
    const cfg = loadConfig({ rootDir });
    const r = await startModelService({
      rootDir,
      runnerId: b.runner || '',
      baseUrl: cfg.ai.baseUrl,
      cmd: b.cmd || '',
    });
    return { status: 200, body: r };
  },

  'POST /api/model-service/stop': async ({ rootDir }) => {
    const r = await stopModelService({ rootDir });
    return { status: 200, body: r };
  },
};
