// GraphQL surface (/api/graphql).
// Placeholder: a later revision implements the GraphQL executor here.
// Returning false lets app.ts fall through to its 404 response.

import type { HandlerCtx } from './store.ts';

export async function handleGraphQL(_ctx: HandlerCtx): Promise<boolean> {
  return false;
}
