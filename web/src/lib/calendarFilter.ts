import { writable } from 'svelte/store';
import type { CalendarInfo } from '@organizador/shared';

// Estado del filtro de calendarios, compartido entre la pantalla Calendario (chips en movil)
// y el menu lateral de escritorio (App.svelte -> Layout sidebar).
export const filterCalendars = writable<CalendarInfo[]>([]);
export const hiddenCalendars = writable<ReadonlySet<string>>(new Set());
export const showApp = writable(true);

export function toggleCalendar(id: string): void {
  hiddenCalendars.update((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

export function toggleApp(): void {
  showApp.update((v) => !v);
}

export function resetFilter(): void {
  filterCalendars.set([]);
  hiddenCalendars.set(new Set());
  showApp.set(true);
}
