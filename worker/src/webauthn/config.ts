import type { Env } from '../env';

export interface RPConfig {
  rpID: string;
  origin: string;
  rpName: string;
}

/**
 * Deriva rpID y origin de ALLOWED_ORIGIN (p.ej. https://josedcp20.github.io -> rpID 'josedcp20.github.io').
 * rpName es un label fijo para la UI del navegador.
 * null si ALLOWED_ORIGIN no es un URL https valido o si falta.
 * Fallo cerrado: cualquier config invalida -> null.
 */
export function rpConfig(env: Env): RPConfig | null {
  const allowedOrigin = env.ALLOWED_ORIGIN?.trim();
  if (!allowedOrigin) return null;
  try {
    const url = new URL(allowedOrigin);
    // WebAuthn requiere https en todos lados excepto localhost
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
      return null;
    }
    return {
      rpID: url.hostname,
      origin: url.origin, // sin barra final ni ruta
      rpName: 'Organizador',
    };
  } catch {
    return null;
  }
}
