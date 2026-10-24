import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import type { EventInfo } from '@organizador/shared';
import ConfirmExternal from './ConfirmExternal.svelte';
import ConflictDialog from './ConflictDialog.svelte';

afterEach(cleanup);

const current = {
  summary: 'Dentista',
  allDay: true,
  startDate: '2026-11-02',
  endDate: '2026-11-03',
  location: 'Calle Mayor',
} as EventInfo;

describe('ConfirmExternal', () => {
  it('confirms, cancels and cancels on Escape (cancel event)', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(ConfirmExternal, {
      open: true,
      action: 'edit',
      summary: 'Reunión',
      onConfirm,
      onCancel,
    });
    const dlg = container.querySelector('dialog')!;
    expect(dlg.open).toBe(true);
    expect(screen.getByText(/no lo creaste en la app/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Aplicar en Google' }));
    expect(onConfirm).toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fireEvent(dlg, new Event('cancel', { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('delete mode uses delete wording and stays closed when open=false', () => {
    const { container } = render(ConfirmExternal, {
      open: false,
      action: 'delete',
      summary: 'X',
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(container.querySelector('dialog')!.open).toBe(false);
    expect(screen.getByText(/se borrará también/)).toBeTruthy();
  });
});

describe('ConflictDialog', () => {
  const base = { open: true, current };

  it('edit mode shows server version and fires callbacks', async () => {
    const h = { onUseServer: vi.fn(), onOverwrite: vi.fn(), onCancel: vi.fn() };
    render(ConflictDialog, { ...base, ...h, mode: 'edit' });
    expect(screen.getByText('Dentista')).toBeTruthy();
    expect(screen.getByText(/Todo el día/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Usar la versión de Google' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Sobrescribir con mis cambios' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(h.onUseServer).toHaveBeenCalled();
    expect(h.onOverwrite).toHaveBeenCalled();
    expect(h.onCancel).toHaveBeenCalled();
  });

  it('delete mode labels', async () => {
    const h = { onUseServer: vi.fn(), onOverwrite: vi.fn(), onCancel: vi.fn() };
    render(ConflictDialog, { ...base, ...h, mode: 'delete' });
    await fireEvent.click(screen.getByRole('button', { name: 'Borrar de todas formas' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Ver la versión de Google' }));
    expect(h.onOverwrite).toHaveBeenCalled();
    expect(h.onUseServer).toHaveBeenCalled();
  });

  it('current null shows only Cerrar', async () => {
    const onCancel = vi.fn();
    render(ConflictDialog, {
      open: true,
      mode: 'edit',
      current: null,
      onUseServer: vi.fn(),
      onOverwrite: vi.fn(),
      onCancel,
    });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
