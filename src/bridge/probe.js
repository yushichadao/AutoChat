import http from 'node:http';

/**
 * 能力探测：不去猜 DLL 是哪一家，直接试接口。
 * 换一个厂商的 DLL 时，这里能自动认出它支持哪些能力，
 * 不需要用户改配置里的 endpoint。
 */

const CANDIDATES = [
  { key: 'status', method: 'GET', path: '/QueryDB/status', body: undefined, readonly: true, expect: (j) => j && 'IsLogin' in j },
  { key: 'selfProfile', method: 'POST', path: '/GetSelfProfile', body: {}, readonly: true, expect: (j) => j && typeof j === 'object' },
  { key: 'queryDb', method: 'POST', path: '/QueryDB/execute', body: { optDbName: 'MicroMsg.db', SQL: 'SELECT 1' }, readonly: true, expect: null },
  // 发送类默认不探：这类接口是写操作，某些实现不校验字段就会真的发出去
  { key: 'sendText', method: 'POST', path: '/SendTextMsg', body: {}, readonly: false, expect: null },
  { key: 'sendImage', method: 'POST', path: '/SendImgMsg', body: {}, readonly: false, expect: null },

  { key: 'sendXml', method: 'POST', path: '/ForwardXMLMsg', body: {}, readonly: false, expect: null },
];

function call(host, port, method, path, body, timeoutMs = 2000) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path,
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
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, text: '', json: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 探测一个端口上跑的是哪套 hook。
 * 发送类接口不能真的调用（会往外发消息），所以只看 HTTP 状态：
 * 有响应且不是 404 就算存在。
 */
export async function probeHook(host, port, { includeWrite = false } = {}) {
  const found = {};
  const detail = {};

  for (const c of CANDIDATES) {
    if (!c.readonly && !includeWrite) continue;
    if (c.expect === null) {
      // 发送类：发一个必然被拒的空请求，只看路由是否存在
      const r = await call(host, port, c.method, c.path, c.body, 1500);
      if (r.status !== 0 && r.status !== 404) found[c.key] = true;
      detail[c.key] = { status: r.status };
      continue;
    }
    const r = await call(host, port, c.method, c.path, c.body, 1500);
    const ok = r.status >= 200 && r.status < 300 && (!c.expect || c.expect(r.json));
    if (ok) found[c.key] = true;
    detail[c.key] = { status: r.status, sample: r.text.slice(0, 120) };
  }

  const any = Object.keys(found).length > 0;
  return {
    reachable: any,
    capabilities: found,
    detail,
    /** 只有 status 通 = 只读型 DLL；含 sendText = 可发 */
    /** undefined 表示没探（发送类默认不探），false 表示明确探过且不存在 */
    canSend: includeWrite ? Boolean(found.sendText) : undefined,
    canReceivePush: Boolean(found.status),
    canQueryDb: Boolean(found.queryDb),
  };
}

export { CANDIDATES };
