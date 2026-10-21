import { app } from './app';
import type { Env } from './env';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  // Placeholder: el despachador real llega en tareas posteriores (jobs/scheduled.ts).
  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // no-op
  },
};
