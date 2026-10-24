/* global AuthenticatorTransport, AuthenticatorSelectionCriteria, AttestationConveyancePreference, UserVerificationRequirement, PublicKeyCredentialDescriptor */
import type {
  AuthenticationResponseJSON,
  PasskeyInfo,
  PasskeyLoginResult,
  PasskeysResponse,
  RegistrationResponseJSON,
} from '@organizador/shared';
import { apiFetch } from './api';

// Opciones JSON del servidor. Sin parseXFromJSON/toJSON: no existen en iOS 16/17.

export interface CredentialDescriptorJSON {
  id: string; // base64url
  type: 'public-key';
  transports?: AuthenticatorTransport[];
}

export interface RegisterOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  excludeCredentials?: CredentialDescriptorJSON[];
  timeout?: number;
}

export interface LoginOptionsJSON {
  challenge: string;
  rpId?: string;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: CredentialDescriptorJSON[];
  timeout?: number;
}

// --- base64url <-> bytes

export function b64urlToBuffer(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function bufferToB64url(buf: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Soporte

export function passkeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  );
}

/** true si hay autenticador de plataforma con verificacion (Face ID / Touch ID). Nunca lanza. */
export async function platformAvailable(): Promise<boolean> {
  if (!passkeySupported()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// --- Errores

export type PasskeyErrorCode =
  'cancelled' | 'already_registered' | 'unsupported' | 'security' | 'failed';

const MESSAGES: Record<PasskeyErrorCode, string> = {
  cancelled: 'Face ID cancelado o no hay passkey en este dispositivo. Puedes entrar con el token.',
  already_registered: 'Este dispositivo ya tiene Face ID activado.',
  unsupported: 'Este dispositivo o navegador no admite Face ID.',
  security: 'El navegador rechazo la operacion por seguridad (origen no valido).',
  failed: 'No se pudo completar Face ID. Intentalo de nuevo.',
};

export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode;
  constructor(code: PasskeyErrorCode) {
    super(MESSAGES[code]);
    this.name = 'PasskeyError';
    this.code = code;
  }
}

function mapError(e: unknown): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyError('cancelled');
  if (name === 'InvalidStateError') return new PasskeyError('already_registered');
  if (name === 'SecurityError') return new PasskeyError('security');
  if (name === 'NotSupportedError') return new PasskeyError('unsupported');
  return new PasskeyError('failed');
}

// --- Ceremonias. Llamar DIRECTO desde el gesto (iOS): pedir las opciones antes.

const toDescriptors = (
  list?: CredentialDescriptorJSON[],
): PublicKeyCredentialDescriptor[] | undefined =>
  list?.map((c) => ({ ...c, id: b64urlToBuffer(c.id) }));

export async function registerPasskey(
  options: RegisterOptionsJSON,
): Promise<RegistrationResponseJSON> {
  if (!passkeySupported()) throw new PasskeyError('unsupported');
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: b64urlToBuffer(options.challenge),
        user: { ...options.user, id: b64urlToBuffer(options.user.id) },
        excludeCredentials: toDescriptors(options.excludeCredentials),
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError('failed');
    const r = cred.response as AuthenticatorAttestationResponse;
    const transports = (r.getTransports?.() ?? []).filter(
      (t): t is 'internal' | 'hybrid' => t === 'internal' || t === 'hybrid',
    );
    return {
      id: cred.id,
      rawId: bufferToB64url(cred.rawId),
      response: {
        clientDataJSON: bufferToB64url(r.clientDataJSON),
        attestationObject: bufferToB64url(r.attestationObject),
        ...(transports.length ? { transports } : {}),
      },
      type: 'public-key',
    };
  } catch (e) {
    throw mapError(e);
  }
}

export async function authenticatePasskey(
  options: LoginOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  if (!passkeySupported()) throw new PasskeyError('unsupported');
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        ...options,
        challenge: b64urlToBuffer(options.challenge),
        allowCredentials: toDescriptors(options.allowCredentials),
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError('failed');
    const r = cred.response as AuthenticatorAssertionResponse;
    return {
      id: cred.id,
      rawId: bufferToB64url(cred.rawId),
      response: {
        clientDataJSON: bufferToB64url(r.clientDataJSON),
        authenticatorData: bufferToB64url(r.authenticatorData),
        signature: bufferToB64url(r.signature),
        ...(r.userHandle ? { userHandle: bufferToB64url(r.userHandle) } : {}),
      },
      type: 'public-key',
    };
  } catch (e) {
    throw mapError(e);
  }
}

// --- Clientes API

/** Publico: sin Authorization. */
export const fetchLoginOptions = (): Promise<LoginOptionsJSON> =>
  apiFetch<LoginOptionsJSON>('/api/passkeys/login/options', { method: 'POST' });

/** Publico: devuelve la sesion (`s1.`); el llamador la guarda con setToken. */
export const loginWithPasskey = (
  response: AuthenticationResponseJSON,
): Promise<PasskeyLoginResult> =>
  apiFetch<PasskeyLoginResult>('/api/passkeys/login', { method: 'POST', body: { response } });

/** Solo token estatico. */
export const fetchRegisterOptions = (): Promise<RegisterOptionsJSON> =>
  apiFetch<RegisterOptionsJSON>('/api/passkeys/register/options', { method: 'POST' });

/** Solo token estatico. */
export const submitRegistration = (
  response: RegistrationResponseJSON,
  label?: string,
): Promise<PasskeyInfo> =>
  apiFetch<PasskeyInfo>('/api/passkeys/register', {
    method: 'POST',
    body: label ? { response, label } : { response },
  });

export const listPasskeys = async (): Promise<PasskeyInfo[]> =>
  (await apiFetch<PasskeysResponse>('/api/passkeys')).passkeys;

export const revokePasskey = (id: string): Promise<void> =>
  apiFetch<void>(`/api/passkeys/${id}`, { method: 'DELETE' });

export const revokeAllSessions = (): Promise<void> =>
  apiFetch<void>('/api/sessions', { method: 'DELETE' });
