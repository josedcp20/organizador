import { env } from 'cloudflare:workers';
import { describe, expect, it, beforeEach } from 'vitest';
import type { Env } from '../src/env';
import { importStateKey } from '../src/crypto/signedToken';
import { toBase64Url } from '../src/crypto/encoding';
import { issueChallenge, checkChallenge, consumeChallenge } from '../src/webauthn/challenge';
import { rpConfig } from '../src/webauthn/config';

const rand32 = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

describe('WebAuthn challenges', () => {
  let key: CryptoKey;
  const testEnv = (): Env => ({
    ...(env as unknown as Env),
    OAUTH_STATE_KEY: rand32(),
  });

  beforeEach(async () => {
    const e = testEnv();
    const imported = await importStateKey(e.OAUTH_STATE_KEY);
    if (!imported) throw new Error('OAUTH_STATE_KEY invalido');
    key = imported;
  });

  describe('issueChallenge', () => {
    it('retorna una cadena base64url', async () => {
      const challenge = await issueChallenge(key, 'webauthn_reg');
      expect(typeof challenge).toBe('string');
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('emite challenges diferentes cada vez (nonce aleatorio)', async () => {
      const c1 = await issueChallenge(key, 'webauthn_reg');
      const c2 = await issueChallenge(key, 'webauthn_reg');
      expect(c1).not.toBe(c2);
    });
  });

  describe('checkChallenge', () => {
    it('verifica un challenge valido con proposito webauthn_reg', async () => {
      const challenge = await issueChallenge(key, 'webauthn_reg');
      const result = await checkChallenge(key, 'webauthn_reg', challenge, Date.now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
        expect(result.exp).toBeGreaterThan(Date.now());
      }
    });

    it('verifica un challenge valido con proposito webauthn_login', async () => {
      const challenge = await issueChallenge(key, 'webauthn_login');
      const result = await checkChallenge(key, 'webauthn_login', challenge, Date.now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.exp).toBeGreaterThan(Date.now());
      }
    });

    it('rechaza un challenge con proposito incorrecto', async () => {
      const challenge = await issueChallenge(key, 'webauthn_reg');
      const result = await checkChallenge(key, 'webauthn_login', challenge, Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['invalid', 'expired']).toContain(result.reason);
    });

    it('rechaza un challenge caducado', async () => {
      const challenge = await issueChallenge(key, 'webauthn_reg');
      const futureMs = Date.now() + 10 * 60 * 1000; // 10 min en el futuro
      const result = await checkChallenge(key, 'webauthn_reg', challenge, futureMs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('expired');
    });

    it('rechaza base64url invalido', async () => {
      const result = await checkChallenge(key, 'webauthn_reg', '!!!invalid!!!', Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid');
    });
  });

  describe('consumeChallenge', () => {
    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM webauthn_challenges_used').run();
    });

    it('consume un challenge de una sola vez', async () => {
      const challenge = await issueChallenge(key, 'webauthn_reg');
      const result1 = await checkChallenge(key, 'webauthn_reg', challenge, Date.now());
      expect(result1.ok).toBe(true);
      if (!result1.ok) throw new Error('Challenge invalido');

      const consumed = await consumeChallenge(env.DB, result1.nonce, result1.exp);
      expect(consumed).toBe(true);
    });

    it('rechaza una segunda canjacion del mismo nonce', async () => {
      const challenge = await issueChallenge(key, 'webauthn_reg');
      const result = await checkChallenge(key, 'webauthn_reg', challenge, Date.now());
      if (!result.ok) throw new Error('Challenge invalido');

      const consumed1 = await consumeChallenge(env.DB, result.nonce, result.exp);
      expect(consumed1).toBe(true);

      const consumed2 = await consumeChallenge(env.DB, result.nonce, result.exp);
      expect(consumed2).toBe(false);
    });

    it('maneja dos consumos concurrentes del mismo nonce', async () => {
      const challenge = await issueChallenge(key, 'webauthn_reg');
      const result = await checkChallenge(key, 'webauthn_reg', challenge, Date.now());
      if (!result.ok) throw new Error('Challenge invalido');

      // Lanzar dos consumos en paralelo
      const [consumed1, consumed2] = await Promise.all([
        consumeChallenge(env.DB, result.nonce, result.exp),
        consumeChallenge(env.DB, result.nonce, result.exp),
      ]);

      // Exactamente uno debe triunfar (replay protection)
      expect(consumed1 === true || consumed2 === true).toBe(true);
      expect(consumed1 === true && consumed2 === true).toBe(false);
    });
  });

  describe('rpConfig', () => {
    it('deriva rpID desde ALLOWED_ORIGIN valido https', () => {
      const config = rpConfig({
        ALLOWED_ORIGIN: 'https://josedcp20.github.io',
      } as Env);
      expect(config).not.toBeNull();
      expect(config?.rpID).toBe('josedcp20.github.io');
      expect(config?.origin).toBe('https://josedcp20.github.io');
      expect(config?.rpName).toBe('Organizador');
    });

    it('permite http solo en localhost', () => {
      const config = rpConfig({
        ALLOWED_ORIGIN: 'http://localhost:5173',
      } as Env);
      expect(config).not.toBeNull();
      expect(config?.rpID).toBe('localhost');
      expect(config?.origin).toBe('http://localhost:5173');
    });

    it('rechaza http en dominio publico (fallo cerrado)', () => {
      const config = rpConfig({
        ALLOWED_ORIGIN: 'http://example.com',
      } as Env);
      expect(config).toBeNull();
    });

    it('rechaza ALLOWED_ORIGIN vacio o ausente', () => {
      const config1 = rpConfig({ ALLOWED_ORIGIN: '' } as Env);
      const config2 = rpConfig({} as Env);
      expect(config1).toBeNull();
      expect(config2).toBeNull();
    });

    it('rechaza URL malformada', () => {
      const config = rpConfig({ ALLOWED_ORIGIN: 'not a url' } as Env);
      expect(config).toBeNull();
    });

    it('descarta barra final y ruta', () => {
      const config = rpConfig({
        ALLOWED_ORIGIN: 'https://josedcp20.github.io/organizador/',
      } as Env);
      expect(config?.origin).toBe('https://josedcp20.github.io');
    });
  });
});
