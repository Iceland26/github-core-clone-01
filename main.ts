import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  let delay = BACKOFF_START_MS;
  for (;;) {
    let status = 0;
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      status = 0;
    }
    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) {
      throw new Error(`registration rejected with HTTP ${status}`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, BACKOFF_CAP_MS);
  }
}

async function waitForDone(): Promise<void> {
  let delay = BACKOFF_START_MS;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.ok) {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && (parsed as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // network error, timeout or malformed body: keep polling
    }
    await sleep(delay);
    delay = Math.min(delay * 2, BACKOFF_CAP_MS);
  }
}

async function main(): Promise<void> {
  if (!ENV_URL) {
    process.stderr.write('error: MAKEFUN_ENV_URL is not set\n');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  if (!port) throw new Error('failed to determine listening port');

  await register(port);
  await waitForDone();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  console.log('done');
  process.exit(0);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
}
