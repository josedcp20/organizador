import { app } from './app';
import type { Env } from './env';
import { runScheduled } from './jobs/scheduled';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  // Cron `*/10 * * * *` (wrangler.toml): despachador en jobs/scheduled.ts (cada paso aislado).
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runScheduled(env, controller.scheduledTime);
  },
};
