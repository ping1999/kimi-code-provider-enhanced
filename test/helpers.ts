import type { FetchLike } from '../src/http.ts';
import type {
  CatalogModelItem,
  KimiConfig,
  ProviderDetail,
} from '../src/kimi-client.ts';
import type { DiscoverySnapshot, SnapshotItem } from '../src/changes.ts';

export interface RecordedRequest {
  url: string;
  init: RequestInit;
}

export function stubFetch(
  handler: (url: string, init: RequestInit) => { status: number; json: unknown },
): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const recorded: RecordedRequest = { url, init: init ?? {} };
    requests.push(recorded);
    const result = handler(url, init ?? {});
    return {
      status: result.status,
      body: null,
      text: async () => JSON.stringify(result.json),
    };
  };
  return { fetch, requests };
}

export function streamFetch(chunks: Uint8Array[], status = 200): FetchLike {
  return async () => ({
    status,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    text: async () => '',
  });
}

function snakeToCamel(key: string): string {
  return key.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export function makeProvider(overrides: Partial<ProviderDetail> = {}): ProviderDetail {
  return {
    id: 'demo',
    type: 'openai',
    base_url: 'http://127.0.0.1:9/v1',
    has_api_key: true,
    api_key: 'test-provider-key-SECRET',
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<KimiConfig> = {}): KimiConfig {
  return {
    providers: {},
    models: {},
    default_model: 'other-provider/existing',
    default_provider: 'other-provider',
    raw: {},
    ...overrides,
  };
}

export class FakeKimiClient {
  readonly connection = {
    baseUrl: 'http://127.0.0.1:1',
    serverKey: 'server-key-1',
  };
  config: KimiConfig;
  provider: ProviderDetail;
  postCalls: Record<string, unknown>[] = [];
  postError: unknown;
  postApplies = true;
  postApplyLimit: number | undefined;
  postDropKeys: string[] = [];
  postDeleteAliases: string[] = [];
  postHook: (() => void) | undefined;
  catalogItems: CatalogModelItem[] = [];
  getConfigCalls = 0;

  constructor(provider: ProviderDetail, config: KimiConfig) {
    this.provider = provider;
    this.config = config;
  }

  async getConfig(): Promise<KimiConfig> {
    this.getConfigCalls += 1;
    return this.config;
  }

  async getProvider(id: string): Promise<ProviderDetail> {
    if (id !== this.provider.id) {
      const { KpeError } = await import('../src/errors.ts');
      throw new KpeError('PROVIDER_NOT_FOUND', '供应商不存在');
    }
    return this.provider;
  }

  async postConfig(patch: Record<string, unknown>): Promise<KimiConfig> {
    this.postCalls.push(patch);
    this.postHook?.();
    if (this.postApplies) {
      const models = patch['models'];
      if (typeof models === 'object' && models !== null) {
        let applied = 0;
        for (const [alias, record] of Object.entries(models)) {
          if (this.postApplyLimit !== undefined && applied >= this.postApplyLimit) break;
          applied += 1;
          const base = this.config.models[alias] ?? {};
          const merged: Record<string, unknown> = { ...base };
          for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
            if (this.postDropKeys.includes(key)) continue;
            if (key === 'overrides' && typeof value === 'object' && value !== null) {
              const baseOv =
                typeof base['overrides'] === 'object' && base['overrides'] !== null
                  ? (base['overrides'] as Record<string, unknown>)
                  : {};
              const ovPatch: Record<string, unknown> = {};
              for (const [ovKey, ovValue] of Object.entries(value)) {
                ovPatch[snakeToCamel(ovKey)] = ovValue;
              }
              merged['overrides'] = { ...baseOv, ...ovPatch };
            } else {
              merged[snakeToCamel(key)] = value;
            }
          }
          this.config.models[alias] = merged;
        }
      }
    }
    for (const alias of this.postDeleteAliases) {
      delete this.config.models[alias];
    }
    if (this.postError !== undefined) throw this.postError;
    return this.config;
  }

  async listModels(): Promise<CatalogModelItem[]> {
    return this.catalogItems;
  }
}

export function makeSnapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  const item: SnapshotItem = {
    id: 'example-model-one',
    context: 32768,
    endpoints: ['/chat/completions'],
    alreadyConfigured: false,
    candidates: [
      {
        id: 'c0',
        tier: 'provider',
        match: 'declared',
        sources: [{ provider: 'demo', model: 'example-model-one' }],
        endpoint: 'http://127.0.0.1:9/v1',
        wire: 'openai',
        control: {
          kind: 'effort',
          efforts: ['low', 'high'],
          hasToggle: false,
          hasBudget: false,
          hasNull: false,
          offEffort: 'none',
          alwaysThinking: false,
        },
        context: 32768,
        contexts: [32768],
      },
    ],
    suggestionId: 'c0',
    conflict: false,
    warnings: [],
  };
  return {
    id: 'snap-1',
    createdAt: Date.now(),
    serverKey: 'server-key-1',
    providerFingerprint: '',
    providerId: 'demo',
    providerWire: 'openai',
    providerEndpoint: 'http://127.0.0.1:9/v1',
    items: [item],
    warnings: [],
    ...overrides,
  };
}
