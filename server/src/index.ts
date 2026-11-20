import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();
  const ctx = await buildApp(config);

  // Sync initial qBittorrent preferences in background (with retries during container startup)
  const syncQbitPrefs = async () => {
    const settings = ctx.db.getSettings();
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await ctx.qbit.applyFullPreferences({
          uploadLimitKbps: settings.uploadLimitKbps,
          stopOnComplete: settings.stopSeedingOnComplete,
          proxyEnabled: settings.proxyEnabled,
          proxyType: settings.proxyType,
          proxyHost: settings.proxyHost,
          proxyPort: settings.proxyPort,
          proxyUsername: settings.proxyUsername,
          proxyPassword: settings.proxyPassword,
        });
        ctx.app.log.info('Synced upload/seeding/proxy preferences to qBittorrent');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    ctx.app.log.warn('qBittorrent not reachable during startup; will keep retrying on API requests');
  };
  void syncQbitPrefs();

  const shutdown = async (signal: string) => {
    ctx.app.log.info(`Received ${signal}, shutting down...`);
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await ctx.app.listen({ port: config.port, host: config.host });
  ctx.app.log.info(`CloudVideo listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
