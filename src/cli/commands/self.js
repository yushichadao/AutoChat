import { ROOT } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { section, line, json } from '../ui.js';
import { HookClient } from '../../bridge/hook-client.js';

/**
 * autochat self —— 探测本机微信 wxid（用于识别「自己发的消息」）。
 */
export async function run(ctx) {
  const cfg = loadConfig({ rootDir: ROOT });
  const hook = new HookClient({
    host: cfg.wechat.host,
    port: cfg.wechat.port,
    endpoints: cfg.wechat.endpoints,
    dbName: cfg.wechat.pollDb,
  });

  section('本机 wxid 探测');
  line(cfg.wechat.selfId ? 'ok' : 'warn', 'WX_SELF_ID',
    cfg.wechat.selfId ? cfg.wechat.selfId : '（未配置，将自动获取）');

  let fromProfile = '';
  try {
    const prof = await hook.selfProfile();
    fromProfile = prof && prof.wxid ? prof.wxid : '';
    line(fromProfile ? 'ok' : 'warn', 'hook /GetSelfProfile',
      fromProfile ? fromProfile : '未返回 wxid（DLL 不支持、未登录或字段名不同）');
  } catch (err) {
    line('warn', 'hook /GetSelfProfile', err.message);
  }

  let fromDb = '';
  if (!fromProfile) {
    try {
      fromDb = await hook.selfAccount();
      line(fromDb ? 'ok' : 'warn', '本地库兜底', fromDb ? fromDb : '未查到（表/列名不匹配或库不可读）');
    } catch (err) {
      line('warn', '本地库兜底', err.message);
    }
  }

  const finalId = cfg.wechat.selfId || fromProfile || fromDb;
  if (ctx.flag('json')) {
    json({ selfId: finalId, fromProfile, fromDb, configured: Boolean(cfg.wechat.selfId) });
    return;
  }
  line(finalId ? 'ok' : 'bad', '最终用于排除自己消息的 wxid',
    finalId ? finalId : '（拿不到，会自问自答，建议手填 WX_SELF_ID）');
}
