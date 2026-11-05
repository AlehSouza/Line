import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** ":memory:" nos testes */
  dbFile: string;
  jwtSecret?: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? './data');
  if (overrides.dbFile !== ':memory:') mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST ?? '0.0.0.0',
    dataDir,
    dbFile: path.join(dataDir, 'line.db'),
    jwtSecret: process.env.JWT_SECRET,
    ...overrides,
  };
}
