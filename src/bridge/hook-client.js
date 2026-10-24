import http from 'node:http';
import { TEXT_DIALECTS, TEXT_PATHS, IMAGE_PATHS, FILE_PATHS, orderByLearned } from './dialect.js';
import { chatTable, candidateDbs } from './poll-sql.js';

/**
 * 与注入到微信进程里的 hook DLL 通信。
 * 契约按常见 4.x hook 的本地 HTTP 形态实现：
 *   POST /SendTextMsg  {wxidorgid, msg}
 *   POST /SendImgMsg   {wxidorgid, path}
 *   POST /ForwardXMLMsg{to_wxid, content}
 *   POST /GetSelfProfile
 *   GET  /QueryDB/status
 *   POST /QueryDB/execute {optDbName, SQL}
 * 路径都可以在配置里覆盖，换一个 DLL 只要改 endpoint。
 */
export class HookClient {
  constructor({ host, port, endpoints, logger, dialect, dbName = 'message_0.db', dbQueryTimeoutMs = 15000 } = {}) {
    this.host = host;
    this.port = port;
    this.ep = endpoints;
    this.log = logger;
    this.dialect = dialect || null;
    this.dbName = dbName;
    this.dbQueryTimeoutMs = dbQueryTimeoutMs;
    this.seq = 0;
  }

  request(method, urlPath, body, timeoutMs = 8000) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path: urlPath,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload ? payload.length : 0,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              json = null;
            }
            resolve({ status: res.statusCode, text, json });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`请求超时 ${urlPath}`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async ping() {
    try {
      const r = await this.request('GET', this.ep.status, undefined, 3000);
      return { ok: r.status === 200, data: r.json ?? r.text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 读本机微信资料（昵称 + wxid）。
   * 不同 DLL 返回的字段名不一致：wxid / username / account / user_name / wxid_ 都接受，
   * 取不到就返回 null，由上层走本地库兜底或提示手工配置。
   */
  async selfProfile() {
    const r = await this.request('POST', this.ep.selfProfile, {});
    const j = r.json;
    if (!j || typeof j !== 'object') return null;
    const wxid = String(j.wxid ?? j.username ?? j.account ?? j.user_name ?? j.wxid_ ?? '').trim();
    if (!wxid) return null;
    const nickname = String(j.nickname ?? j.name ?? j.nick ?? '').trim();
    return { wxid, nickname, raw: j };
  }

  /**
   * 兜底查本机账号 wxid。
   *
   * 某些 DLL 的 /GetSelfProfile 在未登录或换版本后会返回空 wxid，
   * 这时可以从本地 Message 库里把 StrAccount 读出来。
   * 拿不到就返回空串，由上层提示用户手工配置 WX_SELF_ID。
   */
  /**
   * 兜底查本机账号 wxid。
   * 不同微信版本/库里本机 wxid 的位置不一样，逐个试：
   *   1) Message 库 StrAccount 列（旧版常见）
   *   2) MicroMsg.db 的 userinfo 表（id=1 的 value，最通用）
   *   3) MicroMsg.db 的 userinfo 表 username 列（部分版本）
   * 字段名同样兼容 wxid / StrAccount / username / account / value。
   * 拿不到就返回空串，由上层提示用户手工配置 WX_SELF_ID。
   */
  async selfAccount() {
    const tries = [
      { db: 'Message', sql: 'SELECT StrAccount AS wxid FROM Message LIMIT 1' },
      { db: 'MicroMsg.db', sql: 'SELECT value AS wxid FROM userinfo WHERE id=1' },
      { db: 'MicroMsg.db', sql: 'SELECT username AS wxid FROM userinfo WHERE id=1' },
    ];
    const pick = (row) =>
      String(row?.wxid || row?.StrAccount || row?.username || row?.account || row?.value || '').trim();
    for (const { db, sql } of tries) {
      try {
        const r = await this.request('POST', this.ep.queryDb, { optDbName: db, SQL: sql }, 8000);
        const rows = Array.isArray(r?.json?.data) ? r.json.data : Array.isArray(r?.json) ? r.json : [];
        const wxid = pick(rows?.[0]);
        if (wxid) return wxid;
      } catch {
        /* 这个库/SQL 打不开就换下一个 */
      }
    }
    return '';
  }

  /**
   * 发文本。路径和字段名都自动试：
   * 命中过的组合排在最前，没命中过就按常见程度依次试。
   * 只有收到明确的失败标志才会换下一个，避免同一条消息被发两次。
   */
  async sendText(toWxid, text) {
    const learned = this.dialect?.get('text');
    const paths = orderedPaths(TEXT_PATHS, learned?.path, this.ep.sendText);
    const dialects = orderByLearned(TEXT_DIALECTS, learned?.dialect);

    let last = null;
    for (const d of dialects) {
      for (const p of paths) {
        const r = await this.request('POST', p, d.build(toWxid, text));
        if (r.status === 404 || r.status === 0) continue; // 端点不存在才试下一个
        // 收到响应后：成功立即返回并记住该方言/路径；业务失败则记录并尝试其余组合。
        // 每个 (方言, 路径) 组合只会 POST 一次，绝不会重复发送同一条消息。
        const res = normalizeSend(r);
        if (res.ok) {
          this.dialect?.set('text', { dialect: d.name, path: p });
          return res;
        }
        last = res;
      }
    }
    return last || { ok: false, message: '没有可用的发送接口' };
  }

  async sendImage(toWxid, filePath) {
    return this.sendFileLike('image', IMAGE_PATHS, this.ep.sendImage, toWxid, { wxidorgid: toWxid, path: filePath });
  }

  async sendFile(toWxid, filePath) {
    return this.sendFileLike('file', FILE_PATHS, this.ep.sendFile, toWxid, { wxidorgid: toWxid, path: filePath });
  }

  async sendFileLike(kind, candidates, configured, toWxid, body) {
    const learned = this.dialect?.get(kind);
    const paths = orderedPaths(candidates, learned?.path, configured);
    let last = null;
    for (const p of paths) {
      const r = await this.request('POST', p, body);
      if (r.status === 404 || r.status === 0) continue;
      const res = normalizeSend(r);
      if (res.ok) {
        this.dialect?.set(kind, { dialect: 'wxidorgid+path', path: p });
        return res;
      }
      last = res;
      break;
    }
    return last || { ok: false, message: `没有可用的 ${kind} 接口` };
  }

  async sendXml(toWxid, xml) {
    const r = await this.request('POST', this.ep.sendXml, { to_wxid: toWxid, content: xml });
    return normalizeSend(r);
  }

  async queryDb(sql, dbName = 'MicroMsg.db', timeoutMs = this.dbQueryTimeoutMs) {
    const r = await this.request('POST', this.ep.queryDb, { optDbName: dbName, SQL: sql }, timeoutMs);
    return r.json;
  }

  /** 某个会话当前的最新消息 id（local_id）。查不到返回 0。 */
  async maxLocalId(chatId) {
    const table = chatTable(chatId);
    const sql = `SELECT MAX(local_id) AS msgid FROM ${table}`;
    try {
      const res = await this.queryDb(sql, this.dbName);
      const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      const n = Number(rows?.[0]?.msgid || 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 发完消息之后，回查库里多出来的 local_id —— 这些就是「机器人自己发的」。
   * 微信写库有延迟，所以轮询几秒；查不到就返回空（靠内容回声兜底）。
   */
  async captureSentIds(chatId, before, { tries = 6, gapMs = 400 } = {}) {
    for (let i = 0; i < tries; i += 1) {
      await new Promise((r) => setTimeout(r, gapMs));
      const max = await this.maxLocalId(chatId);
      if (max > before) {
        // before 未知（0）时只认最后一条，避免把历史全标成自己发的
        if (!before) return [max];
        const ids = [];
        for (let id = before + 1; id <= max; id += 1) ids.push(id);
        return ids;
      }
      if (!max) return []; // 库查不到（没登录 / 表不在 / DLL 不支持），别空耗时间
    }
    return [];
  }
}

/** 学到过的路径排第一（已验证可用），其次是配置的，最后是候选表。 */
function orderedPaths(candidates, learned, configured) {
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  push(learned);
  push(configured);
  for (const p of candidates) push(p);
  return out;
}

/**
 * 判定发送结果。
 * 只有出现明确的失败标志才判失败 —— 宁可把「没看懂」当成功，
 * 也不能因为误判而把同一条消息重发一遍。
 */
function normalizeSend(r) {
  if (r.status !== 200) return { ok: false, message: `HTTP ${r.status}` };
  const j = r.json;
  if (!j || typeof j !== 'object') return { ok: true, message: 'no-body' };

  for (const key of ['ret', 'code', 'errcode']) {
    if (j[key] !== undefined && Number(j[key]) !== 0) {
      return { ok: false, message: j.retmsg || j.msg || j.errmsg || `${key}=${j[key]}` };
    }
  }
  if (j.success === false) return { ok: false, message: j.message || 'success=false' };

  return { ok: true, message: j.retmsg || j.msg || 'success' };
}
