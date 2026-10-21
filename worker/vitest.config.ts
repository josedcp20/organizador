import { createHash } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { TEST_TOKEN } from './test/constants';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          cloudflareTest(async () => {
            // Todas las migraciones (0001, 0002...) se inyectan como binding y se aplican en test/setup.ts.
            const migrations = await readD1Migrations('./migrations');
            return {
              wrangler: { configPath: './wrangler.toml' },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  // Hash del token de prueba (test/helpers.ts: TEST_TOKEN). Solo para tests.
                  APP_TOKEN_SHA256: createHash('sha256').update(TEST_TOKEN).digest('hex'),
                },
              },
            };
          }),
        ],
        test: {
          name: 'workers',
          fileParallelism: false,
          setupFiles: ['./test/setup.ts'],
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        test: { name: 'node', environment: 'node', include: ['scripts/**/*.test.ts'] },
      },
    ],
  },
});
