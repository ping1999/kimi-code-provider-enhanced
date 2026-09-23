import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ModelsDevCatalog } from '../src/catalog.ts';
import { stubFetch } from './helpers.ts';

const VALID_CATALOG = {
  moonshotai: {
    id: 'moonshotai',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.moonshot.ai/v1',
    models: {
      'kimi-k3': {
        id: 'kimi-k3',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
        limit: { context: 131072 },
      },
    },
  },
};

let dir: string;
let cachePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kpe-catalog-'));
  cachePath = join(dir, 'provider-enhanced', 'catalog.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ModelsDevCatalog', () => {
  it('fetches without auth headers and caches valid data', async () => {
    const { fetch, requests } = stubFetch(() => ({ status: 200, json: VALID_CATALOG }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch, now: Date.now });
    const first = await catalog.get();
    assert.equal(first.source, 'network');
    assert.equal(first.stale, false);
    assert.equal(first.data.rows.length, 1);
    assert.equal(first.data.rows[0]!.model, 'kimi-k3');
    assert.deepEqual(first.data.rows[0]!.control.efforts, ['low', 'high']);
    assert.equal(first.data.rows[0]!.control.offEffort, 'none');
    const headers = requests[0]!.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], undefined);
    const second = await catalog.get();
    assert.equal(second.source, 'cache');
    assert.equal(requests.length, 1);
  });

  it('falls back to stale cache when network fails', async () => {
    let fail = false;
    const { fetch } = stubFetch(() => {
      if (fail) throw new Error('network down');
      return { status: 200, json: VALID_CATALOG };
    });
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    await catalog.get();
    fail = true;
    const stale = await catalog.get({ refresh: true });
    assert.equal(stale.source, 'cache');
    assert.equal(stale.stale, true);
    assert.equal(stale.data.rows.length, 1);
    assert.ok(stale.warnings.length > 0);
  });

  it('malformed payload preserves previous valid cache', async () => {
    let payload: unknown = VALID_CATALOG;
    const { fetch } = stubFetch(() => ({ status: 200, json: payload }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    await catalog.get();
    payload = ['not', 'an', 'object'];
    const result = await catalog.get({ refresh: true });
    assert.equal(result.source, 'cache');
    assert.equal(result.data.rows.length, 1);
  });

  it('no cache and failed fetch returns empty catalog with warning', async () => {
    const { fetch } = stubFetch(() => {
      throw new Error('down');
    });
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    const result = await catalog.get();
    assert.equal(result.source, 'empty');
    assert.equal(result.data.rows.length, 0);
    assert.ok(result.warnings.length > 0);
  });

  it('corrupt cache file is ignored', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'provider-enhanced'), { recursive: true });
    await writeFile(cachePath, 'not json', 'utf8');
    const { fetch } = stubFetch(() => ({ status: 200, json: VALID_CATALOG }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    const result = await catalog.get();
    assert.equal(result.source, 'network');
  });

  it('rejects network payloads without a valid provider', async () => {
    const { fetch } = stubFetch(() => ({ status: 200, json: { error: 'bad' } }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    const result = await catalog.get();
    assert.equal(result.source, 'empty');
    assert.equal(result.data.rows.length, 0);
  });

  it('rejects malformed provider shapes at the root', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: { x: { foo: 'bar' } },
    }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    const result = await catalog.get();
    assert.equal(result.source, 'empty');
  });

  it('oversized cache files are never parsed', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'provider-enhanced'), { recursive: true });
    await writeFile(cachePath, Buffer.alloc(17 * 1024 * 1024, 0x20));
    const { fetch } = stubFetch(() => ({ status: 200, json: VALID_CATALOG }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    const result = await catalog.get();
    assert.equal(result.source, 'network');
  });

  it('a single malformed cache row rejects the whole cache', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'provider-enhanced'), { recursive: true });
    const cache = {
      version: 1,
      fetchedAt: Date.now(),
      source: 'https://models.dev/api.json',
      data: {
        providerCount: 1,
        rows: [
          {
            provider: 'moonshotai',
            model: 'kimi-k3',
            api: 'https://api.moonshot.ai/v1',
            wire: 'openai',
            control: { kind: 'effort', efforts: ['low'], hasToggle: false, hasBudget: false, hasNull: false, alwaysThinking: true },
            context: 131072,
          },
          { provider: 'bad', model: 'x', control: 'fake' },
        ],
      },
    };
    await writeFile(cachePath, JSON.stringify(cache), 'utf8');
    const { fetch } = stubFetch(() => ({ status: 200, json: VALID_CATALOG }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    const result = await catalog.get();
    assert.equal(result.source, 'network');
    assert.equal(result.data.rows.length, 1);
  });

  it('cache rows with unknown control kinds are rejected', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'provider-enhanced'), { recursive: true });
    const cache = {
      version: 1,
      fetchedAt: Date.now(),
      source: 'https://models.dev/api.json',
      data: {
        rows: [
          {
            provider: 'moonshotai',
            model: 'kimi-k3',
            control: { kind: 'fake', efforts: [], hasToggle: false, hasBudget: false, hasNull: false, alwaysThinking: false },
          },
        ],
      },
    };
    await writeFile(cachePath, JSON.stringify(cache), 'utf8');
    const { fetch } = stubFetch(() => ({ status: 200, json: VALID_CATALOG }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    const result = await catalog.get();
    assert.equal(result.source, 'network');
  });

  it('cache rows with out-of-set effort values are rejected and refetched', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'provider-enhanced'), { recursive: true });
    const cache = {
      version: 1,
      fetchedAt: Date.now(),
      source: 'https://models.dev/api.json',
      data: {
        rows: [
          {
            provider: 'moonshotai',
            model: 'kimi-k3',
            control: {
              kind: 'effort',
              efforts: ['arbitrary-bad-value'],
              hasToggle: false,
              hasBudget: false,
              hasNull: false,
              alwaysThinking: false,
            },
          },
        ],
      },
    };
    await writeFile(cachePath, JSON.stringify(cache), 'utf8');
    const { fetch } = stubFetch(() => ({ status: 200, json: VALID_CATALOG }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    assert.equal((await catalog.get()).source, 'network');
  });

  it('cache with mismatched source or future fetchedAt is ignored', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'provider-enhanced'), { recursive: true });
    const base = {
      version: 1,
      source: 'https://models.dev/api.json',
      data: { rows: [] },
    };
    await writeFile(
      cachePath,
      JSON.stringify({ ...base, source: 'https://evil.example.com', fetchedAt: Date.now() }),
      'utf8',
    );
    const { fetch } = stubFetch(() => ({ status: 200, json: VALID_CATALOG }));
    const catalog = new ModelsDevCatalog({ cachePath, fetchImpl: fetch });
    assert.equal((await catalog.get()).source, 'network');
    await writeFile(
      cachePath,
      JSON.stringify({ ...base, fetchedAt: Date.now() + 3_600_000 }),
      'utf8',
    );
    assert.equal((await catalog.get()).source, 'network');
  });
});
