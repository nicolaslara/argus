import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { tokenOk, hostAllowed } from './auth.ts';

// Live & inspection #2 (SUB-TASK B) — the per-launch token gate + DNS-rebinding host/origin
// gate. These run in index.ts BEFORE handleStream / any filesystem access (boundaries.md §4),
// so a /stream request without a valid token is rejected 401 and NO stream is ever opened.

const TOKEN = 'secret-token-abc';

/** A minimal IncomingMessage stand-in carrying just the headers the guards read. */
function req(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** The /stream URL a live EventSource subscribes to (token rides in the query, not a header). */
function streamUrl(query = ''): URL {
  return new URL(`http://127.0.0.1:4317/api/runs/slug/sess/wf_1/stream${query}`);
}

describe('tokenOk — the /stream + /api bearer gate', () => {
  it('rejects a /stream request with NO token (→ caller sends 401, no stream opened)', () => {
    expect(tokenOk(req(), streamUrl(), TOKEN)).toBe(false);
  });

  it('rejects a wrong bearer header', () => {
    expect(tokenOk(req({ authorization: 'Bearer not-the-token' }), streamUrl(), TOKEN)).toBe(false);
  });

  it('rejects a wrong ?token= query param', () => {
    expect(tokenOk(req(), streamUrl('?token=nope'), TOKEN)).toBe(false);
  });

  it('accepts the correct Authorization: Bearer header (the /api fetch path)', () => {
    expect(tokenOk(req({ authorization: `Bearer ${TOKEN}` }), streamUrl(), TOKEN)).toBe(true);
  });

  it('accepts the correct ?token= query param (the /stream EventSource path — no headers)', () => {
    expect(tokenOk(req(), streamUrl(`?token=${TOKEN}`), TOKEN)).toBe(true);
  });

  it('a header-less, query-less request never authorizes (the unauthenticated /stream case)', () => {
    expect(tokenOk(req(), streamUrl(), TOKEN)).toBe(false);
  });
});

describe('hostAllowed — DNS-rebinding guard', () => {
  const HOSTS = new Set(['127.0.0.1:4317', 'localhost:4317']);
  const ORIGINS = new Set(['http://127.0.0.1:4317', 'http://localhost:4317']);

  it('allows an exact bind host with no Origin', () => {
    expect(hostAllowed(req({ host: '127.0.0.1:4317' }), HOSTS, ORIGINS)).toBe(true);
  });

  it('allows an allowed Host + allowed Origin pair', () => {
    expect(hostAllowed(req({ host: 'localhost:4317', origin: 'http://localhost:4317' }), HOSTS, ORIGINS)).toBe(true);
  });

  it('rejects a foreign Host (a rebinding attempt)', () => {
    expect(hostAllowed(req({ host: 'evil.example.com' }), HOSTS, ORIGINS)).toBe(false);
  });

  it('rejects an allowed Host with a FOREIGN Origin', () => {
    expect(hostAllowed(req({ host: '127.0.0.1:4317', origin: 'http://evil.example.com' }), HOSTS, ORIGINS)).toBe(false);
  });

  it('rejects a missing Host header', () => {
    expect(hostAllowed(req(), HOSTS, ORIGINS)).toBe(false);
  });
});
