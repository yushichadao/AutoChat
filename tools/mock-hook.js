/**
 * 模拟注入到微信进程里的 hook DLL。
 * 起一个本地 HTTP 服务，接口与 WeChat-Hook 一致，
 * 另外提供 /debug/incoming 用来伪造“微信收到一条消息”（会 POST 到网关的 webhook）。
 *
 *   node tools/mock-hook.js --port 30001 --webhook http://127.0.0.1:30002/wechat
 */
import http from 'node:http';
import process from 'node:process';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const port = Number(getArg('port', 30001));
const webhook = getArg('webhook', 'http://127.0.0.1:30002/wechat');
// 模拟别家 DLL：只认特定路径与字段组合，用来验证网关的方言自适应
const textPath = getArg('textPath', '/SendTextMsg');
const dialect = getArg('dialect', 'wxidorgid+msg');

const sent = [];
const self = { wxid: 'wxid_self_mock', alias: 'mock', nickname: '测试号', email: '', qq: 0, phone: '' };

/** 各家用不同的字段名，模拟时按选定的方言解析。 */
const SHAPES = {
  'wxidorgid+msg': (b) => (b.wxidorgid && typeof b.msg === 'string' ? { to: b.wxidorgid, text: b.msg } : null),
  'wxid+content': (b) => (b.wxid && typeof b.content === 'string' ? { to: b.wxid, text: b.content } : null),
  'to+text': (b) => (b.to && typeof b.text === 'string' ? { to: b.to, text: b.text } : null),
  'to_wxid+msg': (b) => (b.to_wxid && typeof b.msg === 'string' ? { to: b.to_wxid, text: b.msg } : null),
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = text ? JSON.parse(text) : {};
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, obj, code = 200) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

async function pushIncoming(payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return res.status;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/QueryDB/status') {
    return sendJson(res, { IsLogin: 1, hWeixin: 123456 });
  }
  if (path === '/GetSelfProfile') {
    return sendJson(res, self);
  }
  if (path === textPath) {
    const body = await readBody(req);
    const got = SHAPES[dialect](body);
    if (!got) {
      return sendJson(res, { ret: 1, retmsg: `期望方言 ${dialect}，收到 ${JSON.stringify(body).slice(0, 80)}` });
    }
    sent.push({ to: got.to, msg: got.text, at: Date.now(), dialect });
    console.log(`[mock-hook] 已发送 → ${got.to}: ${got.text}`);
    return sendJson(res, { ret: 0, retmsg: 'success' });
  }
  if (path === '/SendImgMsg' || path === '/SendFileMsg') {
    const body = await readBody(req);
    if (!body.wxidorgid || !body.path) {
      return sendJson(res, { ret: 1, retmsg: 'missing wxidorgid or path' });
    }
    sent.push({ to: body.wxidorgid, file: body.path, at: Date.now() });
    return sendJson(res, { ret: 0, retmsg: 'success' });
  }
  if (path === '/ForwardXMLMsg') {
    const body = await readBody(req);
    sent.push({ to: body.to_wxid, xml: body.content, at: Date.now() });
    return sendJson(res, { ret: 0, retmsg: 'success' });
  }
  if (path === '/QueryDB/execute') {
    return sendJson(res, { status: 0, desc: '', data: [] });
  }

  // 调试接口：伪造一条微信入站消息
  if (path === '/debug/incoming') {
    const body = await readBody(req);
    const payload = {
      type: 1,
      data: {
        msgid: body.msgid || `m${Date.now()}`,
        wxid: body.wxid || 'wxid_friend_mock',
        roomid: body.roomid || '',
        content: body.content || '你好',
        createTime: Math.floor(Date.now() / 1000),
      },
    };
    const code = await pushIncoming(payload);
    return sendJson(res, { pushed: code, payload });
  }
  if (path === '/debug/sent') {
    return sendJson(res, { count: sent.length, sent });
  }
  if (path === '/debug/reset') {
    sent.length = 0;
    return sendJson(res, { ok: true });
  }

  sendJson(res, { ret: -1, msg: 'not found' }, 404);
});

server.on('error', (err) => {
  console.error(`[mock-hook] 启动失败: ${err.code || err.message}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log(`[mock-hook] 监听 http://127.0.0.1:${actual}，回调 → ${webhook}`);
  console.log(`PORT=${actual}`);
});
