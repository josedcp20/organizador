// Autenticador WebAuthn software solo para tests (ES256, attestation 'none').
import { isoBase64URL, isoCBOR, isoUint8Array } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

export const RP_ID = 'josedcp20.github.io';
export const WEBAUTHN_ORIGIN = 'https://josedcp20.github.io';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface FakeFlags {
  up?: boolean; // por defecto true
  uv?: boolean; // por defecto true
  be?: boolean;
  bs?: boolean;
}

export interface FakeOptions {
  origin?: string;
  rpId?: string;
  counter?: number; // signCount firmado; por defecto 0 (assert: el contador interno del autenticador)
  flags?: FakeFlags;
  type?: string; // clientDataJSON.type; por defecto el correcto
}

type U8 = Uint8Array<ArrayBuffer>;
const utf8 = (s: string): U8 => new Uint8Array(new TextEncoder().encode(s));
const sha256 = async (d: U8): Promise<U8> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', d));

function flagsByte(f: FakeFlags = {}, extra = 0): number {
  return (
    extra |
    (f.up === false ? 0 : FLAG_UP) |
    (f.uv === false ? 0 : FLAG_UV) |
    (f.be ? FLAG_BE : 0) |
    (f.bs ? FLAG_BS : 0)
  );
}

function authData(rpIdHash: U8, flags: number, counter: number, tail?: U8) {
  const head = new Uint8Array(37);
  head.set(rpIdHash, 0);
  head[32] = flags;
  new DataView(head.buffer).setUint32(33, counter, false);
  return tail ? isoUint8Array.concat([head, tail]) : head;
}

// WebCrypto devuelve la firma ECDSA como r||s (P1363); WebAuthn la envia en DER.
function p1363ToDer(sig: U8): U8 {
  const int = (b: U8) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = isoUint8Array.concat([new Uint8Array([0]), v]);
    return isoUint8Array.concat([new Uint8Array([0x02, v.length]), v]);
  };
  const body = isoUint8Array.concat([int(sig.slice(0, 32)), int(sig.slice(32))]);
  return isoUint8Array.concat([new Uint8Array([0x30, body.length]), body]);
}

export class FakeAuthenticator {
  readonly credentialId: string; // base64url
  counter: number;

  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly rawCredId: U8,
    private readonly opts: FakeOptions,
  ) {
    this.credentialId = isoBase64URL.fromBuffer(rawCredId);
    this.counter = opts.counter ?? 0;
  }

  static async create(opts: FakeOptions = {}): Promise<FakeAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return new FakeAuthenticator(keys, crypto.getRandomValues(new Uint8Array(32)), opts);
  }

  private clientData(type: string, challenge: string, m: FakeOptions): U8 {
    return utf8(
      JSON.stringify({
        type: m.type ?? type,
        challenge,
        origin: m.origin ?? WEBAUTHN_ORIGIN,
        crossOrigin: false,
      }),
    );
  }

  /** Respuesta de navigator.credentials.create() con attestation 'none'. */
  async register(challenge: string, o: FakeOptions = {}): Promise<RegistrationResponseJSON> {
    const m = { ...this.opts, ...o };
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], // kty EC2
      [3, -7], // alg ES256
      [-1, 1], // crv P-256
      [-2, isoBase64URL.toBuffer(jwk.x!)],
      [-3, isoBase64URL.toBuffer(jwk.y!)],
    ]);
    const tail = isoUint8Array.concat([
      new Uint8Array(16), // aaguid
      new Uint8Array([0, this.rawCredId.length]),
      this.rawCredId,
      isoCBOR.encode(cose),
    ]);
    const rpHash = await sha256(utf8(m.rpId ?? RP_ID));
    const ad = authData(rpHash, flagsByte(m.flags, FLAG_AT), m.counter ?? 0, tail);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', ad],
      ]) as never,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(this.clientData('webauthn.create', challenge, m)),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** Respuesta de navigator.credentials.get(); fija this.counter al signCount firmado. */
  async assert(challenge: string, o: FakeOptions = {}): Promise<AuthenticationResponseJSON> {
    const m = { ...this.opts, ...o };
    this.counter = o.counter ?? this.counter;
    const cd = this.clientData('webauthn.get', challenge, m);
    const rpHash = await sha256(utf8(m.rpId ?? RP_ID));
    const ad = authData(rpHash, flagsByte(m.flags), this.counter);
    const signed = isoUint8Array.concat([ad, await sha256(cd)]);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(cd),
        authenticatorData: isoBase64URL.fromBuffer(ad),
        signature: isoBase64URL.fromBuffer(p1363ToDer(sig)),
      },
    };
  }
}
