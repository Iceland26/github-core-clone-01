// Model Context Protocol surface (/mcp).
// Placeholder: a later revision implements the MCP JSON-RPC server here.
// Returning false lets app.ts fall through to its 404 response.

import type { HandlerCtx } from './store.ts';

export async function handleMCP(_ctx: HandlerCtx): Promise<boolean> {
  return false;
}
