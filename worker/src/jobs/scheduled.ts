import type { Env } from '../env';
import { DEFAULT_MAX_REQUESTS, runSync } from '../sync/engine';
import { runCleanup } from './cleanup';
import { runPendingWrites } from './pendingWrites';

/**
 * Despachador del cron `*\/10 * * * *` (T2.5, D4). Un solo trigger que ejecuta en orden:
 *   1. escrituras pendientes a Google (T3.10, jobs/pendingWrites.ts)
 *   2. resumen 8:00 / avisos D-N (hook, T4.4/T4.5): si hay envios pendientes se priorizan y se
 *      reduce el presupuesto de sync (subrequests y CPU compartidos)
 *   3. sync Google -> D1 (T2.4)
 *   4. limpieza (hook, T3.3: notas caducadas, auth_failures...)
 * Cada paso va aislado: un fallo se registra (solo nombre del paso y tipo de error, nunca datos)
 * y no impide los siguientes.
 */

/** Subrequests maximas del plan gratuito por invocacion (fetch externos). */
export const SUBREQUEST_LIMIT = 50;

export interface StepContext {
  env: Env;
  nowMs: number;
  /** Subrequests que pide reservar un paso previo (p. ej. push del resumen). */
  reserved: number;
}

export interface ScheduledStep {
  name: string;
  run: (ctx: StepContext) => Promise<void>;
}

/** Reintento de escrituras pendientes (T3.10): sus peticiones se descuentan del sync. */
async function pendingWritesStep(ctx: StepContext): Promise<void> {
  const r = await runPendingWrites(ctx.env, {
    nowMs: ctx.nowMs,
    budget: SUBREQUEST_LIMIT - 5 - ctx.reserved - DEFAULT_MAX_REQUESTS,
  });
  ctx.reserved += r.requests;
  if (r.status !== 'ok' || r.requests > 0 || r.counts.expired > 0) {
    console.log('cron', 'pending_writes', r.status, JSON.stringify(r.counts));
  }
}

/** HOOK T4.4/T4.5 (pendiente): resumen 8:00 Madrid + avisos D-N con reintentos hasta 12:00. */
async function digestStep(): Promise<void> {
  // TODO(T4.4): si hay resumen/avisos que enviar, sumar a ctx.reserved los push previstos
  // (o enviarlos aqui) para que el sync use menos presupuesto.
}

async function syncStep(ctx: StepContext): Promise<void> {
  // Presupuesto de peticiones a Google: el por defecto, recortado si otros pasos reservaron
  // subrequests (deja margen para el refresh del access token y los hooks).
  const maxRequests = Math.max(
    0,
    Math.min(DEFAULT_MAX_REQUESTS, SUBREQUEST_LIMIT - 5 - ctx.reserved),
  );
  const r = await runSync(ctx.env, { maxRequests, nowMs: ctx.nowMs });
  if (r.status !== 'ok' && r.status !== 'busy') console.log('cron', 'sync_skipped', r.status);
}

/** Limpieza (T3.3): notas caducadas + purgeAuthFailures. */
async function cleanupStep(ctx: StepContext): Promise<void> {
  await runCleanup(ctx.env.DB, ctx.nowMs);
}

export const DEFAULT_STEPS: readonly ScheduledStep[] = [
  { name: 'pending_writes', run: pendingWritesStep },
  { name: 'digest', run: digestStep },
  { name: 'sync', run: syncStep },
  { name: 'cleanup', run: cleanupStep },
];

export async function runScheduled(
  env: Env,
  nowMs: number,
  steps: readonly ScheduledStep[] = DEFAULT_STEPS,
): Promise<{ failed: string[] }> {
  const ctx: StepContext = { env, nowMs, reserved: 0 };
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run(ctx);
    } catch (e) {
      failed.push(step.name);
      console.error('cron', 'step_failed', step.name, e instanceof Error ? e.name : 'unknown');
    }
  }
  return { failed };
}
