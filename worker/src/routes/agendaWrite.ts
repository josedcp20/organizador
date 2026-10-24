import type { AgendaConflictBody } from '@organizador/shared';
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { errorBody } from '../errors';
import {
  createAgendaEvent,
  deleteAgendaEvent,
  patchAgendaEvent,
  type WriteOutcome,
} from '../google/agendaWrites';
import { DEFAULT_TZ } from '../sync/window';
import { parseCreateBody, parsePatchBody } from './agendaInput';

/**
 * Escritura de eventos en Google (T3.7, D10), bajo el mismo prefijo que la lectura (/api/agenda;
 * "events" lo bloquea algun adblock). Protegido por el middleware Bearer de /api/*.
 *   POST   /api/agenda                       crea (no recurrente, idempotente por client_id)
 *   PATCH  /api/agenda/:calendarId/:eventId  edita (no recurrente)
 *   DELETE /api/agenda/:calendarId/:eventId  borra (?confirm_external=true si origin='google')
 * Contratos y codigos: shared/src/types.ts (AgendaEventCreate, AgendaEventPatch,
 * AgendaWriteErrorCode). Solo campos de evento: la meta privada va por PUT .../meta (solo D1).
 */
export const agendaWrite = new Hono<{ Bindings: Env }>();

const NO_STORE = 'no-store';
const tzOf = (env: Env) => env.TZ || DEFAULT_TZ;

async function readJson(
  c: Context<{ Bindings: Env }>,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

function respond(c: Context<{ Bindings: Env }>, o: WriteOutcome) {
  c.header('Cache-Control', NO_STORE);
  switch (o.kind) {
    case 'ok':
      return o.event ? c.json(o.event, o.status) : c.body(null, 204);
    case 'pending':
      return c.json(o.event, 202);
    case 'deleted':
      return c.body(null, 204);
    case 'error':
      if (o.code === 'conflict') {
        const body: AgendaConflictBody = {
          error: { code: 'conflict', message: o.message },
          current: o.current ?? null,
        };
        return c.json(body, 409);
      }
      return c.json(errorBody(o.code, o.message), o.status);
  }
}

agendaWrite.post('/api/agenda', async (c) => {
  const raw = await readJson(c);
  if (!raw.ok) return c.json(errorBody('validation', 'Body must be JSON'), 400);
  const input = parseCreateBody(raw.value, tzOf(c.env));
  if (!input.ok) return c.json(errorBody('validation', input.message), 400);
  return respond(c, await createAgendaEvent(c.env, input.value));
});

agendaWrite.patch('/api/agenda/:calendarId/:eventId', async (c) => {
  const raw = await readJson(c);
  if (!raw.ok) return c.json(errorBody('validation', 'Body must be JSON'), 400);
  const input = parsePatchBody(raw.value, tzOf(c.env));
  if (!input.ok) return c.json(errorBody('validation', input.message), 400);
  return respond(
    c,
    await patchAgendaEvent(c.env, c.req.param('calendarId'), c.req.param('eventId'), input.value),
  );
});

/**
 * `confirm_external` de DELETE: en la query (`?confirm_external=true|false`) y/o en un cuerpo JSON
 * opcional `{ "confirm_external": boolean }`. Contrato sin ambiguedad (si no, 400 validation):
 * - query con otro valor que true/false;
 * - cuerpo no vacio que no es JSON valido, no es un objeto, trae otras claves o un no booleano
 *   (con cualquier Content-Type: un cuerpo no vacio siempre se interpreta);
 * - query y cuerpo presentes con valores distintos.
 * Ausente en ambos = false.
 */
async function parseDeleteConfirm(
  c: Context<{ Bindings: Env }>,
): Promise<{ ok: true; value: boolean } | { ok: false; message: string }> {
  const q = c.req.query('confirm_external');
  if (q !== undefined && q !== 'true' && q !== 'false') {
    return { ok: false, message: 'confirm_external must be true or false' };
  }
  const fromQuery = q === undefined ? undefined : q === 'true';
  const text = await c.req.text();
  let fromBody: boolean | undefined;
  if (text.trim() !== '') {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return { ok: false, message: 'Body must be JSON' };
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, message: 'Body must be an object' };
    }
    const obj = v as Record<string, unknown>;
    const extra = Object.keys(obj).filter((k) => k !== 'confirm_external');
    if (extra.length) return { ok: false, message: `Unknown fields: ${extra.join(', ')}` };
    if ('confirm_external' in obj) {
      if (typeof obj.confirm_external !== 'boolean') {
        return { ok: false, message: 'confirm_external must be boolean' };
      }
      fromBody = obj.confirm_external;
    }
  }
  if (fromQuery !== undefined && fromBody !== undefined && fromQuery !== fromBody) {
    return { ok: false, message: 'confirm_external differs between query and body' };
  }
  return { ok: true, value: fromQuery ?? fromBody ?? false };
}

agendaWrite.delete('/api/agenda/:calendarId/:eventId', async (c) => {
  const parsed = await parseDeleteConfirm(c);
  if (!parsed.ok) return c.json(errorBody('validation', parsed.message), 400);
  const confirm = parsed.value;
  return respond(
    c,
    await deleteAgendaEvent(c.env, c.req.param('calendarId'), c.req.param('eventId'), confirm),
  );
});
