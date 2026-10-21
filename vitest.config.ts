import { defineConfig } from 'vitest/config';

// Solo para ejecutar `npx vitest run` desde la raiz sin recoger tests ajenos:
// worker/ usa vitest 4 + plugin de Cloudflare y web/ su propia config. Los tests
// se lanzan con `npm test` (workspaces); cada workspace usa su version/config.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['shared/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'worker/**', 'web/**'],
  },
});
