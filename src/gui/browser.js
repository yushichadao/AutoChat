import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../core/paths.js';

/**
 * 打开图形化配置器界面（图形化配置器）。
 *
 * 关键体验：永远用「固定的浏览器 + 独立用户数据目录」单开独立窗口，
 * 不在用户正在用的默认浏览器里新建标签页，也不跨浏览器乱开。
 */

/** 找一个可用的浏览器可执行文件。 */
export function findBrowser() {
  const which = (cmd) => {
    try {
      const r = spawnSync('where', [cmd], { windowsHide: true });
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      return first && fs.existsSync(first) ? first : null;
    } catch {
      return null;
    }
  };
  const exists = (p) => (fs.existsSync(p) ? p : null);
  if (process.platform === 'win32') {
    const list = [
      () => which('msedge'),
      () => which('chrome'),
      () => which('chromium'),
      () => exists('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'),
      () => exists('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'),
      () => exists('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
      () => exists('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const f of list) {
      const r = f();
      if (r) return r;
    }
    return null;
  }
  if (process.platform === 'darwin') {
    for (const p of [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const r = exists(p);
      if (r) return r;
    }
    return null;
  }
  for (const c of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    const r = which(c);
    if (r) return r;
  }
  return null;
}

/** 打开界面；返回 true 表示是自己开的独立窗口。 */
export function openUi(url, windowMode) {
  if (!windowMode) return false;
  const profile = path.join(ROOT, 'data', 'gui-browser');
  const exe = findBrowser();
  if (exe) {
    try {
      const child = spawn(
        exe,
        ['--new-window', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', url],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
      return true;
    } catch {
      /* 落到回退 */
    }
  }
  const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(opener, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}
