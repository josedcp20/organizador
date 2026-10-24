import type { AppSettings, AppSettingsPatch } from '@organizador/shared';
import { apiFetch } from './api';

export function fetchSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>('/api/settings');
}

/** Parcial; `null` borra el ajuste. Devuelve los ajustes resultantes. */
export function patchSettings(patch: AppSettingsPatch): Promise<AppSettings> {
  return apiFetch<AppSettings>('/api/settings', { method: 'PATCH', body: patch });
}
