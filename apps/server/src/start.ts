import { buildApp } from './app';
import { loadConfig, type Config } from './config';

/** Sobe o servidor. Usado pelo `npm start` e pelo servidor embutido no app desktop. */
export async function startServer(opts: { logger?: boolean; config?: Partial<Config> } = {}) {
  const config = loadConfig(opts.config);
  const { app } = await buildApp(config, { logger: opts.logger });
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Servidor Line rodando em http://localhost:${config.port} (dados em ${config.dataDir})`);
  return app;
}
