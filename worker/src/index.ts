import { app } from './app';
import type { Env } from './env';
import { runSpikeT21IfPending } from './spike/t21';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  // Placeholder: el despachador real llega en tareas posteriores (jobs/scheduled.ts).
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // SPIKE T2.1 TEMPORAL (borrar junto con src/spike/t21.ts): se ejecuta una sola vez.
    try {
      await runSpikeT21IfPending(env);
    } catch (e) {
      console.warn('spike_t21_failed', e instanceof Error ? e.name : 'error');
    }
  },
};
