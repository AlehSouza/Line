import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app } = await buildApp(config, { logger: true });

await app.listen({ port: config.port, host: config.host });
app.log.info(`Servidor Line rodando em http://localhost:${config.port} (dados em ${config.dataDir})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
