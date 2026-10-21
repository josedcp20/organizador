import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '../src/crypto/encoding';
import { SecretBoxError, importEncKey, open, seal } from '../src/crypto/secretBox';
import { importStateKey, signToken, verifyToken } from '../src/crypto/signedToken';

const rawKey = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const AAD = 'organizador/test/v1';

describe('secretBox (AES-256-GCM)', () => {
  it('cifra y descifra (ida y vuelta), incluido texto vacio y unicode', async () => {
    const key = (await importEncKey(rawKey()))!;
    for (const pt of ['1//refresh-token-abc', '', 'ñ€😀'.repeat(50)]) {
      const box = await seal(key, pt, AAD);
      expect(box.startsWith('v1.')).toBe(true);
      expect(box).not.toContain(pt || '\u0000');
      expect(await open(key, box, AAD)).toBe(pt);
    }
  });

  it('usa un IV distinto en cada cifrado (mismo texto -> distinto resultado)', async () => {
    const key = (await importEncKey(rawKey()))!;
    const ivs = new Set<string>();
    const boxes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const box = await seal(key, 'mismo-texto', AAD);
      boxes.add(box);
      ivs.add(box.split('.')[1]!);
      expect(fromBase64Url(box.split('.')[1]!)!.length).toBe(12);
    }
    expect(ivs.size).toBe(20);
    expect(boxes.size).toBe(20);
  });

  it('detecta manipulacion del texto cifrado, del IV, del AAD y la clave equivocada', async () => {
    const key = (await importEncKey(rawKey()))!;
    const other = (await importEncKey(rawKey()))!;
    const box = await seal(key, 'secreto', AAD);
    const [v, iv, ct] = box.split('.') as [string, string, string];

    const flip = (b64: string, idx: number) => {
      const bytes = fromBase64Url(b64)!;
      bytes[idx] = (bytes[idx] ?? 0) ^ 0x01;
      return toBase64Url(bytes);
    };
    const cases = [
      `${v}.${iv}.${flip(ct, 0)}`, // primer byte del cifrado
      `${v}.${iv}.${flip(ct, fromBase64Url(ct)!.length - 1)}`, // tag
      `${v}.${flip(iv, 0)}.${ct}`, // IV
    ];
    for (const bad of cases) {
      await expect(open(key, bad, AAD)).rejects.toMatchObject({ message: 'tampered' });
    }
    await expect(open(key, box, 'otro-contexto')).rejects.toBeInstanceOf(SecretBoxError);
    await expect(open(other, box, AAD)).rejects.toBeInstanceOf(SecretBoxError);
  });

  it('rechaza formatos invalidos o versiones desconocidas', async () => {
    const key = (await importEncKey(rawKey()))!;
    const box = await seal(key, 'x', AAD);
    const [, iv, ct] = box.split('.');
    for (const bad of [
      '',
      'v1',
      `v2.${iv}.${ct}`,
      `v1.${iv}`,
      `v1..${ct}`,
      `v1.${iv}.`,
      `v1.${iv}.${ct}.x`,
    ]) {
      await expect(open(key, bad, AAD)).rejects.toMatchObject({ message: 'bad_format' });
    }
  });

  it('importEncKey falla cerrado: falta, no base64 o longitud distinta de 32 bytes', async () => {
    expect(await importEncKey(undefined)).toBeNull();
    expect(await importEncKey('  ')).toBeNull();
    expect(await importEncKey('no es base64!!')).toBeNull();
    expect(await importEncKey(toBase64Url(new Uint8Array(16)))).toBeNull();
    expect(await importEncKey(toBase64Url(new Uint8Array(33)))).toBeNull();
    // base64 estandar con relleno tambien vale
    expect(
      await importEncKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))),
    ).not.toBeNull();
  });
});

describe('signedToken (HMAC)', () => {
  it('valido, firma manipulada, caducado y proposito distinto', async () => {
    const key = (await importStateKey(rawKey()))!;
    const t = 1_700_000_000_000;
    const tok = await signToken(key, 'state', 'n'.repeat(43), t + 1000);
    expect(await verifyToken(key, 'state', tok, t)).toMatchObject({
      ok: true,
      nonce: 'n'.repeat(43),
    });
    expect(await verifyToken(key, 'state', tok, t + 1000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await verifyToken(key, 'ticket', tok, t)).toEqual({ ok: false, reason: 'invalid' });
    const parts = tok.split('.');
    const tampered = [parts[0], parts[1], String(t + 999_999), parts[3]].join('.');
    expect(await verifyToken(key, 'state', tampered, t)).toEqual({ ok: false, reason: 'invalid' });
    const otherKey = (await importStateKey(rawKey()))!;
    expect(await verifyToken(otherKey, 'state', tok, t)).toEqual({ ok: false, reason: 'invalid' });
    for (const bad of [undefined, null, '', 'v1.a.b.c', 'x'.repeat(300), tok + 'A']) {
      expect((await verifyToken(key, 'state', bad, t)).ok).toBe(false);
    }
  });

  it('importStateKey exige >= 32 bytes', async () => {
    expect(await importStateKey(undefined)).toBeNull();
    expect(await importStateKey(toBase64Url(new Uint8Array(31)))).toBeNull();
    expect(await importStateKey(rawKey())).not.toBeNull();
  });
});
