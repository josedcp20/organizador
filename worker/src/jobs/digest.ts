import type { EventInfo } from '@organizador/shared';

/** Contenido de los push (resumen y avisos D-N). Puro: nunca usa notes, description ni location. */
export interface PushContent {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export const BODY_MAX = 180;
const TODAY_SHOWN = 2;

type DigestEvent = Pick<EventInfo, 'summary' | 'allDay' | 'startAt' | 'done'>;
export interface ReminderItem {
  calendarId: string;
  id: string;
  summary: string | null;
  allDay: boolean;
  startAt: string | null;
  startDate: string | null;
  inDays: number;
}

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function parts(d: Date, tz: string, opts: Intl.DateTimeFormatOptions) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('es-ES', { timeZone: tz, ...opts })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
}

const hhmm = (iso: string, tz: string) => {
  const p = parts(new Date(iso), tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
};

const name = (e: Pick<EventInfo, 'summary'>) => e.summary?.trim() || '(Sin título)';

/** `09:30 Dentista` | `Todo el día Titulo`, con `✓ ` si esta hecho. */
function line(e: DigestEvent, tz: string): string {
  const when = e.allDay || !e.startAt ? 'Todo el día' : hhmm(e.startAt, tz);
  return `${e.done ? '✓ ' : ''}${when} ${name(e)}`;
}

const notesLabel = (n: number) => `${n} ${n === 1 ? 'nota rápida' : 'notas rápidas'}`;

function digestTitle(nToday: number, nTomorrow: number): string {
  if (nToday + nTomorrow === 0) return 'Sin eventos hoy ni mañana';
  return `Hoy: ${nToday} ${nToday === 1 ? 'evento' : 'eventos'} · Mañana: ${nTomorrow}`;
}

/** Resumen de las 8:00. `date` = hoy local (YYYY-MM-DD) para el `tag`. */
export function buildDigest(
  todayEvents: DigestEvent[],
  tomorrowEvents: DigestEvent[],
  quickNotesCount: number,
  tz: string,
  date: string,
): PushContent {
  const shown = todayEvents.slice(0, TODAY_SHOWN).map((e) => line(e, tz));
  const more = todayEvents.length - shown.length;
  const today = [...shown, ...(more > 0 ? [`+${more}`] : [])].join(' · ');
  const tomorrow = tomorrowEvents[0] ? `Mañana ${line(tomorrowEvents[0], tz)}` : '';
  let body = [today, tomorrow].filter(Boolean).join(' | ');
  if (quickNotesCount > 0) body += `${body ? ' ' : ''}· ${notesLabel(quickNotesCount)}`;
  return {
    title: digestTitle(todayEvents.length, tomorrowEvents.length),
    // El SW sustituiria un cuerpo vacio por un texto generico.
    body: truncate(body, BODY_MAX) || 'Sin eventos',
    url: '#/hoy',
    tag: `digest-${date}`,
  };
}

/** Version larga (Atajo de iOS / `GET /api/digest?format=text`): todos los eventos, sin limite de 180. */
export function buildDigestText(
  todayEvents: DigestEvent[],
  tomorrowEvents: DigestEvent[],
  quickNotesCount: number,
  tz: string,
): string {
  const section = (label: string, evs: DigestEvent[]) =>
    `${label}\n${evs.length ? evs.map((e) => `- ${line(e, tz)}`).join('\n') : '- Sin eventos'}`;
  const out = [
    digestTitle(todayEvents.length, tomorrowEvents.length),
    section('Hoy', todayEvents),
    section('Mañana', tomorrowEvents),
  ];
  if (quickNotesCount > 0) out.push(notesLabel(quickNotesCount));
  return out.join('\n\n');
}

const inDays = (n: number) => `En ${n} ${n === 1 ? 'día' : 'días'}`;

/** Mismo codigo que `eventHash` de web/src/router.ts. */
const eventHash = (c: string, e: string) =>
  `#/evento/${encodeURIComponent(c)}/${encodeURIComponent(e)}`;

/** Avisos D-N. `items` no vacio; `date` = hoy local para el `tag`. */
export function buildReminders(items: ReminderItem[], tz: string, date: string): PushContent {
  const tag = `reminders-${date}`;
  if (items.length === 1) {
    const r = items[0]!;
    const day = r.startAt ?? `${r.startDate}T12:00:00Z`;
    const d = parts(new Date(day), r.startAt ? tz : 'UTC', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    });
    const time = !r.allDay && r.startAt ? ` ${hhmm(r.startAt, tz)}` : '';
    return {
      title: `${inDays(r.inDays)}: ${name(r)}`,
      body: truncate(`${d.weekday} ${d.day}/${d.month}${time}`, BODY_MAX),
      url: eventHash(r.calendarId, r.id),
      tag,
    };
  }
  const body = items.map((r) => `${inDays(r.inDays)}: ${name(r)}`).join(' · ');
  return {
    title: `Próximos avisos (${items.length})`,
    body: truncate(body, BODY_MAX),
    url: '#/hoy',
    tag,
  };
}
