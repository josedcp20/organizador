import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Idempotente: applyD1Migrations omite las ya aplicadas (tabla d1_migrations).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
