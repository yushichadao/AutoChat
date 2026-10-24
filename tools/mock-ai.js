/**
 * 假的 OpenAI 兼容服务，用来在没有 API Key 的情况下跑通 AI 链路。
 *
 *   node tools/mock-ai.js --port 38280 --reply "我是 mock 模型"
 *
 * 默认把最后一条用户消息回显回去，方便确认上下文确实传进来了。
 */
import http from 'node:http';
import process from 'node:process';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const port = Number(getArg('port', 38280));
const fixed = getArg('reply', '');
const calls = [];

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      const body = JSON.stringify({ object: 'list', data: [{ id: 'hy3', object: 'model' }] });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
      return;
    }
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }

    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }

    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const content = fixed || `收到：${lastUser?.content ?? ''}`;
    calls.push({ model: body.model, turns: msgs.length, content, at: Date.now() });
    console.log(`[mock-ai] ${body.model || '?'} ← ${msgs.length} 条消息，回复：${content}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-mock-${calls.length}`,
        object: 'chat.completion',
        model: body.model || 'hy3',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    );
  });
});

// 调试接口
const debug = http.createServer((req, res) => {
  const body = JSON.stringify({ count: calls.length, calls });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
});

server.on('error', (err) => {
  console.error(`[mock-ai] 启动失败: ${err.code || err.message}`);
  process.exit(1);
});
debug.on('error', (err) => {
  console.error(`[mock-ai] 调试端口启动失败: ${err.code || err.message}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log(`[mock-ai] OpenAI 兼容服务 http://127.0.0.1:${actual}/v1`);
  console.log(`PORT=${actual}`);
  // 调试端口在主端口确定后再开，避免 --port 0 时算成 1
  debug.listen(actual + 1, '127.0.0.1', () => {
    console.log(`[mock-ai] 调用记录 http://127.0.0.1:${actual + 1}/`);
  });
});

export { calls };
