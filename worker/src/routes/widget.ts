import {
  addDaysInTz,
  addDaysToDateStr,
  formatDateInTz,
  type EventInfo,
  type WidgetEvent,
  type WidgetTodayResponse,
} from '@organizador/shared';
import { Hono } from 'hono';
import { now } from '../clock';
import { dueReminders, listEventsInRange, listRemindCandidates } from '../db/eventsRead';
import type { Env } from '../env';
import { hhmm, name, truncate } from '../jobs/digest';
import { REMIND_HORIZON_DAYS } from '../jobs/notify';
import { DEFAULT_TZ } from '../sync/window';

/** Widget de iOS (Scriptable): payload minimo, solo titulos y horas. Auth normal de /api/*. */
export const widget = new Hono<{ Bindings: Env }>();

const TITLE_MAX = 40;
const TODAY_MAX = 8;
const REMINDERS_MAX = 2;
const MIN_MS = 60_000;

const toWidgetEvent = (e: EventInfo, tz: string): WidgetEvent => {
  const timed = !e.allDay && !!e.startAt;
  return {
    time: timed ? hhmm(e.startAt!, tz) : null,
    title: truncate(name(e).replace(/\s+/g, ' '), TITLE_MAX),
    done: !!e.done,
    startAt: timed ? e.startAt : null,
  };
};

export function buildWidgetToday(
  todayEvents: EventInfo[],
  tomorrowEvents: EventInfo[],
  reminders: { inDays: number; summary: string | null }[],
  nowMs: number,
  tz: string,
): WidgetTodayResponse {
  const date = formatDateInTz(new Date(nowMs), tz);
  const midnight = addDaysInTz(new Date(nowMs), 1, tz).getTime();
  const isTimed = (e: EventInfo) => !e.allDay && !!e.startAt;
  const endMs = (e: EventInfo) => Date.parse(e.endAt ?? e.startAt!);

  const nextEv = todayEvents.find((e) => isTimed(e) && !e.done && endMs(e) > nowMs);
  // Proximos instantes en que el widget cambia: inicio o fin de un evento con hora.
  const edges = todayEvents
    .filter(isTimed)
    .flatMap((e) => [Date.parse(e.startAt!), endMs(e)])
    .filter((t) => t > nowMs);
  const refreshMs = Math.max(nowMs + MIN_MS, Math.min(nowMs + 15 * MIN_MS, midnight, ...edges));

  return {
    v: 1,
    generatedAt: new Date(nowMs).toISOString(),
    date,
    refreshAt: new Date(refreshMs).toISOString(),
    today: todayEvents.slice(0, TODAY_MAX).map((e) => toWidgetEvent(e, tz)),
    todayTotal: todayEvents.length,
    todayDone: todayEvents.filter((e) => e.done).length,
    next: nextEv ? toWidgetEvent(nextEv, tz) : null,
    tomorrow: {
      total: tomorrowEvents.length,
      first: tomorrowEvents[0] ? toWidgetEvent(tomorrowEvents[0], tz) : null,
    },
    reminders: reminders.slice(0, REMINDERS_MAX).map((r) => ({
      inDays: r.inDays,
      title: truncate(name({ summary: r.summary }).replace(/\s+/g, ' '), TITLE_MAX),
    })),
  };
}

widget.get('/api/widget/today', async (c) => {
  const tz = c.env.TZ || DEFAULT_TZ;
  const nowMs = now();
  const today = formatDateInTz(new Date(nowMs), tz);
  const tomorrow = addDaysToDateStr(today, 1);
  const opts = { nowMs, tz };
  const [todayEvents, tomorrowEvents, candidates] = await Promise.all([
    listEventsInRange(c.env.DB, today, today, opts),
    listEventsInRange(c.env.DB, tomorrow, tomorrow, opts),
    listRemindCandidates(c.env.DB, tomorrow, addDaysToDateStr(today, REMIND_HORIZON_DAYS), opts),
  ]);
  const reminders = dueReminders(candidates, today, tz).map(({ event, inDays }) => ({
    inDays,
    summary: event.summary,
  }));
  c.header('Cache-Control', 'no-store');
  return c.json(buildWidgetToday(todayEvents, tomorrowEvents, reminders, nowMs, tz));
});
