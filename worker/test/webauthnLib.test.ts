import { describe, expect, it } from 'vitest';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { FakeAuthenticator, RP_ID, WEBAUTHN_ORIGIN } from './webauthnFake';

const common = { expectedOrigin: WEBAUTHN_ORIGIN, expectedRPID: RP_ID };

async function enroll(auth: FakeAuthenticator) {
  const opts = await generateRegistrationOptions({
    rpName: 'Organizador',
    rpID: RP_ID,
    userName: 'jose',
    attestationType: 'none',
    authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
  });
  return verifyRegistrationResponse({
    ...common,
    response: await auth.register(opts.challenge),
    expectedChallenge: opts.challenge,
    requireUserVerification: true,
  });
}

describe('@simplewebauthn/server en workerd', () => {
  it('registra y autentica con un autenticador software', async () => {
    const auth = await FakeAuthenticator.create();
    const v = await enroll(auth);
    expect(v.verified).toBe(true);
    const credential = v.registrationInfo!.credential;
    expect(credential.id).toBe(auth.credentialId);

    const opts = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required' });
    const a = await verifyAuthenticationResponse({
      ...common,
      response: await auth.assert(opts.challenge, { counter: 1 }),
      expectedChallenge: opts.challenge,
      credential,
      requireUserVerification: true,
    });
    expect(a.verified).toBe(true);
    expect(a.authenticationInfo.newCounter).toBe(1);
  });

  it('expectedChallenge acepta funcion async', async () => {
    const auth = await FakeAuthenticator.create();
    const opts = await generateRegistrationOptions({ rpName: 'O', rpID: RP_ID, userName: 'j' });
    const seen: string[] = [];
    const v = await verifyRegistrationResponse({
      ...common,
      response: await auth.register(opts.challenge),
      expectedChallenge: async (c) => {
        await Promise.resolve();
        seen.push(c);
        return c === opts.challenge;
      },
    });
    expect(v.verified).toBe(true);
    expect(seen).toEqual([opts.challenge]);

    await expect(
      verifyRegistrationResponse({
        ...common,
        response: await auth.register(opts.challenge),
        expectedChallenge: async () => false,
      }),
    ).rejects.toThrow();
  });

  it('rechaza origin, rpId, UV, tipo, challenge y firma incorrectos', async () => {
    const auth = await FakeAuthenticator.create();
    const credential = (await enroll(auth)).registrationInfo!.credential;
    const opts = await generateAuthenticationOptions({ rpID: RP_ID });
    const verify = (
      response: Awaited<ReturnType<FakeAuthenticator['assert']>>,
      ch = opts.challenge,
    ) => verifyAuthenticationResponse({ ...common, response, expectedChallenge: ch, credential });
    const assert = (o: Parameters<FakeAuthenticator['assert']>[1]) =>
      auth.assert(opts.challenge, o);

    await expect(verify(await assert({ origin: 'https://evil.example' }))).rejects.toThrow();
    await expect(verify(await assert({ rpId: 'evil.example' }))).rejects.toThrow();
    await expect(verify(await assert({ flags: { uv: false } }))).rejects.toThrow();
    await expect(verify(await assert({ type: 'webauthn.create' }))).rejects.toThrow();
    await expect(verify(await assert({}), 'otro-challenge')).rejects.toThrow();
    // Firma de otra clave con el id de la credencial registrada.
    const other = await FakeAuthenticator.create();
    const forged = { ...(await other.assert(opts.challenge)), id: credential.id };
    await expect(verify(forged)).rejects.toThrow();
  });
});
