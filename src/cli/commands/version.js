import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROOT } from '../../core/paths.js';
import { section, line, json } from '../ui.js';

/**
 * autochat version —— 版本与运行环境。
 */
export async function run(ctx) {
  let pkg = { version: '0.0.0', author: '' };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {
    /* 读不到就给默认值 */
  }
  const info = {
    name: 'AutoChat',
    version: pkg.version,
    node: process.version,
    platform: process.platform,
    root: ROOT,
    author: pkg.author || 'Yushichadao',
  };
  if (ctx.flag('json')) {
    json(info);
    return;
  }
  section('AutoChat');
  line('ok', '版本', info.version);
  line('ok', 'Node', info.node);
  line('ok', '平台', info.platform);
  line('ok', '项目目录', info.root);
  line('ok', '作者', info.author);
}
