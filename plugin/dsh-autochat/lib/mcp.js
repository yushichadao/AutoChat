import process from 'node:process';
import { TOOL_SPECS, parseEnvelope, runTool } from './tools.js';
import { getHome } from './cli.js';

/**
 * AutoChat 的 MCP 服务器（stdio / JSON-RPC 2.0 / 零依赖）。
 *
 * 存在的意义：除了 DSH 原生工具外，让任何支持 MCP 的宿主（CodeBuddy IDE 等）
 * 也能用同一套 AutoChat 工具 —— 而且行为与 DSH 插件完全一致，因为两边共用
 * `lib/tools.js`。
 *
 * 启动：node src/mcp/server.js（仓库根）或 node plugin/dsh-autochat/lib/mcp.js
 */

const SERVER_INFO = { name: 'autochat', version: '2.0.0' };

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'AutoChat 是 Windows 上的微信侧 AI 助手（注入 hook DLL + 本地/云端模型）。' +
        '先调 autochat_preflight 看根本性配置七步；有阻断项就先解决，不要跳步启动。' +
        '写操作（config / apply_step / service）需要显式 confirm 或 acknowledge_blocking。',
    });
    return;
  }
  if (isNotification) return; // notifications/initialized 等：不需要回应

  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, {
      tools: TOOL_SPECS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          type: 'object',
          properties: t.parameters || {},
          required: Object.entries(t.parameters || {})
            .filter(([, v]) => v && v.required)
            .map(([k]) => k),
          additionalProperties: false,
        },
      })),
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOL_SPECS.some((t) => t.name === name)) {
      replyError(id, -32602, '未知工具：' + name);
      return;
    }
    try {
      const out = await runTool(name, (params && params.arguments) || {});
      const meta = parseEnvelope(out);
      reply(id, { content: [{ type: 'text', text: out }], isError: Boolean(meta && meta.ok === false) });
    } catch (err) {
      reply(id, {
        content: [{ type: 'text', text: '执行失败：' + (err && err.stack ? err.stack : err) }],
        isError: true,
      });
    }
    return;
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] });
    return;
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] });
    return;
  }

  replyError(id, -32601, '不支持的方法：' + method);
}

/** 行缓冲：一行一条 JSON-RPC 消息。 */
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, -32700, 'JSON 解析失败');
      continue;
    }
    handle(msg).catch((err) => {
      process.stderr.write('[autochat-mcp] handle 异常：' + (err && err.stack ? err.stack : err) + '\n');
    });
  }
});
process.stdin.on('end', () => process.exit(0));

// 任何写 stdout 的东西都会污染协议，所以诊断信息只走 stderr。
const { home, source } = getHome();
process.stderr.write(`[autochat-mcp] 就绪 · AutoChat 目录 ${home || '(未找到)'}（来源 ${source}）\n`);
