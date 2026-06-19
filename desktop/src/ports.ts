import net from 'node:net';

/**
 * Asks the OS for a free loopback TCP port by binding to port 0 and reading back
 * the assigned port. We never hard-code 3979/3333 — on a user's laptop those are
 * routinely taken (OrbStack, other dev tools), and the kernel already fatals on
 * EADDRINUSE.
 */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('Could not determine a free port')));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** True if the given loopback TCP port can currently be bound. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Reserve N distinct free ports at once. */
export async function findFreePorts(count: number, host = '127.0.0.1'): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    let port = await findFreePort(host);
    // Guard against the rare race where the OS hands back a port we just picked.
    while (ports.includes(port)) {
      port = await findFreePort(host);
    }
    ports.push(port);
  }
  return ports;
}
