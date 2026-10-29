#!/usr/bin/env node
/**
 * AutoChat 的 MCP 服务器入口（stdio / JSON-RPC 2.0 / 零依赖）。
 *
 * 实现本体在 `plugin/dsh-autochat/lib/mcp.js` —— 与 DSH 插件共用同一份工具实现，
 * 所以「在 CodeBuddy IDE 里用」和「在 DeepSeek Harness 里用」的行为完全一致。
 *
 * 这里只做一件事：把入口放在 AutoChat 的常规目录里（.mcp.json 指向这里）。
 */
import '../../plugin/dsh-autochat/lib/mcp.js';
