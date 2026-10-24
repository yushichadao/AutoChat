import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { detectWeChat } from '../src/bridge/process.js';
import { loadConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const purge = args.includes('--purge');
const force = args.includes('--force');
const log = (m) => console.log(m);

// 从 .env 里读 WX_DLL_PATH / WX_INSTALL_DIR（不读的话会误判 version.dll 是谁部署的）
let cfg = {};
try {
  cfg = loadConfig();
} catch {
  /* .env 坏了就退回环境变量 */
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sameFile(a, b) {
  try {
    return fs.statSync(a).size === fs.statSync(b).size && sha256(a) === sha256(b);
  } catch {
    return false;
  }
}

/** 1. 还原 version.dll */
function restoreDll(installDir) {
  if (!installDir) {
    log('  [跳过] 找不到微信安装目录，无法定位 version.dll');
    return false;
  }
  const target = path.join(installDir, 'version.dll');
  const backup = `${target}.bak`;
  if (!fs.existsSync(target)) {
    log('  [跳过] 目录下没有 version.dll，无需还原');
    return false;
  }
  if (fs.existsSync(backup)) {
    log('  还原 version.dll ← version.dll.bak');
    if (!dryRun) fs.copyFileSync(backup, target);
    return true;
  }
  // 没有备份：只有当它就是我们部署的那份（与 WX_DLL_PATH 同哈希）才敢删
  const configured = cfg.wechat?.dllPath || process.env.WX_DLL_PATH || '';
  if (configured && fs.existsSync(configured) && sameFile(target, configured)) {
    if (!force) {
      log('  [!] 这份 version.dll 与 WX_DLL_PATH 一致（是我们部署的）。确认要删除请加 --force');
      return false;
    }
    log('  删除我们部署的 version.dll（与 WX_DLL_PATH 一致）');
    if (!dryRun) fs.rmSync(target, { force: true });
    return true;
  }
  log('  [!] version.dll 没有备份且与 WX_DLL_PATH 不一致，已保留，请人工确认');
  return false;
}

/** 2. 解除微信更新通道阻断 */
function restoreUpdateChannel() {
  const upDir = path.join(process.env.APPDATA || '', 'Tencent', 'xwechat', 'update');
  if (!fs.existsSync(upDir)) {
    log('  [跳过] 未找到 update 路径，无需处理');
    return false;
  }
  const st = fs.statSync(upDir);
  if (st.isDirectory()) {
    log('  [跳过] update 本来就是目录，更新通道未被阻断');
    return false;
  }
  log('  解除微信更新通道阻断（删除只读占位文件）');
  if (!dryRun) {
    try {
      fs.rmSync(upDir, { force: true });
      fs.mkdirSync(upDir, { recursive: true });
    } catch (err) {
      log(`  [!] 解除失败: ${err.message}（请手动删除 ${upDir}）`);
      return false;
    }
  }
  return true;
}

/** 3. 清运行时状态 */
function purgeData() {
  const dir = path.join(ROOT, 'data');
  if (!fs.existsSync(dir)) {
    log('  [跳过] 没有 data/ 目录');
    return false;
  }
  log('  删除 data/（含 AI 上下文、方言缓存、版本记忆）');
  if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

const install = await detectWeChat(cfg.wechat?.installDir || process.env.WX_INSTALL_DIR || '');
log('');
log('==== AutoChat 卸载 / 还原 ====');
if (dryRun) log('（演练模式，不会真的改动任何文件）');
log('');
log('1) 微信安装目录');
log(`   ${install?.dir || '(未找到)'}`);
log('2) 还原 version.dll');
restoreDll(install?.dir);
log('3) 恢复微信更新通道');
restoreUpdateChannel();
if (purge) {
  log('4) 清理运行时数据');
  purgeData();
}
log('');
log('提醒：');
log('  · 微信进程里可能还驻留着已注入的 hook DLL，重启微信即可清除');
log('  · 恢复更新通道后微信会自动升级到最新版，届时需重新匹配 hook 方案');
log('  · 如需保留上下文，删除 data/ 前请自行备份');
log('');
process.exit(0);
