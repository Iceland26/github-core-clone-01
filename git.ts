// Git smart HTTP surface (/{owner}/{repo}.git/...).
// Placeholder: a later revision implements upload-pack / receive-pack here.
// Returning false lets app.ts fall through to its 404 response.

import type { HandlerCtx } from './store.ts';

export async function handleGit(_ctx: HandlerCtx): Promise<boolean> {
  return false;
}
