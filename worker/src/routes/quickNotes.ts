import {
  NOTE_BODY_MAX,
  computeExpiresAt,
  type ExpirySpec,
  type QuickNotesResponse,
} from '@organizador/shared';
import { Hono } from 'hono';
import { now } from '../clock';
import { deleteLiveNote, insertNote, listLiveNotes, toQuickInfo } from '../db/notes';
import type { Env } from '../env';
import { errorBody } from '../errors';
import { DEFAULT_TZ } from '../sync/window';
import { parseBodyText, parseExpiry, parseExpiryParam, readJsonObject } from './notes';

/**
 * Notas rapidas (T3.2): mismas filas de `notes` con kind = 'quick'. Las usa el Atajo de iOS, que
 * envia el texto como `text/plain`. Solo D1; nunca Google. Caducidad por defecto: "solo hoy".
 */
export const quickNotes = new Hono<{ Bindings: Env }>();

const NO_STORE = 'no-store';
const DEFAULT_EXPIRY: ExpirySpec = { type: 'today' };
/**
 * Tope de bytes del cuerpo (10000 caracteres a 4 bytes en UTF-8 + margen de JSON). El limite de
 * NOTE_BODY_MAX se mide en unidades UTF-16 (`string.length`) tras `trim()`.
 */
const MAX_BODY_BYTES = NOTE_BODY_MAX * 4 + 1024;

/** Content-Type tratados como texto plano (vacio = cabecera ausente). */
const TEXT_TYPES = new Set([
  '',
  'text/plain',
  'application/octet-stream',
  'application/x-www-form-urlencoded',
]);

const bad = (message: string) => errorBody('validation', message);

/** "caduca el 16/07 a las 00:00" en hora local de `tz`, o "sin caducidad". */
function expiryLabel(expiresAt: string | null, tz: string): string {
  if (!expiresAt) return 'sin caducidad';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(expiresAt));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `caduca el ${p('day')}/${p('month')} a las ${p('hour')}:${p('minute')}`;
}

quickNotes.get('/api/quick-notes', async (c) => {
  c.header('Cache-Control', NO_STORE);
  const list = await listLiveNotes(c.env.DB, now(), 'quick');
  const body: QuickNotesResponse = { quickNotes: list.map(toQuickInfo) };
  return c.json(body);
});

quickNotes.post('/api/quick-notes', async (c) => {
  const ctype = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  const isJson = ctype === 'application/json';
  // El Atajo de iOS puede mandar el cuerpo sin Content-Type, como octet-stream o como
  // x-www-form-urlencoded (sin parsear como form): todo eso es texto plano.
  const isText = !isJson && TEXT_TYPES.has(ctype);
  if (!isText && !isJson) {
    return c.json(
      errorBody('unsupported_media_type', 'Content-Type must be text/plain or application/json'),
      415,
    );
  }
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) return c.json(bad('Body too large'), 413);

  // Caducidad por query (?expiry= o ?days=); en JSON tambien puede ir en `expiry`.
  const q = c.req.query('expiry') ?? c.req.query('days');
  let spec: ExpirySpec | null = null;
  if (q !== undefined) {
    const p = parseExpiryParam(q);
    if (!p.ok) return c.json(bad(p.message), 400);
    spec = p.value;
  }

  let rawText: unknown;
  if (isText) {
    // arrayBuffer + TextDecoder: evita el aviso de workerd por .text() en tipos no textuales.
    const text = new TextDecoder().decode(await c.req.arrayBuffer());
    if (text.length > NOTE_BODY_MAX * 2) return c.json(bad('Body too large'), 413);
    rawText = text;
  } else {
    const j = await readJsonObject(c.req.raw);
    if (!j.ok) return c.json(bad(j.message), 400);
    const b = j.value;
    const unknown = Object.keys(b).filter((k) => k !== 'body' && k !== 'expiry');
    if (unknown.length > 0) return c.json(bad(`Unknown field: ${unknown[0]}`), 400);
    if ('expiry' in b) {
      if (spec) return c.json(bad('expiry given twice (query and body)'), 400);
      const e = parseExpiry(b.expiry);
      if (!e.ok) return c.json(bad(e.message), 400);
      spec = e.value;
    }
    rawText = b.body;
  }

  const text = parseBodyText(rawText);
  if (!text.ok) return c.json(bad(text.message), 400);
  const nowMs = now();
  const tz = c.env.TZ || DEFAULT_TZ;
  const note = await insertNote(
    c.env.DB,
    {
      body: text.value,
      title: null,
      kind: 'quick',
      pinned: false,
      expiresAt: computeExpiresAt(spec ?? DEFAULT_EXPIRY, new Date(nowMs), tz),
    },
    nowMs,
  );
  c.header('Cache-Control', NO_STORE);
  if (isText) {
    // Respuesta corta para la notificacion del Atajo.
    c.header('Content-Type', 'text/plain; charset=utf-8');
    return c.body(`Guardada (${expiryLabel(note.expiresAt, tz)})`, 201);
  }
  return c.json(toQuickInfo(note), 201);
});

quickNotes.delete('/api/quick-notes/:id', async (c) => {
  if (!(await deleteLiveNote(c.env.DB, c.req.param('id'), now(), 'quick'))) {
    return c.json(errorBody('not_found', 'Note not found'), 404);
  }
  return c.body(null, 204);
});
