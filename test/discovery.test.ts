import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildModelsUrl,
  fetchProviderModels,
  resolveProviderCredential,
} from '../src/discovery.ts';
import { fetchJson } from '../src/http.ts';
import { KpeError } from '../src/errors.ts';
import { stubFetch, streamFetch } from './helpers.ts';

const BASE = 'http://127.0.0.1:9/v1';
const SECRET = 'test-provider-key-SECRET';

function modelsPage(ids: string[], extra: Record<string, unknown> = {}) {
  return { data: ids.map((id) => ({ id, context_length: 32768 })), ...extra };
}

describe('buildModelsUrl', () => {
  it('appends /models preserving /v1', () => {
    assert.equal(buildModelsUrl(BASE).pathname, '/v1/models');
    assert.equal(buildModelsUrl(`${BASE}/models`).pathname, '/v1/models');
  });

  it('rejects userinfo, query, fragment and non-local http', () => {
    assert.throws(() => buildModelsUrl('http://user:pw@127.0.0.1/v1'), KpeError);
    assert.throws(() => buildModelsUrl('http://127.0.0.1/v1?x=1'), KpeError);
    assert.throws(() => buildModelsUrl('http://127.0.0.1/v1#f'), KpeError);
    assert.throws(() => buildModelsUrl('http://8.8.8.8/v1'), KpeError);
    assert.throws(() => buildModelsUrl('http://[::ffff:8.8.8.8]/v1'), KpeError);
    assert.throws(() => buildModelsUrl('http://nas.local/v1'), KpeError);
    assert.throws(() => buildModelsUrl('ftp://127.0.0.1/v1'), KpeError);
    assert.equal(buildModelsUrl('https://api.example.com/v1').protocol, 'https:');
  });

  it('allows http on loopback and private network addresses', () => {
    for (const base of [
      'http://localhost/v1',
      'http://192.168.31.237/v1',
      'http://10.0.0.5/v1',
      'http://172.16.8.1/v1',
      'http://169.254.1.1/v1',
      'http://100.64.1.1/v1',
      'http://[fd12:3456::1]/v1',
      'http://[fe80::1]/v1',
      'http://[::1]/v1',
      'http://[::ffff:192.168.1.10]/v1',
    ]) {
      assert.equal(buildModelsUrl(base).pathname, '/v1/models', base);
    }
  });
});

describe('fetchProviderModels', () => {
  it('fetches a single page and sends the bearer key', async () => {
    const { fetch, requests } = stubFetch(() => ({
      status: 200,
      json: modelsPage(['m1', 'm2']),
    }));
    const result = await fetchProviderModels({ baseUrl: BASE, apiKey: SECRET, fetchImpl: fetch });
    assert.deepEqual(result.models.map((m) => m.id), ['m1', 'm2']);
    assert.equal(requests.length, 1);
    const headers = requests[0]!.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], `Bearer ${SECRET}`);
    assert.equal(requests[0]!.init.redirect, 'error');
  });

  it('follows same-origin same-path next and dedupes ids', async () => {
    const { fetch, requests } = stubFetch((url) => {
      if (url === 'http://127.0.0.1:9/v1/models') {
        return {
          status: 200,
          json: modelsPage(['a', 'b'], { next: 'http://127.0.0.1:9/v1/models?cursor=2' }),
        };
      }
      return { status: 200, json: modelsPage(['b', 'c']) };
    });
    const result = await fetchProviderModels({ baseUrl: BASE, apiKey: SECRET, fetchImpl: fetch });
    assert.equal(result.pageCount, 2);
    assert.deepEqual(result.models.map((m) => m.id), ['a', 'b', 'c']);
    assert.equal(requests.length, 2);
  });

  it('rejects cross-origin next urls', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: modelsPage(['a'], { next: 'https://evil.example.com/v1/models?x=1' }),
    }));
    await assert.rejects(
      fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch }),
      (error: unknown) => error instanceof KpeError && error.code === 'PROVIDER_BAD_RESPONSE',
    );
  });

  it('rejects same-origin next urls on a different path', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: modelsPage(['a'], { next: 'http://127.0.0.1:9/v1/admin' }),
    }));
    await assert.rejects(
      fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch }),
      (error: unknown) => error instanceof KpeError && error.code === 'PROVIDER_BAD_RESPONSE',
    );
  });

  it('rejects next urls carrying credential query params', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: modelsPage(['a'], { next: 'http://127.0.0.1:9/v1/models?api_key=abc' }),
    }));
    await assert.rejects(
      fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch }),
      (error: unknown) => error instanceof KpeError && error.code === 'PROVIDER_BAD_RESPONSE',
    );
  });

  it('supports has_more with last_id cursor', async () => {
    const { fetch, requests } = stubFetch((url) => {
      if (url === 'http://127.0.0.1:9/v1/models') {
        return { status: 200, json: modelsPage(['a'], { has_more: true, last_id: 'a' }) };
      }
      return { status: 200, json: modelsPage(['b']) };
    });
    const result = await fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch });
    assert.deepEqual(result.models.map((m) => m.id), ['a', 'b']);
    assert.match(requests[1]!.url, /after=a/);
  });

  it('fails on has_more without a usable cursor', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: modelsPage(['a'], { has_more: true }),
    }));
    await assert.rejects(
      fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch }),
      (error: unknown) => error instanceof KpeError && error.code === 'PROVIDER_BAD_RESPONSE',
    );
  });

  it('rejects repeated pagination urls', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: modelsPage(['a'], { next: 'http://127.0.0.1:9/v1/models' }),
    }));
    await assert.rejects(
      fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch }),
      (error: unknown) => error instanceof KpeError && error.code === 'PROVIDER_BAD_RESPONSE',
    );
  });

  it('suppresses 401 bodies that may contain secrets', async () => {
    const { fetch } = stubFetch(() => ({
      status: 401,
      json: { error: `invalid token ${SECRET}` },
    }));
    await assert.rejects(
      fetchProviderModels({ baseUrl: BASE, apiKey: SECRET, fetchImpl: fetch }),
      (error: unknown) => {
        assert.ok(error instanceof KpeError);
        assert.equal(error.code, 'PROVIDER_AUTH_FAILED');
        assert.ok(!error.message.includes(SECRET));
        return true;
      },
    );
  });

  it('supports safe relative next urls', async () => {
    const { fetch, requests } = stubFetch((url) => {
      if (url === 'http://127.0.0.1:9/v1/models') {
        return { status: 200, json: modelsPage(['a'], { next: '?cursor=2' }) };
      }
      return { status: 200, json: modelsPage(['b']) };
    });
    const result = await fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch });
    assert.equal(result.pageCount, 2);
    assert.deepEqual(result.models.map((m) => m.id), ['a', 'b']);
    assert.equal(requests[1]!.url, 'http://127.0.0.1:9/v1/models?cursor=2');
  });

  it('rejects next urls with userinfo or fragments', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: modelsPage(['a'], { next: 'http://u:p@127.0.0.1:9/v1/models?cursor=2' }),
    }));
    await assert.rejects(
      fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch }),
      (error: unknown) => error instanceof KpeError && error.code === 'PROVIDER_BAD_RESPONSE',
    );
  });

  it('classifies 401 without parsing secret-bearing bodies', async () => {
    const rawFetch = (async () => ({
      status: 401,
      body: null,
      text: async () => `unauthorized token ${SECRET}`,
    })) as unknown as Parameters<typeof fetchProviderModels>[0]['fetchImpl'];
    await assert.rejects(
      fetchProviderModels({ baseUrl: BASE, apiKey: SECRET, fetchImpl: rawFetch }),
      (error: unknown) => {
        assert.ok(error instanceof KpeError);
        assert.equal(error.code, 'PROVIDER_AUTH_FAILED');
        assert.ok(!error.message.includes(SECRET));
        return true;
      },
    );
  });

  it('skips invalid model ids with a warning instead of truncating', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: {
        data: [
          { id: 'x'.repeat(300) },
          { id: ' padded-id ' },
          { id: 'ctrl\tchar' },
          { id: 'valid-model', context_length: 4096 },
        ],
      },
    }));
    const result = await fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch });
    assert.deepEqual(result.models.map((m) => m.id), ['valid-model']);
    assert.ok(result.warnings.some((warning) => warning.includes('跳过')));
  });

  it('keeps the first record for duplicate pages and warns on differing metadata', async () => {
    const { fetch } = stubFetch((url) => {
      if (url === 'http://127.0.0.1:9/v1/models') {
        return {
          status: 200,
          json: {
            data: [
              {
                id: 'dup',
                supported_endpoints: ['/chat/completions'],
                modalities: { output: ['text'] },
              },
            ],
            next: '?cursor=2',
          },
        };
      }
      return {
        status: 200,
        json: {
          data: [
            {
              id: 'dup',
              supported_endpoints: ['/responses'],
              modalities: { input: ['image'] },
            },
          ],
        },
      };
    });
    const result = await fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch });
    const model = result.models[0]!;
    assert.deepEqual(model.endpoints, ['/chat/completions']);
    assert.deepEqual(model.modalitiesInput, undefined);
    assert.deepEqual(model.modalitiesOutput, ['text']);
    assert.ok(result.warnings.some((warning) => warning.includes('元数据不一致')));
  });

  it('does not warn when duplicate pages repeat identical metadata', async () => {
    const row = { id: 'dup', supported_endpoints: ['/chat/completions'] };
    const { fetch } = stubFetch((url) => ({
      status: 200,
      json:
        url === 'http://127.0.0.1:9/v1/models'
          ? { data: [row], next: '?cursor=2' }
          : { data: [row] },
    }));
    const result = await fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch });
    assert.equal(result.models.length, 1);
    assert.ok(!result.warnings.some((warning) => warning.includes('元数据不一致')));
  });

  it('treats fully malformed reasoning_options as absent', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: {
        data: [
          { id: 'bad', reasoning_options: [null, 3, {}] },
          { id: 'empty', reasoning_options: [] },
        ],
      },
    }));
    const result = await fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch });
    const bad = result.models.find((m) => m.id === 'bad');
    const empty = result.models.find((m) => m.id === 'empty');
    assert.equal(bad?.reasoningOptions, undefined);
    assert.deepEqual(empty?.reasoningOptions, []);
  });

  it('flags models whose output modalities exclude text as non-chat', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: {
        data: [
          { id: 'img-only', modalities: { input: ['text'], output: ['image'] } },
        ],
      },
    }));
    const result = await fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch });
    assert.equal(result.models[0]!.unsupportedReason, 'non-chat');
  });

  it('flags embedding and non-chat models as unsupported', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: {
        data: [
          { id: 'text-embedding-3', context_length: 8192 },
          { id: 'tts-1', supported_endpoints: ['/audio/speech'] },
          { id: 'chat-1', supported_endpoints: ['/chat/completions'] },
        ],
      },
    }));
    const result = await fetchProviderModels({ baseUrl: BASE, fetchImpl: fetch });
    const byId = new Map(result.models.map((m) => [m.id, m]));
    assert.equal(byId.get('text-embedding-3')?.unsupportedReason, 'embedding');
    assert.equal(byId.get('tts-1')?.unsupportedReason, 'non-chat');
    assert.equal(byId.get('chat-1')?.unsupportedReason, undefined);
  });
});

describe('http limits', () => {
  it('enforces response size limits on streams', async () => {
    const big = new TextEncoder().encode('x'.repeat(2048));
    await assert.rejects(
      fetchJson('http://127.0.0.1/x', { timeoutMs: 1000, maxBytes: 100 }, streamFetch([big])),
      (error: unknown) => error instanceof KpeError && error.code === 'RESPONSE_TOO_LARGE',
    );
  });

  it('enforces timeouts via abort signal', async () => {
    const slow: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof fetch;
    await assert.rejects(
      fetchJson('http://127.0.0.1/x', { timeoutMs: 30, maxBytes: 1024 }, slow as never),
      (error: unknown) => error instanceof KpeError && error.code === 'NETWORK',
    );
  });
});

describe('resolveProviderCredential', () => {
  it('uses inline api_key first, then named env var', () => {
    assert.equal(
      resolveProviderCredential({ api_key: 'inline', has_api_key: true }, {}).apiKey,
      'inline',
    );
    assert.equal(
      resolveProviderCredential(
        { api_key_env: 'KPE_TEST_KEY', has_api_key: false },
        { KPE_TEST_KEY: 'from-env' } as NodeJS.ProcessEnv,
      ).apiKey,
      'from-env',
    );
  });

  it('throws when key configured but unavailable', () => {
    assert.throws(
      () => resolveProviderCredential({ has_api_key: true }, {}),
      (error: unknown) => error instanceof KpeError && error.code === 'PROVIDER_AUTH_REQUIRED',
    );
  });
});
