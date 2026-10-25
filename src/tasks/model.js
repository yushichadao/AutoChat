/**
 * 模型接入任务（任务层）。
 *
 * 职责边界：把「模型能不能连上、有哪些模型可用、有哪些服务商可选」这组能力
 * 收在一处，CLI 与图形化配置器共用同一套探测与错误翻译。
 */

export {
  listModels,
  testChat,
  discoverLocal,
  explainError,
  reviewConfig,
} from '../ai/probe.js';

export { groupedProviders } from '../ai/providers.js';
