import { describe, expect, it } from 'vitest';
import { clickTarget, parsePush, safeHash } from './swPush';

describe('parsePush', () => {
  it('payload valido -> titulo, cuerpo, tag y url', () => {
    const p = parsePush(
      JSON.stringify({
        v: 1,
        title: 'Hoy: 2 eventos',
        body: '09:30 Dentista',
        url: '#/evento/a/b',
        tag: 'digest-2026-10-26',
      }),
    );
    expect(p.title).toBe('Hoy: 2 eventos');
    expect(p.options).toMatchObject({
      body: '09:30 Dentista',
      tag: 'digest-2026-10-26',
      data: { url: '#/evento/a/b' },
    });
  });

  it.each([null, undefined, '', 'no json', '[]', '42', 'null', '{"title":5}'])(
    'payload invalido %j -> notificacion generica (nunca silenciosa)',
    (text) => {
      const p = parsePush(text);
      expect(p.title).toBe('Organizador');
      expect(p.options.body).toBe('Tienes novedades');
      expect(p.options.data.url).toBe('#/hoy');
      expect(p.options.tag).toBeUndefined();
    },
  );

  it('url que no es hash de la app -> #/hoy', () => {
    for (const url of [
      'https://evil.com',
      '//evil.com',
      'javascript:alert(1)',
      '/organizador/',
      5,
    ]) {
      expect(parsePush(JSON.stringify({ title: 't', url })).options.data.url).toBe('#/hoy');
    }
  });

  it('recorta textos largos', () => {
    const p = parsePush(JSON.stringify({ title: 'x'.repeat(500), body: 'y'.repeat(2000) }));
    expect(p.title.length).toBe(120);
    expect(p.options.body.length).toBe(500);
  });
});

describe('clickTarget', () => {
  const scope = 'https://josedcp20.github.io/organizador/';
  it('scope + hash', () => {
    expect(clickTarget(scope, '#/hoy')).toBe(`${scope}#/hoy`);
    expect(clickTarget(scope, '#/evento/c/e')).toBe(`${scope}#/evento/c/e`);
  });
  it('nunca sale del scope', () => {
    expect(clickTarget(scope, 'https://evil.com/#/hoy')).toBe(`${scope}#/hoy`);
    expect(clickTarget(scope, undefined)).toBe(`${scope}#/hoy`);
    expect(safeHash('#/' + 'a'.repeat(600))).toBe('#/hoy');
  });
});
