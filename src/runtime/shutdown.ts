export async function stopServerGracefully(server: Bun.Server<undefined>, timeoutMs = 10_000): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Shutdown timeout must be a positive integer");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      server.stop(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => void server.stop(true).then(resolve, resolve), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
