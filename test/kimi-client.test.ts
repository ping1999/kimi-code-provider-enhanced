import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { KpeError } from '../src/errors.ts';
import {
  KimiClient,
  resolveKimiConnection,
  validateKimiBaseUrl,
} from '../src/kimi-client.ts';
import { listLiveServerInstances } from '../src/storage.ts';
import { stubFetch } from './helpers.ts';

const SECRET = 'kimi-envelope-secret-XYZ';
const BASE = 'http://127.0.0.1:1688';

function envelope(data: unknown, code = 0) {
  return { code, msg: 'ok', data };
}

function metaEnvelope(serverId = 'srv-1', startedAt = '2025-01-01T00:00:00Z') {
  return envelope({ server_id: serverId, started_at: startedAt });
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kpe-client-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('validateKimiBaseUrl', () => {
  it('accepts loopback http only', () => {
    assert.equal(validateKimiBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assert.throws(() => validateKimiBaseUrl('https://127.0.0.1:8080'), KpeError);
    assert.throws(() => validateKimiBaseUrl('http://10.0.0.5:8080'), KpeError);
    assert.throws(() => validateKimiBaseUrl('http://127.0.0.1:8080/x'), KpeError);
    assert.throws(() => validateKimiBaseUrl('http://u:p@127.0.0.1:8080'), KpeError);
    assert.throws(() => validateKimiBaseUrl('http://127.0.0.1:8080?q=1'), KpeError);
  });
});

describe('resolveKimiConnection', () => {
  it('derives serverKey from server identity, not just URL', async () => {
    const first = stubFetch(() => ({ status: 200, json: metaEnvelope('srv-a') }));
    const second = stubFetch(() => ({ status: 200, json: metaEnvelope('srv-b') }));
    const env = { KPE_KIMI_URL: BASE, KPE_KIMI_TOKEN: 'env-token' };
    const conn1 = await resolveKimiConnection({ env, home, fetchImpl: first.fetch });
    const conn2 = await resolveKimiConnection({ env, home, fetchImpl: second.fetch });
    assert.notEqual(conn1.serverKey, conn2.serverKey);
    const restarted = stubFetch(() => ({
      status: 200,
      json: metaEnvelope('srv-a', '2025-01-02T00:00:00Z'),
    }));
    const conn3 = await resolveKimiConnection({ env, home, fetchImpl: restarted.fetch });
    assert.notEqual(conn1.serverKey, conn3.serverKey);
  });

  it('uses home server.token only when registry URL matches exactly', async () => {
    await mkdir(join(home, 'server', 'instances'), { recursive: true });
    await writeFile(join(home, 'server.token'), 'test-token-value\n', 'utf8');
    await writeFile(
      join(home, 'server', 'instances', 'i1.json'),
      JSON.stringify({
        server_id: 'srv-1',
        pid: process.pid,
        host: '127.0.0.1',
        port: 1688,
        started_at: 1,
        heartbeat_at: Date.now(),
      }),
      'utf8',
    );
    const { fetch } = stubFetch((url) => {
      if (url.endsWith('/meta')) return { status: 200, json: metaEnvelope('srv-1') };
      return { status: 200, json: envelope({}) };
    });
    const conn = await resolveKimiConnection({
      env: { KPE_KIMI_URL: BASE },
      home,
      fetchImpl: fetch,
    });
    assert.equal(conn.token, 'test-token-value');
    const noMatch = await resolveKimiConnection({
      env: { KPE_KIMI_URL: 'http://127.0.0.1:9999', KPE_KIMI_TOKEN: 'env-token' },
      home,
      fetchImpl: fetch,
    });
    assert.equal(noMatch.token, 'env-token');
  });

  it('fails auth clearly when no token and no registry match', async () => {
    const { fetch } = stubFetch(() => ({ status: 401, json: envelope({}, 401) }));
    await assert.rejects(
      resolveKimiConnection({ env: { KPE_KIMI_URL: BASE }, home, fetchImpl: fetch }),
      (error: unknown) => error instanceof KpeError && error.code === 'KIMI_AUTH_FAILED',
    );
  });
});

describe('listLiveServerInstances', () => {
  function instance(partial: Record<string, unknown>) {
    return {
      server_id: 'srv-1',
      pid: process.pid,
      host: '127.0.0.1',
      port: 1688,
      started_at: 1,
      heartbeat_at: Date.now(),
      ...partial,
    };
  }

  it('rejects malformed and unsafe registry entries', async () => {
    const dir = join(home, 'server', 'instances');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bad-pid.json'), JSON.stringify(instance({ pid: -5 })), 'utf8');
    await writeFile(join(dir, 'bad-port.json'), JSON.stringify(instance({ port: 70000 })), 'utf8');
    await writeFile(
      join(dir, 'future.json'),
      JSON.stringify(instance({ heartbeat_at: Date.now() + 120_000 })),
      'utf8',
    );
    await writeFile(
      join(dir, 'remote.json'),
      JSON.stringify(instance({ host: '10.0.0.8' })),
      'utf8',
    );
    await writeFile(join(dir, 'ok.json'), JSON.stringify(instance({})), 'utf8');
    const live = await listLiveServerInstances(home);
    assert.equal(live.length, 1);
    assert.equal(live[0]!.port, 1688);
  });
});

describe('KimiClient', () => {
  function clientFor(handler: (url: string) => { status: number; json: unknown }) {
    const { fetch } = stubFetch(handler);
    return new KimiClient(
      { baseUrl: BASE, token: 'tok', serverKey: 'k' },
      fetch,
    );
  }

  it('does not echo server envelope messages that may contain secrets', async () => {
    const client = clientFor(() => ({
      status: 200,
      json: { code: 50001, msg: `validation failed for key ${SECRET}`, data: null },
    }));
    await assert.rejects(client.getConfig(), (error: unknown) => {
      assert.ok(error instanceof KpeError);
      assert.equal(error.code, 'KIMI_ERROR');
      assert.ok(!error.message.includes(SECRET));
      assert.match(error.message, /50001/);
      return true;
    });
  });

  it('getConfig requires a providers object and validates models shape', async () => {
    const noProviders = clientFor(() => ({ status: 200, json: envelope({}) }));
    await assert.rejects(
      noProviders.getConfig(),
      (error: unknown) => error instanceof KpeError && error.code === 'KIMI_BAD_RESPONSE',
    );
    const badModels = clientFor(() => ({
      status: 200,
      json: envelope({ providers: {}, models: 'oops' }),
    }));
    await assert.rejects(
      badModels.getConfig(),
      (error: unknown) => error instanceof KpeError && error.code === 'KIMI_BAD_RESPONSE',
    );
    const empty = clientFor(() => ({
      status: 200,
      json: envelope({ providers: {} }),
    }));
    const config = await empty.getConfig();
    assert.deepEqual(config.models, {});
  });

  it('getProvider verifies the returned id matches the request', async () => {
    const client = clientFor(() => ({
      status: 200,
      json: envelope({ id: 'different-provider', type: 'openai' }),
    }));
    await assert.rejects(
      client.getProvider('demo'),
      (error: unknown) => error instanceof KpeError && error.code === 'KIMI_BAD_RESPONSE',
    );
  });

  it('listProviders sanitizes credential-bearing base urls', async () => {
    const client = clientFor(() => ({
      status: 200,
      json: envelope({
        items: [
          {
            id: 'demo',
            type: 'openai',
            base_url: 'http://user:pass@127.0.0.1:9/v1?api_key=abc#frag',
            has_api_key: true,
          },
        ],
      }),
    }));
    const providers = await client.listProviders();
    assert.equal(providers[0]!.base_url, 'http://127.0.0.1:9/v1');
    assert.ok(!JSON.stringify(providers).includes('user:pass'));
    assert.ok(!JSON.stringify(providers).includes('api_key=abc'));
  });

  it('listProviders and listModels reject malformed envelopes', async () => {
    const badProviders = clientFor(() => ({ status: 200, json: envelope({ items: {} }) }));
    await assert.rejects(
      badProviders.listProviders(),
      (error: unknown) => error instanceof KpeError && error.code === 'KIMI_BAD_RESPONSE',
    );
    const badModels = clientFor(() => ({ status: 200, json: envelope({}) }));
    await assert.rejects(
      badModels.listModels(),
      (error: unknown) => error instanceof KpeError && error.code === 'KIMI_BAD_RESPONSE',
    );
  });

  it('maps 401 and other http errors to fixed codes', async () => {
    const unauthorized = clientFor(() => ({ status: 401, json: `secret ${SECRET}` }));
    await assert.rejects(unauthorized.getConfig(), (error: unknown) => {
      assert.ok(error instanceof KpeError && error.code === 'KIMI_AUTH_FAILED');
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
    const broken = clientFor(() => ({ status: 502, json: `upstream ${SECRET}` }));
    await assert.rejects(broken.getConfig(), (error: unknown) => {
      assert.ok(error instanceof KpeError && error.code === 'KIMI_HTTP_ERROR');
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
  });
});
