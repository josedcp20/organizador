import {
  EVENT_META_LIMITS,
  isHexColor,
  type EventMetaScope,
  type EventMetaValues,
} from '@organizador/shared';
import { now } from '../clock';

/**
 * Datos privados de evento (`event_meta`): notas, "avisar", dias de antelacion y color propio.
 * SOLO D1: este modulo nunca llama a Google (ni como `description`).
 *
 * Claves (ver 0001_init.sql): (calendar_id, scope, target_id) con target_id = id de la instancia
 * (scope 'instance') o recurring_event_id (scope 'series').
 *
 * Precedencia, campo a campo: instancia (si no NULL) > serie (si no NULL) > defecto
 * (notes '', remind false, remind_days_before 5, color = el del calendario/app/Google).
 */

export interface ResolvedMeta {
  notes: string;
  remind: boolean;
  remindDaysBefore: number;
  /** null = sin color propio (se usa el del calendario / app / Google). */
  color: string | null;
}

/** Campos a cambiar en un ambito: ausente = no cambia; null = deja de estar definido (hereda). */
export interface EventMetaPatch {
  notes?: string | null;
  remind?: boolean | null;
  remindDaysBefore?: number | null;
  color?: string | null;
}

/** Resolucion campo a campo instancia > serie > defecto (unica fuente de la regla). */
export function resolveMeta(
  instance: EventMetaValues | null,
  series: EventMetaValues | null,
): ResolvedMeta {
  return {
    notes: instance?.notes ?? series?.notes ?? '',
    remind: instance?.remind ?? series?.remind ?? false,
    remindDaysBefore:
      instance?.remindDaysBefore ?? series?.remindDaysBefore ?? EVENT_META_LIMITS.remindDaysDefault,
    color: instance?.color ?? series?.color ?? null,
  };
}

/** Fila cruda (columnas de event_meta) -> valores; null si no hay fila. */
export function metaValuesFromRow(row: {
  present: unknown;
  notes: string | null;
  remind: number | null;
  remind_days_before: number | null;
  color: string | null;
}): EventMetaValues | null {
  if (row.present == null) return null;
  return {
    notes: row.notes,
    remind: row.remind == null ? null : row.remind === 1,
    remindDaysBefore: row.remind_days_before,
    // Defensivo: un color corrupto en D1 se trata como no definido.
    color: isHexColor(row.color) ? row.color.toLowerCase() : null,
  };
}

export interface MetaKey {
  calendarId: string;
  scope: EventMetaScope;
  /** Id de instancia (scope 'instance') o recurring_event_id (scope 'series'). */
  targetId: string;
}

/**
 * Upsert parcial de un ambito, atomico (un batch = transaccion). Si tras el cambio todos los campos
 * quedan a NULL se borra la fila (no queda "personalizacion" vacia).
 */
export async function upsertEventMeta(
  db: D1Database,
  key: MetaKey,
  patch: EventMetaPatch,
): Promise<void> {
  const has = (k: keyof EventMetaPatch) => (k in patch && patch[k] !== undefined ? 1 : 0);
  const remind = patch.remind == null ? null : patch.remind ? 1 : 0;
  const ts = new Date(now()).toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO event_meta
           (calendar_id, scope, target_id, notes, remind, remind_days_before, color, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (calendar_id, scope, target_id) DO UPDATE SET
           notes = CASE WHEN ?9 = 1 THEN excluded.notes ELSE event_meta.notes END,
           remind = CASE WHEN ?10 = 1 THEN excluded.remind ELSE event_meta.remind END,
           remind_days_before = CASE WHEN ?11 = 1 THEN excluded.remind_days_before
                                     ELSE event_meta.remind_days_before END,
           color = CASE WHEN ?12 = 1 THEN excluded.color ELSE event_meta.color END,
           updated_at = excluded.updated_at`,
      )
      .bind(
        key.calendarId,
        key.scope,
        key.targetId,
        patch.notes ?? null,
        remind,
        patch.remindDaysBefore ?? null,
        patch.color == null ? null : patch.color.toLowerCase(),
        ts,
        has('notes'),
        has('remind'),
        has('remindDaysBefore'),
        has('color'),
      ),
    deleteEmptyStmt(db, key),
  ]);
}

/** Quita la personalizacion de un ambito (vuelve a heredar). Idempotente. */
export async function deleteEventMeta(db: D1Database, key: MetaKey): Promise<boolean> {
  const r = await db
    .prepare('DELETE FROM event_meta WHERE calendar_id = ?1 AND scope = ?2 AND target_id = ?3')
    .bind(key.calendarId, key.scope, key.targetId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

function deleteEmptyStmt(db: D1Database, key: MetaKey): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM event_meta
       WHERE calendar_id = ?1 AND scope = ?2 AND target_id = ?3
         AND notes IS NULL AND remind IS NULL AND remind_days_before IS NULL AND color IS NULL`,
    )
    .bind(key.calendarId, key.scope, key.targetId);
}

export type MetaInputResult =
  { ok: true; scope: EventMetaScope; patch: EventMetaPatch } | { ok: false; message: string };

const INPUT_KEYS = new Set(['scope', 'notes', 'remind', 'remind_days_before', 'color']);

export function isMetaScope(v: unknown): v is EventMetaScope {
  return v === 'instance' || v === 'series';
}

/**
 * Valida el body de `PUT .../meta` (`EventMetaInput`). Claves desconocidas -> error (asi nada
 * inesperado se cuela ni se confunde con campos de Google como `description`).
 */
export function parseMetaInput(raw: unknown): MetaInputResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Body must be an object' };
  }
  const body = raw as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((k) => !INPUT_KEYS.has(k));
  if (unknownKey !== undefined) {
    return {
      ok: false,
      message: 'Only scope, notes, remind, remind_days_before and color are allowed',
    };
  }
  if (!isMetaScope(body.scope)) {
    return { ok: false, message: "scope must be 'instance' or 'series'" };
  }
  const patch: EventMetaPatch = {};
  if ('notes' in body) {
    const v = body.notes;
    if (v !== null && typeof v !== 'string') {
      return { ok: false, message: 'notes must be a string or null' };
    }
    if (typeof v === 'string' && v.length > EVENT_META_LIMITS.notesMaxLength) {
      return {
        ok: false,
        message: `notes must not exceed ${EVENT_META_LIMITS.notesMaxLength} characters`,
      };
    }
    patch.notes = v;
  }
  if ('remind' in body) {
    const v = body.remind;
    if (v !== null && typeof v !== 'boolean') {
      return { ok: false, message: 'remind must be a boolean or null' };
    }
    patch.remind = v;
  }
  if ('remind_days_before' in body) {
    const v = body.remind_days_before;
    const { remindDaysMin: min, remindDaysMax: max } = EVENT_META_LIMITS;
    if (v !== null && !(Number.isInteger(v) && (v as number) >= min && (v as number) <= max)) {
      return {
        ok: false,
        message: `remind_days_before must be an integer between ${min} and ${max} or null`,
      };
    }
    patch.remindDaysBefore = v as number | null;
  }
  if ('color' in body) {
    const v = body.color;
    if (v !== null && !isHexColor(v)) {
      return { ok: false, message: 'color must be #rrggbb or null' };
    }
    patch.color = v === null ? null : v.toLowerCase();
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, message: 'At least one of notes, remind, remind_days_before, color' };
  }
  return { ok: true, scope: body.scope, patch };
}
