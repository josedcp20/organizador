import { describe, expect, it } from 'vitest';
import { getVersion } from './version';

describe('getVersion', () => {
  it('usa APP_VERSION si esta definida', () => {
    expect(getVersion({ APP_VERSION: 'abc1234' })).toBe('abc1234');
  });
  it("cae a 'dev' si falta o esta vacia", () => {
    expect(getVersion({})).toBe('dev');
    expect(getVersion({ APP_VERSION: '  ' })).toBe('dev');
  });
});
