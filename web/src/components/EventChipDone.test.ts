import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import DayList from './DayList.svelte';
import MonthGrid from './MonthGrid.svelte';
import type { CalEvent } from '../lib/events';

const ev = (over: Partial<CalEvent> = {}): CalEvent => ({
  id: 'e1',
  calendarId: 'c',
  title: 'Dentista',
  color: '#d93025',
  allDay: false,
  startDay: '2026-10-24',
  endDay: '2026-10-24',
  startTime: '10:00',
  endTime: null,
  multiDay: false,
  tentative: false,
  fromApp: false,
  pending: false,
  pendingError: null,
  location: null,
  remind: false,
  hasNotes: false,
  done: false,
  ...over,
});
const props = (e: CalEvent) => ({
  days: ['2026-10-24'],
  byDay: new Map([['2026-10-24', [e]]]),
  today: '2026-10-24',
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('DayList: hecho', () => {
  it('sin handler no hay casilla', () => {
    render(DayList, props(ev()));
    expect(screen.queryByRole('button', { name: /Hecho/ })).toBeNull();
  });

  it('casilla hermana del enlace con aria-pressed; tocarla no navega', async () => {
    const onToggleDone = vi.fn();
    render(DayList, { ...props(ev({ done: true })), onToggleDone });
    const btn = screen.getByRole('button', { name: 'Hecho: Dentista' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.closest('a')).toBeNull();
    expect(screen.getByTestId('event-chip').classList.contains('done')).toBe(true);
    await fireEvent.click(btn);
    expect(onToggleDone).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe('');
  });

  it('se deshabilita mientras vuela la peticion de ese evento', () => {
    render(DayList, { ...props(ev()), onToggleDone: vi.fn(), doneBusy: { 'c/e1': true } });
    expect(screen.getByRole('button', { name: 'Hecho: Dentista' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

describe('MonthGrid: hecho', () => {
  it('solo atenua: sin casilla pero con clase done', () => {
    const e = ev({ done: true });
    render(MonthGrid, {
      from: '2026-10-19',
      month: '2026-10',
      byDay: new Map([['2026-10-24', [e]]]),
      today: '2026-10-24',
      onPickDay: () => {},
    });
    expect(screen.queryByRole('button', { name: /^Hecho/ })).toBeNull();
    expect(screen.getByTestId('event-chip').classList.contains('done')).toBe(true);
  });
});
