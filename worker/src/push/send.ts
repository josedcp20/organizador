import type { PushTestResult } from '@organizador/shared';
import { now } from '../clock';
import {
  classifyPushResponse,
  deleteByEndpoint,
  listActive,
  markResult,
  type PushOutcome,
  validEndpoint,
} from '../db/pushSubscriptions';
import type { Env } from '../env';
import {
  buildPushRequest,
  parseVapidKey,
  vapidAuthHeader,
  type PushMessage,
  type PushRequestOptions,
} from './webpush';

export type SendOptions = Omit<PushRequestOptions, 'authorization'>;

/** VAPID_SUBJECT de [vars]; sin el, se usa la URL de la app (U2). */
export function vapidSubject(env: Env): string {
  return env.VAPID_SUBJECT?.trim() || env.APP_URL;
}

/**
 * Envia `message` a todas las suscripciones vigentes: un fetch por suscripcion, sin reintentos.
 * 404/410 borran la fila; el resto se anota (tabla 2.2). Un JWT por origen y llamada.
 * Logs: solo host, status y codigo (nunca endpoint, claves, JWT ni payload).
 * Devuelve null si VAPID no esta configurado.
 */
export async function sendToAll(
  env: Env,
  message: PushMessage,
  opts: SendOptions,
): Promise<PushTestResult | null> {
  const key = parseVapidKey(env.VAPID_PRIVATE_KEY);
  if (!key) return null;
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const subject = vapidSubject(env);
  const jwts = new Map<string, Promise<string>>();
  const result: PushTestResult = { sent: 0, failed: 0, removed: 0 };

  for (const sub of await listActive(env.DB, nowMs)) {
    // Revalida (la fila pudo escribirse sin pasar por la API): nunca hacer fetch a un host no permitido.
    const url = validEndpoint(sub.endpoint);
    if (!url) {
      await deleteByEndpoint(env.DB, sub.endpoint);
      result.removed++;
      continue;
    }
    let outcome: PushOutcome;
    try {
      let authorization = jwts.get(url.origin);
      if (!authorization) {
        authorization = vapidAuthHeader(sub.endpoint, key, subject, nowMs);
        jwts.set(url.origin, authorization);
      }
      const req = await buildPushRequest(sub, message, {
        ...opts,
        authorization: await authorization,
      });
      let status: number | 'network';
      try {
        const res = await fetch(req.url, req.init);
        status = res.status;
        await res.body?.cancel();
      } catch {
        status = 'network';
      }
      outcome = classifyPushResponse(status);
      if (outcome.kind !== 'ok')
        console.warn(
          'push',
          url.hostname,
          String(status),
          outcome.kind === 'error' ? outcome.code : 'gone',
        );
    } catch {
      // Claves guardadas invalidas o payload demasiado grande: no se llega a enviar.
      outcome = { kind: 'error', code: 'encrypt_error' };
      console.warn('push', url.hostname, 'encrypt_error');
    }
    await markResult(env.DB, sub.endpoint, outcome, nowIso);
    if (outcome.kind === 'ok') result.sent++;
    else if (outcome.kind === 'gone') result.removed++;
    else result.failed++;
  }
  return result;
}
