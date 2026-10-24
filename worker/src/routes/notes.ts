import {
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  computeExpiresAt,
  isValidExpiryDays,
  type ExpirySpec,
  type NoteKind,
  type NotesResponse,
} from '@organizador/shared';
import { Hono } from 'hono';
import { now } from '../clock';
import {
  deleteLiveNote,
  getLiveNote,
  insertNote,
  listLiveNotes,
  updateLiveNote,
  type NoteChanges,
} from '../db/notes';
import type { Env } from '../env';
import { errorBody } from '../errors';

/**
 * Notas (T3.2). Protegido por el middleware Bearer de /api/*. Solo D1: ninguna ruta de notas
 * llama a Google. Las notas caducadas nunca se devuelven ni se pueden modificar (404).
 */
export const notes = new Hono<{ Bindings: Env }>();

const NO_STORE = 'no-store';

/** Resultado de validar: valor o mensaje de error. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function parseBodyText(v: unknown): Parsed<string> {
  if (typeof v !== 'string') return fail('body must be a string');
  const t = v.trim();
  if (t.length < 1) return fail('body must not be empty');
  if (t.length > NOTE_BODY_MAX) return fail(`body must be at most ${NOTE_BODY_MAX} characters`);
  return { ok: true, value: t };
}

export function parseExpiry(v: unknown): Parsed<ExpirySpec> {
  if (!isPlainObject(v)) return fail('expiry must be an object');
  const extra = Object.keys(v).filter((k) => k !== 'type' && k !== 'days');
  if (extra.length > 0) return fail('expiry has unknown fields');
  if (v.type === 'today' || v.type === 'forever') {
    if ('days' in v) return fail('expiry.days is only valid with type "days"');
    return { ok: true, value: { type: v.type } };
  }
  if (v.type === 'days') {
    if (!isValidExpiryDays(v.days)) return fail('expiry.days must be an integer 1..365');
    return { ok: true, value: { type: 'days', days: v.days } };
  }
  return fail('expiry.type must be today, days or forever');
}

/** Valor de `?expiry=` / `?days=`: "today" | "forever" | entero 1..365 (solo digitos). */
export function parseExpiryParam(v: string): Parsed<ExpirySpec> {
  const s = v.trim().toLowerCase();
  if (s === 'today' || s === 'forever') return { ok: true, value: { type: s } };
  if (/^\d{1,3}$/.test(s)) {
    const days = Number(s);
    if (isValidExpiryDays(days)) return { ok: true, value: { type: 'days', days } };
  }
  return fail('expiry must be today, forever or an integer 1..365');
}

function parseTitle(v: unknown): Parsed<string | null> {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'string') return fail('title must be a string or null');
  const t = v.trim();
  if (t.length > NOTE_TITLE_MAX) return fail(`title must be at most ${NOTE_TITLE_MAX} characters`);
  return { ok: true, value: t === '' ? null : t };
}

export async function readJsonObject(req: Request): Promise<Parsed<Record<string, unknown>>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail('Body must be JSON');
  }
  if (!isPlainObject(raw)) return fail('Body must be an object');
  return { ok: true, value: raw };
}

const bad = (message: string) => errorBody('validation', message);
const notFound = () => errorBody('not_found', 'Note not found');

notes.get('/api/notes', async (c) => {
  const kindParam = c.req.query('kind');
  let kind: NoteKind | undefined;
  if (kindParam !== undefined) {
    if (kindParam !== 'note' && kindParam !== 'quick') {
      return c.json(bad('kind must be note or quick'), 400);
    }
    kind = kindParam;
  }
  c.header('Cache-Control', NO_STORE);
  const body: NotesResponse = { notes: await listLiveNotes(c.env.DB, now(), kind) };
  return c.json(body);
});

notes.post('/api/notes', async (c) => {
  const j = await readJsonObject(c.req.raw);
  if (!j.ok) return c.json(bad(j.message), 400);
  const b = j.value;
  const unknown = Object.keys(b).filter(
    (k) => !['body', 'title', 'kind', 'pinned', 'expiry'].includes(k),
  );
  if (unknown.length > 0) return c.json(bad(`Unknown field: ${unknown[0]}`), 400);

  const text = parseBodyText(b.body);
  if (!text.ok) return c.json(bad(text.message), 400);
  let title: string | null = null;
  if ('title' in b) {
    const t = parseTitle(b.title);
    if (!t.ok) return c.json(bad(t.message), 400);
    title = t.value;
  }
  let kind: NoteKind = 'note';
  if ('kind' in b) {
    if (b.kind !== 'note' && b.kind !== 'quick') {
      return c.json(bad('kind must be note or quick'), 400);
    }
    kind = b.kind;
  }
  let pinned = false;
  if ('pinned' in b) {
    if (typeof b.pinned !== 'boolean') return c.json(bad('pinned must be boolean'), 400);
    pinned = b.pinned;
  }
  let spec: ExpirySpec = { type: 'forever' };
  if ('expiry' in b) {
    const e = parseExpiry(b.expiry);
    if (!e.ok) return c.json(bad(e.message), 400);
    spec = e.value;
  }
  const nowMs = now();
  const note = await insertNote(
    c.env.DB,
    { body: text.value, title, kind, pinned, expiresAt: computeExpiresAt(spec, new Date(nowMs)) },
    nowMs,
  );
  c.header('Cache-Control', NO_STORE);
  return c.json(note, 201);
});

notes.patch('/api/notes/:id', async (c) => {
  const id = c.req.param('id');
  const j = await readJsonObject(c.req.raw);
  if (!j.ok) return c.json(bad(j.message), 400);
  const b = j.value;
  const keys = Object.keys(b);
  if (keys.length === 0) return c.json(bad('Nothing to update'), 400);
  const unknown = keys.filter((k) => !['body', 'title', 'pinned', 'expiry'].includes(k));
  if (unknown.length > 0) return c.json(bad(`Unknown field: ${unknown[0]}`), 400);

  const changes: NoteChanges = {};
  if ('body' in b) {
    const t = parseBodyText(b.body);
    if (!t.ok) return c.json(bad(t.message), 400);
    changes.body = t.value;
  }
  if ('title' in b) {
    const t = parseTitle(b.title);
    if (!t.ok) return c.json(bad(t.message), 400);
    changes.title = t.value;
  }
  if ('pinned' in b) {
    if (typeof b.pinned !== 'boolean') return c.json(bad('pinned must be boolean'), 400);
    changes.pinned = b.pinned;
  }
  const nowMs = now();
  if ('expiry' in b) {
    const e = parseExpiry(b.expiry);
    if (!e.ok) return c.json(bad(e.message), 400);
    changes.expiresAt = computeExpiresAt(e.value, new Date(nowMs));
  }
  if (!(await updateLiveNote(c.env.DB, id, changes, nowMs))) return c.json(notFound(), 404);
  const note = await getLiveNote(c.env.DB, id, nowMs);
  if (!note) return c.json(notFound(), 404);
  c.header('Cache-Control', NO_STORE);
  return c.json(note);
});

notes.delete('/api/notes/:id', async (c) => {
  if (!(await deleteLiveNote(c.env.DB, c.req.param('id'), now()))) {
    return c.json(notFound(), 404);
  }
  return c.body(null, 204);
});
