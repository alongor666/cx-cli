import { describe, it, expect } from 'vitest';
import { exitCodeForError, EXIT } from '../exit-codes.js';
import { CxApiError } from '../api.js';

describe('exit codes', () => {
  it('401 → AUTH(2)', () => {
    expect(exitCodeForError(new CxApiError(401, 'x'))).toBe(EXIT.AUTH);
  });
  it('403 → FORBIDDEN(3)', () => {
    expect(exitCodeForError(new CxApiError(403, 'x'))).toBe(EXIT.FORBIDDEN);
  });
  it('429 → RATE_LIMITED(5)', () => {
    expect(exitCodeForError(new CxApiError(429, 'x'))).toBe(EXIT.RATE_LIMITED);
  });
  it('500 → GENERAL(1)', () => {
    expect(exitCodeForError(new CxApiError(500, 'x'))).toBe(EXIT.GENERAL);
  });
  it('非 CxApiError → GENERAL(1)', () => {
    expect(exitCodeForError(new Error('x'))).toBe(EXIT.GENERAL);
  });
});
