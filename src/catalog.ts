import { fetchJson, type FetchLike } from './http.ts';
import { normalizeReasoning, type CatalogRow, type ReasoningControl } from './match.ts';
import { ensureDir, pluginDataDir, readJsonFile, writeFileAtomic } from './storage.ts';
import type { Wire } from './types.ts';
import { dirname } from 'node:path';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDERS = 512;
const MAX_MODELS_PER_PROVIDER = 4096;
const MAX_STRING = 512;

const KNOWN_WIRES: readonly Wire[] = [
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
];

function isWire(value: unknown): value is Wire {
  return typeof value === 'string' && (KNOWN_WIRES as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function capString(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.includes('${') ? undefined
    : trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function hasEmbeddingMarker(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lower = value.toLowerCase();
  return lower.includes('embedding') || /(?:^|[-_/])embed(?:$|[-_/])/.test(lower);
}

function resolveCatalogWire(entry: Record<string, unknown>): Wire | undefined {
  if (isWire(entry['type'])) return entry['type'];
  if (typeof entry['type'] === 'string' && entry['type'].length > 0) return undefined;
  const npm = capString(entry['npm'], 128)?.toLowerCase() ?? '';
  const id = capString(entry['id'], 128)?.toLowerCase() ?? '';
  if (npm.includes('anthropic') || id.includes('anthropic') || id.includes('claude')) {
    return 'anthropic';
  }
  if (id.includes('vertex')) return 'vertexai';
  if (npm.includes('google') || id.includes('google') || id.includes('gemini')) {
    return 'google-genai';
  }
  if (npm.includes('openai') || id.includes('openai')) return 'openai';
  if (npm.includes('amazon-bedrock') || npm.includes('cohere')) return undefined;
  return 'openai';
}

function inferOverrideWire(npm: string): Wire | undefined {
  const normalized = npm.toLowerCase();
  if (normalized.includes('anthropic')) return 'anthropic';
  if (normalized.includes('vertex')) return 'vertexai';
  if (normalized.includes('google')) return 'google-genai';
  if (normalized.includes('openai')) return 'openai';
  return undefined;
}

function adaptApiForWire(api: string, wire: string): string {
  return wire === 'anthropic' ? api.replace(/\/v1\/?$/, '') : api;
}

function isUsableChatModel(model: Record<string, unknown>, id: string): boolean {
  const modalities = model['modalities'];
  if (isObject(modalities)) {
    const output = modalities['output'];
    if (Array.isArray(output) && !output.includes('text')) return false;
  }
  if (model['status'] === 'deprecated' || model['status'] === 'alpha') return false;
  const name = typeof model['name'] === 'string' ? model['name'] : undefined;
  const family = typeof model['family'] === 'string' ? model['family'] : undefined;
  return (
    !hasEmbeddingMarker(family) && !hasEmbeddingMarker(id) && !hasEmbeddingMarker(name)
  );
}

function readContext(model: Record<string, unknown>): number | undefined {
  const limit = model['limit'];
  if (!isObject(limit)) return undefined;
  const context = limit['context'];
  if (typeof context === 'number' && Number.isInteger(context) && context > 0) return context;
  return undefined;
}

export interface CatalogData {
  rows: CatalogRow[];
  providerCount: number;
}

export function sanitizeCatalog(raw: unknown): CatalogData | undefined {
  if (!isObject(raw)) return undefined;
  const rows: CatalogRow[] = [];
  const entries = Object.entries(raw);
  let providerCount = 0;
  for (const [providerId, providerValue] of entries) {
    if (providerCount >= MAX_PROVIDERS) break;
    if (providerId.length === 0 || providerId.length > 128) continue;
    if (!isObject(providerValue)) continue;
    const rawModels = providerValue['models'];
    if (!isObject(rawModels)) continue;
    providerCount += 1;
    const wire = resolveCatalogWire(providerValue);
    const providerApi = capString(providerValue['api']);
    let modelCount = 0;
    for (const [modelKey, modelValue] of Object.entries(rawModels)) {
      if (modelCount >= MAX_MODELS_PER_PROVIDER) break;
      modelCount += 1;
      if (!isObject(modelValue)) continue;
      const modelIdRaw = typeof modelValue['id'] === 'string' ? modelValue['id'] : modelKey;
      if (modelIdRaw.length === 0 || modelIdRaw.length > 256 || modelIdRaw !== modelIdRaw.trim()) {
        continue;
      }
      const modelId = capString(modelIdRaw, 256);
      if (modelId === undefined || modelId !== modelIdRaw) continue;
      if (!isUsableChatModel(modelValue, modelId)) continue;
      const control: ReasoningControl = normalizeReasoning(
        modelValue['reasoning_options'],
        typeof modelValue['reasoning'] === 'boolean' ? modelValue['reasoning'] : undefined,
      );
      let rowWire = wire;
      let rowApi = providerApi;
      const override = modelValue['provider'];
      if (isObject(override)) {
        const overrideNpm = capString(override['npm'], 128)?.toLowerCase();
        if (
          overrideNpm !== undefined &&
          (overrideNpm.includes('amazon-bedrock') || overrideNpm.includes('cohere'))
        ) {
          continue;
        }
        const overrideWire =
          overrideNpm !== undefined ? (inferOverrideWire(overrideNpm) ?? 'openai') : wire;
        const overrideApi = capString(override['api']);
        if (overrideWire === wire) {
          if (overrideApi !== undefined && overrideApi !== providerApi) {
            rowApi = adaptApiForWire(overrideApi, overrideWire ?? 'openai');
          }
        } else if (overrideWire === 'anthropic' && (overrideApi ?? providerApi) !== undefined) {
          rowWire = 'anthropic';
          rowApi = adaptApiForWire(overrideApi ?? providerApi!, 'anthropic');
        } else {
          continue;
        }
      }
      rows.push({
        provider: providerId,
        model: modelId,
        api: rowApi,
        wire: rowWire,
        control,
        context: readContext(modelValue),
      });
    }
  }
  if (entries.length > 0 && providerCount === 0) return undefined;
  return { rows, providerCount };
}

interface CacheFile {
  version: 1;
  fetchedAt: number;
  source: string;
  data: CatalogData;
}

export interface CatalogResult {
  data: CatalogData;
  fetchedAt?: number;
  source: 'network' | 'cache' | 'empty';
  stale: boolean;
  warnings: string[];
}

export interface CatalogOptions {
  cachePath: string;
  home?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  sourceUrl?: string;
  ttlMs?: number;
}

export class ModelsDevCatalog {
  private readonly cachePath: string;
  private readonly home?: string;
  private readonly fetchImpl?: FetchLike;
  private readonly now: () => number;
  private readonly sourceUrl: string;
  private readonly ttlMs: number;

  constructor(options: CatalogOptions) {
    this.cachePath = options.cachePath;
    this.home = options.home;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
    this.sourceUrl = options.sourceUrl ?? MODELS_DEV_URL;
    this.ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  }

  private async readCache(): Promise<CacheFile | undefined> {
    const { stat } = await import('node:fs/promises');
    try {
      const info = await stat(this.cachePath);
      if (!info.isFile() || info.size > MAX_CATALOG_BYTES) return undefined;
    } catch {
      return undefined;
    }
    const raw = await readJsonFile(this.cachePath);
    if (!isObject(raw)) return undefined;
    if (raw['version'] !== 1) return undefined;
    if (
      typeof raw['fetchedAt'] !== 'number' ||
      !Number.isFinite(raw['fetchedAt']) ||
      raw['fetchedAt'] > this.now() + 60_000
    ) {
      return undefined;
    }
    if (raw['source'] !== this.sourceUrl) return undefined;
    const data = raw['data'];
    if (!isObject(data) || !Array.isArray(data['rows'])) return undefined;
    const sanitized = sanitizeCacheData(data);
    if (sanitized === undefined) return undefined;
    return {
      version: 1,
      fetchedAt: raw['fetchedAt'],
      source: this.sourceUrl,
      data: sanitized,
    };
  }

  async get(options: { refresh?: boolean } = {}): Promise<CatalogResult> {
    const cached = await this.readCache();
    const fresh =
      cached !== undefined && this.now() - cached.fetchedAt <= this.ttlMs;
    if (cached !== undefined && fresh && options.refresh !== true) {
      return { data: cached.data, fetchedAt: cached.fetchedAt, source: 'cache', stale: false, warnings: [] };
    }
    try {
      const result = await fetchJson(this.sourceUrl, {
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_CATALOG_BYTES,
        headers: { Accept: 'application/json' },
      }, this.fetchImpl ?? (fetch as unknown as FetchLike));
      if (result.status !== 200) {
        throw new Error('status');
      }
      const data = sanitizeCatalog(result.json);
      if (data === undefined) throw new Error('schema');
      const file: CacheFile = {
        version: 1,
        fetchedAt: this.now(),
        source: this.sourceUrl,
        data,
      };
      await this.writeCache(file);
      return {
        data,
        fetchedAt: file.fetchedAt,
        source: 'network',
        stale: false,
        warnings: [],
      };
    } catch {
      if (cached !== undefined) {
        return {
          data: cached.data,
          fetchedAt: cached.fetchedAt,
          source: 'cache',
          stale: true,
          warnings: ['models.dev 拉取失败，使用过期缓存'],
        };
      }
      return {
        data: { rows: [], providerCount: 0 },
        source: 'empty',
        stale: true,
        warnings: ['models.dev 不可用且无缓存，目录建议为空'],
      };
    }
  }

  private async writeCache(file: CacheFile): Promise<void> {
    if (this.home !== undefined) await ensureDir(pluginDataDir(this.home));
    else await ensureDir(dirname(this.cachePath));
    await writeFileAtomic(this.cachePath, JSON.stringify(file), 0o600);
  }
}

const CONTROL_KINDS = new Set(['unknown', 'none', 'toggle', 'budget', 'effort']);
const VALID_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default']);

function sanitizeCacheControl(raw: unknown): ReasoningControl | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw['kind'] !== 'string' || !CONTROL_KINDS.has(raw['kind'])) return undefined;
  if (!Array.isArray(raw['efforts'])) return undefined;
  const efforts = raw['efforts'];
  if (efforts.length > 16) return undefined;
  if (new Set(efforts).size !== efforts.length) return undefined;
  if (!efforts.every((effort) => typeof effort === 'string' && VALID_EFFORTS.has(effort))) {
    return undefined;
  }
  if (raw['kind'] === 'effort' && efforts.length === 0) return undefined;
  if (raw['kind'] !== 'effort' && efforts.length !== 0) return undefined;
  for (const flag of ['hasToggle', 'hasBudget', 'hasNull', 'alwaysThinking']) {
    if (typeof raw[flag] !== 'boolean') return undefined;
  }
  const offEffort = raw['offEffort'];
  if (offEffort !== undefined && offEffort !== 'none') return undefined;
  return {
    kind: raw['kind'] as ReasoningControl['kind'],
    efforts: [...efforts] as string[],
    hasToggle: raw['hasToggle'] as boolean,
    hasBudget: raw['hasBudget'] as boolean,
    hasNull: raw['hasNull'] as boolean,
    offEffort: offEffort === 'none' ? 'none' : undefined,
    alwaysThinking: raw['alwaysThinking'] as boolean,
  };
}

function sanitizeCacheData(raw: Record<string, unknown>): CatalogData | undefined {
  const rows = raw['rows'];
  if (!Array.isArray(rows)) return undefined;
  const out: CatalogRow[] = [];
  for (const row of rows) {
    if (!isObject(row)) return undefined;
    if (typeof row['provider'] !== 'string' || typeof row['model'] !== 'string') {
      return undefined;
    }
    if (row['provider'].length > 128 || row['model'].length > 256) return undefined;
    const control = sanitizeCacheControl(row['control']);
    if (control === undefined) return undefined;
    const api = row['api'];
    if (api !== undefined && api !== null && typeof api !== 'string') return undefined;
    const wire = row['wire'];
    if (wire !== undefined && wire !== null && !isWire(wire)) return undefined;
    const context = row['context'];
    if (context !== undefined && context !== null) {
      if (typeof context !== 'number' || !Number.isInteger(context) || context <= 0) {
        return undefined;
      }
    }
    out.push({
      provider: row['provider'],
      model: row['model'],
      api: typeof api === 'string' ? api : undefined,
      wire: isWire(wire) ? wire : undefined,
      control,
      context: typeof context === 'number' ? context : undefined,
    });
  }
  const providerCount = raw['providerCount'];
  return {
    rows: out,
    providerCount:
      typeof providerCount === 'number' && Number.isInteger(providerCount) && providerCount >= 0
        ? providerCount
        : out.length,
  };
}
