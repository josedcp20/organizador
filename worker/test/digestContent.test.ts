import type { EventInfo } from '@organizador/shared';
import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  buildDigestText,
  buildReminders,
  type ReminderItem,
} from '../src/jobs/digest';
import { call as rawCall, type CallOptions } from './helpers';

const call = (p: string, o: CallOptions = {}) => rawCall(p, { ip: '203.0.113.7', ...o });

const TZ = 'Europe/Madrid';
const ev = (o: Partial<EventInfo>) =>
  ({ summary: 'X', allDay: false, startAt: null, ...o }) as EventInfo;
const at = (iso: string, summary: string | null, extra: Partial<EventInfo> = {}) =>
  ev({ startAt: iso, summary, ...extra });
const d = (e: EventInfo[], t: EventInfo[] = [], n = 0) => buildDigest(e, t, n, TZ, '2026-10-30');

describe('buildDigest', () => {
  it('dia vacio', () => {
    expect(d([])).toEqual({
      title: 'Sin eventos hoy ni mañana',
      body: 'Sin eventos',
      url: '#/hoy',
      tag: 'digest-2026-10-30',
    });
  });

  it('horas Madrid, dia completo, titulo vacio, +N, manana y notas', () => {
    const r = d(
      [
        at('2026-10-30T08:30:00Z', 'Dentista'),
        ev({ allDay: true, summary: 'Cumple' }),
        at('2026-10-30T12:00:00Z', '  '),
      ],
      [at('2026-10-31T09:00:00Z', 'Taller')],
      2,
    );
    expect(r.title).toBe('Hoy: 3 eventos · Mañana: 1');
    expect(r.body).toBe(
      '09:30 Dentista · Todo el día Cumple · +1 | Mañana 10:00 Taller · 2 notas rápidas',
    );
  });

  it('verano usa UTC+2', () => {
    expect(d([at('2026-07-01T07:00:00Z', 'A')]).body).toBe('09:00 A');
  });

  it('prefijo ✓ en hechos', () => {
    expect(d([at('2026-10-30T08:30:00Z', 'A', { done: true })]).body).toBe('✓ 09:30 A');
  });

  it('body <= 180 con …', () => {
    const r = d([at('2026-10-30T08:30:00Z', 'a'.repeat(400))]);
    expect(r.body).toHaveLength(180);
    expect(r.body.endsWith('…')).toBe(true);
  });

  it('nunca incluye notes, description ni location', () => {
    const secret = {
      notes: 'SENT_NOTES',
      description: 'SENT_DESC',
      location: 'SENT_LOC',
    };
    const t = [at('2026-10-30T08:30:00Z', 'A', secret)];
    const out = JSON.stringify([d(t, t), buildDigestText(t, t, 1, TZ)]);
    expect(out).not.toMatch(/SENT_/);
  });

  it('texto largo sin limite', () => {
    const many = Array.from({ length: 40 }, (_, i) => at('2026-10-30T08:30:00Z', `Evento ${i}`));
    const txt = buildDigestText(many, [], 1, TZ);
    expect(txt.length).toBeGreaterThan(180);
    expect(txt).toContain('- 09:30 Evento 39');
    expect(txt).toContain('1 nota rápida');
  });
});

describe('buildReminders', () => {
  const r = (o: Partial<ReminderItem>): ReminderItem => ({
    calendarId: 'a@b',
    id: 'e/1',
    summary: 'Examen',
    allDay: false,
    startAt: '2026-10-30T08:30:00Z',
    startDate: null,
    inDays: 5,
    ...o,
  });

  it('uno: url de evento codificada', () => {
    expect(buildReminders([r({})], TZ, '2026-10-25')).toEqual({
      title: 'En 5 días: Examen',
      body: 'vie 30/10 09:30',
      url: '#/evento/a%40b/e%2F1',
      tag: 'reminders-2026-10-25',
    });
  });

  it('dia completo y singular', () => {
    const x = buildReminders(
      [r({ allDay: true, startAt: null, startDate: '2026-10-30', inDays: 1 })],
      TZ,
      'D',
    );
    expect(x.title).toBe('En 1 día: Examen');
    expect(x.body).toBe('vie 30/10');
  });

  it('varios: agrupado a #/hoy', () => {
    const x = buildReminders([r({ inDays: 2, summary: 'A' }), r({ summary: null })], TZ, 'D');
    expect(x).toMatchObject({
      title: 'Próximos avisos (2)',
      body: 'En 2 días: A · En 5 días: (Sin título)',
      url: '#/hoy',
    });
  });

  it('sin notas, descripcion ni ubicacion', () => {
    const x = buildReminders(
      [{ ...r({}), notes: 'SENT_N', location: 'SENT_L' } as ReminderItem],
      TZ,
      'D',
    );
    expect(JSON.stringify(x)).not.toMatch(/SENT_/);
  });
});

describe('GET /api/digest', () => {
  it('401 sin token', async () => {
    expect((await call('/api/digest', { auth: null })).status).toBe(401);
  });

  it('400 con formato invalido', async () => {
    expect((await call('/api/digest?format=xml')).status).toBe(400);
  });

  it('text y json, no-store', async () => {
    const t = await call('/api/digest?format=text');
    expect(t.status).toBe(200);
    expect(t.headers.get('Cache-Control')).toBe('no-store');
    expect(await t.text()).toContain('Hoy');
    const j = await call('/api/digest?format=json');
    expect(j.headers.get('Cache-Control')).toBe('no-store');
    expect(await j.json()).toMatchObject({ url: '#/hoy', tag: expect.stringMatching(/^digest-/) });
  });
});
