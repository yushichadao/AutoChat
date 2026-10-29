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
/** 与 src/core/config.js 的 WX_EP_* 默认值保持一致，供没传 endpoints 的调用方兜底。 */
export const DEFAULT_ENDPOINTS = {
  sendText: '/SendTextMsg',
  sendImage: '/SendImgMsg',
  sendFile: '/SendFileMsg',
  sendXml: '/ForwardXMLMsg',
  selfProfile: '/GetSelfProfile',
  status: '/QueryDB/status',
  queryDb: '/QueryDB/execute',
};
export class HookClient {
  constructor({ host, port, endpoints, logger, dialect, dbName = 'message_0.db', dbQueryTimeoutMs = 15000 } = {}) {
    this.host = host;
    this.port = port;
    // 忘传 endpoints 时不能留 undefined：this.ep.status 会抛 TypeError，
    // 被 ping() 吞成「连不上」，最后上层只能报「未能自动修复」。
    this.ep = { ...DEFAULT_ENDPOINTS, ...(endpoints || {}) };
    this.log = logger;
    this.dialect = dialect || null;
    this.dbName = dbName;
    this.dbQueryTimeoutMs = dbQueryTimeoutMs;
    this.seq = 0;
    /** 已知会话列表（chatroom / 好友 wxid），由上层（receiver）注入，用于快速精准反推本机 wxid */
    this.chatIds = [];
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
  /**
   * 读本机微信资料（昵称 + wxid）。
   * 不同 DLL 返回的字段名不一致：wxid / username / account / user_name / wxid_ 都接受。
   * 兜底链（用于 /GetSelfProfile 返回空、且旧版 MicroMsg.db 不存在的新版微信，如 version-ac）：
   *   1) hook 直读；2) 本地库反推 wxid（Message / MicroMsg.db / 消息库）；3) contact.db 反查昵称。
   * 这样无论换哪个号、哪个 DLL，都能自动识别本机身份，无需手工配置 WX_SELF_ID / WX_SELF_NAME。
   */
  async selfProfile() {
    const r = await this.request('POST', this.ep.selfProfile, {});
    const j = r.json;
    let wxid = j && typeof j === 'object'
      ? String(j.wxid ?? j.username ?? j.account ?? j.user_name ?? j.wxid_ ?? '').trim()
      : '';
    let nickname = j && typeof j === 'object'
      ? String(j.nickname ?? j.name ?? j.nick ?? '').trim()
      : '';
    if (!wxid) {
      try { wxid = await this.selfAccount(); } catch { /* 走下面的兜底 */ }
    }
    if (wxid && !nickname) {
      try { nickname = await this.selfNicknameFromContact(wxid); } catch { /* 留空 */ }
    }
    if (!wxid && !nickname) return null;
    return { wxid, nickname, raw: j || {} };
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
  async selfAccount(timeoutMs = 8000) {
    const tries = [
      { db: 'Message', sql: 'SELECT StrAccount AS wxid FROM Message LIMIT 1' },
      { db: 'MicroMsg.db', sql: 'SELECT value AS wxid FROM userinfo WHERE id=1' },
      { db: 'MicroMsg.db', sql: 'SELECT username AS wxid FROM userinfo WHERE id=1' },
    ];
    const pick = (row) =>
      String(row?.wxid || row?.StrAccount || row?.username || row?.account || row?.value || '').trim();
    for (const { db, sql } of tries) {
      try {
        const r = await this.request('POST', this.ep.queryDb, { optDbName: db, SQL: sql }, timeoutMs);
        const rows = Array.isArray(r?.json?.data) ? r.json.data : Array.isArray(r?.json) ? r.json : [];
        const wxid = pick(rows?.[0]);
        if (wxid) return wxid;
      } catch {
        /* 这个库/SQL 打不开就换下一个 */
      }
    }
    // 新版本微信（如 version-ac）：/GetSelfProfile 失效且没 MicroMsg.db，
    // 改从消息库反推本机 wxid（status=2 的消息是“本机发出”，其 real_sender_id 即本机账号）。
    try {
      const wxid = await this.detectSelfFromMessages(timeoutMs);
      if (wxid) return wxid;
    } catch {
      /* 忽略，返回空交给上层 */
    }
    return '';
  }

  /**
   * 从消息库反推本机 wxid（兜底方案，用于 /GetSelfProfile 失效、且无 MicroMsg.db 的新版微信）。
   * 原理：
   *   - 每条消息的 real_sender_id == Name2Id.rowid（发送者在 Name2Id 里的行号）
   *   - status=2 的消息是「本机发出」的，其 real_sender_id 即本机账号在 Name2Id 的 rowid
   *   - 经 Name2Id 反查 user_name 即本机 wxid
   * 优先用注入的已知会话（this.chatIds）精准查询；否则扫描 message_0..3.db 的前若干张 Msg_* 表，命中即停。
   * @returns {Promise<string>}
   */
  async detectSelfFromMessages(timeoutMs = 8000) {
    const targets = this.chatIds && this.chatIds.length
      ? this.chatIds.map((c) => ({ db: this.dbName, t: chatTable(String(c)) }))
      : await this._scanMsgTables(timeoutMs);
    for (const { db, t } of targets) {
      try {
        const r = await this.request(
          'POST',
          this.ep.queryDb,
          { optDbName: db, SQL: `SELECT real_sender_id AS rid FROM ${t} WHERE status=2 ORDER BY local_id DESC LIMIT 1` },
          timeoutMs
        );
        const rid = r?.json?.data?.[0]?.rid;
        if (rid == null || rid === '0' || rid === 0) continue;
        const r2 = await this.request(
          'POST',
          this.ep.queryDb,
          { optDbName: db, SQL: `SELECT user_name FROM Name2Id WHERE rowid=${Number(rid)} LIMIT 1` },
          timeoutMs
        );
        const wxid = String(r2?.json?.data?.[0]?.user_name || '').trim();
        // 排除聊天室/异常值，确保拿到的是本机个人 wxid
        if (wxid && !wxid.includes('@')) return wxid;
      } catch {
        /* 下一张表 */
      }
    }
    return '';
  }

  /** 扫描 message_0..3.db 的 Msg_* 表名，供 detectSelfFromMessages 在无已知会话时回退使用。 */
  async _scanMsgTables(timeoutMs = 8000) {
    const out = [];
    for (const db of candidateDbs(this.dbName, 4)) {
      try {
        const r = await this.request(
          'POST',
          this.ep.queryDb,
          { optDbName: db, SQL: "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%' LIMIT 40" },
          timeoutMs
        );
        for (const x of Array.isArray(r?.json?.data) ? r.json.data : []) {
          if (x?.name) out.push({ db, t: x.name });
        }
      } catch {
        /* 下个库 */
      }
    }
    return out;
  }

  /**
   * 已知本机 wxid 时，从 contact.db 反查昵称（新版微信的联系人昵称都在这里）。
   * @returns {Promise<string>}
   */
  async selfNicknameFromContact(wxid, timeoutMs = 8000) {
    try {
      const safe = String(wxid).replace(/'/g, "''");
      const r = await this.request(
        'POST',
        this.ep.queryDb,
        { optDbName: 'contact.db', SQL: `SELECT nick_name FROM contact WHERE username='${safe}' LIMIT 1` },
        timeoutMs
      );
      const n = r?.json?.data?.[0]?.nick_name;
      return n ? String(n).trim() : '';
    } catch {
      return '';
    }
  }

  /**
   * 本地消息库是否可解密读取。
   * 微信数据库是 SQLCipher 加密的，只有已登录（拿到密钥）才能打开；
   * 未登录时查询会失败。所以「能读出来」本身就证明已登录，比 IsLogin 字段更可靠。
   * 用 sqlite_master 探表，而非 SELECT 1（后者不碰任何表，未登录也可能成功）。
   * @returns {Promise<boolean>}
   */
  async dbReadable(timeoutMs = 3000) {
    const dbs = candidateDbs('message_0.db').concat(['MicroMsg.db', 'contact.db']);
    for (const db of dbs) {
      try {
        const r = await this.request(
          'POST',
          this.ep.queryDb,
          { optDbName: db, SQL: "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1" },
          timeoutMs
        );
        const rows = Array.isArray(r?.json?.data) ? r.json.data : Array.isArray(r?.json) ? r.json : [];
        if (rows.length) return true;
      } catch {
        /* 这个库打不开就试下一个 */
      }
    }
    return false;
  }

  /**
   * 判断微信是否真的已登录，规避某些 hook DLL 在个别微信版本上把 IsLogin 误报成 0 的假阴性。
   * 取证优先级（任一命中即判已登录）：
   *   1) IsLogin===1
   *   2) /GetSelfProfile 能拿到本机 wxid
   *   3) 本地库里能读到本机账号（selfAccount，兼容各版本库名/表名）
   *   4) 本地消息库可解密读取（dbReadable）—— 未登录时库是加密的读不出
   * 都拿不到 → IsLogin===0 判未登录，缺失判未知(null)
   * @returns {Promise<boolean|null>} true 已登录 / false 未登录 / null 未知（hook 不可达或拿不准）
   */
  async confirmLogin(timeoutMs = 3000) {
    const st = await this.ping().catch(() => ({ ok: false }));
    if (!st.ok) return null;
    const d = st.data || {};
    const login = d.IsLogin ?? d.isLogin ?? d.is_login ?? d.login;
    if (login === 1) return true;
    // IsLogin 在 4.1.10.27 等版本上被 DLL 误报成 0，用更可靠的证据反证：
    try {
      const prof = await this.selfProfile();
      if (prof && prof.wxid) return true;
    } catch {
      /* 换下一个证据 */
    }
    try {
      const wxid = await this.selfAccount(timeoutMs);
      if (wxid) return true;
    } catch {
      /* 换下一个证据 */
    }
    try {
      if (await this.dbReadable(timeoutMs)) return true;
    } catch {
      /* 放弃，按 IsLogin 结论 */
    }
    return login === 0 ? false : null;
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

  /**
   * 发文件（write_doc 等工具生成的 docx / xlsx，§16.4）。
   * DLL 侧未必有该端点：探测不到会返回 ok:false，由 responder 降级为文本，不会卡住回复。
   */
  async sendFile(toWxid, filePath) {
    return this.sendFileLike('file', FILE_PATHS, this.ep?.sendFile, toWxid, { wxidorgid: toWxid, path: filePath });
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
   * 发完消息之后，回查库里多出来的 local_id —— 这些就是「助手自己发的」。
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
