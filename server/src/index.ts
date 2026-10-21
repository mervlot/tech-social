import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { initSockets } from './sockets';
import { db } from './config/db';

async function main() {
  const app = createApp();
  const server = http.createServer(app);

  // Attach Socket.io for realtime notifications and direct messages.
  initSockets(server);

  server.listen(env.port, env.host, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on ${env.apiUrl} (port ${env.port})`);
  });

  const shutdown = async () => {
    // eslint-disable-next-line no-console
    console.log('\nShutting down...');
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
