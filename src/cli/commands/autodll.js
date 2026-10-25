import { ROOT } from '../../core/paths.js';
import { section, line, json, hint, next } from '../ui.js';
import { detectBuiltinDll } from '../../tasks/autodll.js';
import { writeEditableEnv } from '../../tasks/config.js';

/**
 * autochat autodll —— 按本机微信版本自动匹配内置 hook DLL。
 */
export async function run(ctx) {
  const r = await detectBuiltinDll(ROOT);
  if (ctx.flag('json')) {
    json(r);
    return;
  }

  section('hook DLL 自动匹配');
  if (!r.version) {
    line('bad', '没找到微信客户端', '确认已安装 Windows 版微信，或在 .env 里填 WX_INSTALL_DIR');
    return;
  }
  line('ok', '微信版本', r.version);
  if (!r.path) {
    line('warn', '没有匹配的内置 DLL', '这个版本暂无内置方案，需要自己准备匹配的 hook DLL');
    hint('把 DLL 路径填进 .env 的 WX_DLL_PATH');
    return;
  }
  line('ok', '匹配到', r.path);
  if (ctx.flag('write')) {
    const w = writeEditableEnv({ WX_DLL_PATH: r.path }, ROOT);
    line('ok', '已写入 .env', w.changed.join('、'));
    next('重启助手服务后生效');
  } else {
    next('写入配置：autochat autodll --write');
  }
}
