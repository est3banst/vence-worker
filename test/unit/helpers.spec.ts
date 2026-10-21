import { describe, it, expect } from 'vitest';
import { corsHeaders, json, isValidId, sanitizeFilename } from '../../src/helpers/helpers';

describe('corsHeaders', () => {
  it('echoes the configured origin and allows every method the API uses', () => {
    const h = corsHeaders('https://vence.uy');
    expect(h['Access-Control-Allow-Origin']).toBe('https://vence.uy');
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(h['Access-Control-Allow-Methods']).toContain(method);
    }
  });

  it('allows the headers the clients actually send', () => {
    const h = corsHeaders('*');
    for (const header of ['Content-Type', 'X-Filename', 'Authorization']) {
      expect(h['Access-Control-Allow-Headers']).toContain(header);
    }
  });

  it('exposes Content-Disposition so a download can read the filename', () => {
    expect(corsHeaders('*')['Access-Control-Expose-Headers']).toContain('Content-Disposition');
  });

  it('varies on Origin, so a cached response is not served to the wrong origin', () => {
    expect(corsHeaders('*')['Vary']).toBe('Origin');
  });
});

describe('json', () => {
  it('serialises the body and keeps the CORS headers', async () => {
    const res = json({ ok: true }, 201, corsHeaders('https://vence.uy'));
    expect(res.status).toBe(201);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://vence.uy');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('declares utf-8, which the Spanish error messages need', async () => {
    const res = json({ error: 'La cuenta ya está pagada' }, 409, {});
    expect(await res.json()).toEqual({ error: 'La cuenta ya está pagada' });
  });
});

describe('isValidId', () => {
  it.each(['abc', 'A1', 'a-b_c', '0'.repeat(128), crypto.randomUUID()])(
    'accepts %s', id => expect(isValidId(id)).toBe(true)
  );

  it.each([
    ['empty', ''],
    ['too long', '0'.repeat(129)],
    ['a slash', 'a/b'],
    ['a dot', 'a.b'],
    ['a space', 'a b'],
    ['a quote', "a'b"],
    ['a percent', 'a%2Fb'],
  ])('rejects %s', (_label, id) => expect(isValidId(id)).toBe(false));
});

describe('sanitizeFilename', () => {
  it('falls back for null or empty input', () => {
    expect(sanitizeFilename(null)).toBe('recibo.pdf');
    expect(sanitizeFilename('')).toBe('recibo.pdf');
  });

  it('decodes percent-encoding, which is how the client sends it', () => {
    expect(sanitizeFilename('factura%20UTE.pdf')).toBe('factura UTE.pdf');
  });

  it('keeps a malformed escape rather than throwing', () => {
    expect(sanitizeFilename('100%.pdf')).toBe('100%.pdf');
  });

  it('strips any directory component, including Windows separators', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\me\\f.pdf')).toBe('f.pdf');
    expect(sanitizeFilename('/absolute/path/f.pdf')).toBe('f.pdf');
  });

  it('replaces characters that are illegal in a filename', () => {
    expect(sanitizeFilename('in<va>l:i"d|?*.pdf')).toBe('in_va_l_i_d___.pdf');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('a\u0000b\u001fc.pdf')).toBe('a_b_c.pdf');
  });

  it('caps the length at 200', () => {
    expect(sanitizeFilename('x'.repeat(500)).length).toBe(200);
  });

  it('falls back when nothing usable survives', () => {
    expect(sanitizeFilename('/')).toBe('recibo.pdf');
    expect(sanitizeFilename('   ')).toBe('recibo.pdf');
  });

  it('keeps accented filenames intact', () => {
    expect(sanitizeFilename('facturación.pdf')).toBe('facturación.pdf');
  });
});
