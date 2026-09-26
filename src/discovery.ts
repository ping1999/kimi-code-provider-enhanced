import { KpeError } from './errors.ts';
import { fetchJson, type FetchLike } from './http.ts';
import { isLoopbackHost, isPrivateIpHost } from './storage.ts';

export const SUPPORTED_DISCOVERY_WIRES = ['openai', 'openai_responses', 'kimi'] as const;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_ID_LENGTH = 256;
const MAX_STRING_LENGTH = 512;
const MAX_ENDPOINTS = 32;
const MAX_REASONING_OPTIONS = 8;
const MAX_REASONING_VALUES = 32;
const MAX_MODELS = 10_000;
const MAX_WARNINGS = 64;
const CREDENTIAL_QUERY_KEYS = new Set([
  'api_key',
  'apikey',
  'key',
  'token',
  'access_token',
  'auth',
  'authorization',
]);
const CHAT_ENDPOINTS = ['/chat/completions', '/messages', '/responses'];

export interface DiscoveredModel {
  id: string;
  name?: string;
  context?: number;
  endpoints: string[];
  reasoningOptions?: unknown[];
  reasoning?: boolean;
  toolCall?: boolean;
  modalitiesInput?: string[];
  modalitiesOutput?: string[];
  unsupportedReason?: string;
}

export interface DiscoveryFetchResult {
  models: DiscoveredModel[];
  warnings: string[];
  pageCount: number;
}

function capString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function capStringList(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const text = capString(entry, maxLen);
    if (text === undefined) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizeReasoningOptions(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: unknown[] = [];
  for (const option of value) {
    if (out.length >= MAX_REASONING_OPTIONS) break;
    if (typeof option !== 'object' || option === null || Array.isArray(option)) continue;
    const raw = option as Record<string, unknown>;
    const type = capString(raw['type'], 32);
    if (type === undefined) continue;
    const entry: Record<string, unknown> = { type };
    if (Array.isArray(raw['values'])) {
      entry['values'] = raw['values']
        .slice(0, MAX_REASONING_VALUES)
        .map((item) => (typeof item === 'string' ? item.slice(0, 64) : item === null ? null : undefined))
        .filter((item) => item !== undefined);
    }
    out.push(entry);
  }
  return value.length > 0 && out.length === 0 ? undefined : out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readContext(raw: Record<string, unknown>): number | undefined {
  const candidates = [raw['context_length'], raw['max_context_size']];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) {
      return candidate;
    }
  }
  const limit = raw['limit'];
  if (isObject(limit)) {
    const context = limit['context'];
    if (typeof context === 'number' && Number.isInteger(context) && context > 0) {
      return context;
    }
  }
  return undefined;
}

function hasEmbeddingMarker(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lower = value.toLowerCase();
  return lower.includes('embedding') || /(?:^|[-_/])embed(?:$|[-_/])/.test(lower);
}

function validModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > MAX_ID_LENGTH) return undefined;
  if (value !== value.trim()) return undefined;
  if (/[\x00-\x1f\x7f]/.test(value)) return undefined;
  return value;
}

function extractModel(raw: unknown): DiscoveredModel | undefined {
  if (!isObject(raw)) return undefined;
  const id = validModelId(raw['id']);
  if (id === undefined) return undefined;
  const modalities = isObject(raw['modalities']) ? raw['modalities'] : undefined;
  const endpoints = capStringList(raw['supported_endpoints'], MAX_ENDPOINTS, 128)?.filter(
    (endpoint) => endpoint.startsWith('/'),
  );
  const model: DiscoveredModel = { id, endpoints: endpoints ?? [] };
  const name = capString(raw['name'], MAX_STRING_LENGTH);
  if (name !== undefined) model.name = name;
  const context = readContext(raw);
  if (context !== undefined) model.context = context;
  const reasoningOptions = sanitizeReasoningOptions(raw['reasoning_options']);
  if (reasoningOptions !== undefined) model.reasoningOptions = reasoningOptions;
  if (typeof raw['reasoning'] === 'boolean') model.reasoning = raw['reasoning'];
  if (typeof raw['tool_call'] === 'boolean') model.toolCall = raw['tool_call'];
  if (modalities !== undefined) {
    const input = capStringList(modalities['input'], 16, 32);
    const output = capStringList(modalities['output'], 16, 32);
    if (input !== undefined) model.modalitiesInput = input;
    if (output !== undefined) model.modalitiesOutput = output;
  }
  if (hasEmbeddingMarker(model.id) || hasEmbeddingMarker(model.name)) {
    model.unsupportedReason = 'embedding';
  } else if (
    model.modalitiesOutput !== undefined &&
    model.modalitiesOutput.length > 0 &&
    !model.modalitiesOutput.includes('text')
  ) {
    model.unsupportedReason = 'non-chat';
  } else if (
    model.endpoints.length > 0 &&
    !model.endpoints.some((endpoint) => CHAT_ENDPOINTS.includes(endpoint))
  ) {
    model.unsupportedReason = 'non-chat';
  }
  return model;
}

export function buildModelsUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new KpeError('PROVIDER_URL_INVALID', '供应商 base_url 无效');
  }
  if (url.username !== '' || url.password !== '') {
    throw new KpeError('PROVIDER_URL_INVALID', '供应商地址不允许包含用户信息');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new KpeError('PROVIDER_URL_INVALID', '供应商地址不允许包含查询或片段');
  }
  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname) && !isPrivateIpHost(url.hostname)) {
      throw new KpeError('PROVIDER_URL_INVALID', 'HTTP 供应商地址仅限本机或内网 IP');
    }
  } else if (url.protocol !== 'https:') {
    throw new KpeError('PROVIDER_URL_INVALID', '供应商地址必须为 https（本机或内网可为 http）');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.toLowerCase().endsWith('/models')) pathname = `${pathname}/models`;
  url.pathname = pathname;
  return url;
}

function nextPageUrl(
  body: Record<string, unknown>,
  modelsUrl: URL,
): { url?: URL; missingCursor: boolean } {
  const nextValue = body['next'] ?? body['next_url'];
  if (typeof nextValue === 'string' && nextValue.trim() !== '') {
    let url: URL;
    try {
      url = new URL(nextValue, modelsUrl);
    } catch {
      throw new KpeError('PROVIDER_BAD_RESPONSE', '分页 next 地址无效');
    }
    if (url.username !== '' || url.password !== '' || url.hash !== '') {
      throw new KpeError('PROVIDER_BAD_RESPONSE', '分页 next 地址越界，已拒绝');
    }
    if (url.origin !== modelsUrl.origin || url.pathname !== modelsUrl.pathname) {
      throw new KpeError('PROVIDER_BAD_RESPONSE', '分页 next 地址越界，已拒绝');
    }
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
        throw new KpeError('PROVIDER_BAD_RESPONSE', '分页 next 地址包含凭证参数，已拒绝');
      }
    }
    return { url, missingCursor: false };
  }
  if (body['has_more'] === true) {
    const lastId = body['last_id'];
    if (typeof lastId !== 'string' || lastId.trim() === '') {
      return { missingCursor: true };
    }
    const url = new URL(modelsUrl.toString());
    url.searchParams.set('after', lastId);
    return { url, missingCursor: false };
  }
  return { missingCursor: false };
}

function extractItems(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  if (isObject(body)) {
    if (Array.isArray(body['data'])) return body['data'];
    if (Array.isArray(body['models'])) return body['models'];
  }
  return undefined;
}

function accumulateModel(
  existing: DiscoveredModel,
  incoming: DiscoveredModel,
  warnings: string[],
): void {
  if (JSON.stringify(existing) !== JSON.stringify(incoming) && warnings.length < MAX_WARNINGS) {
    warnings.push(`模型 ${existing.id} 在分页中元数据不一致；保留首次记录，请核对后确认`);
  }
}

export interface FetchProviderModelsOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
}

export async function fetchProviderModels(
  options: FetchProviderModelsOptions,
): Promise<DiscoveryFetchResult> {
  const modelsUrl = buildModelsUrl(options.baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.apiKey !== undefined && options.apiKey !== '') {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const warnings: string[] = [];
  const models: DiscoveredModel[] = [];
  const seen = new Map<string, DiscoveredModel>();
  const visited = new Set<string>();
  let url: URL = modelsUrl;
  let pageCount = 0;
  for (;;) {
    const key = url.toString();
    if (visited.has(key)) {
      throw new KpeError('PROVIDER_BAD_RESPONSE', '分页地址重复，已中止');
    }
    visited.add(key);
    if (pageCount >= MAX_PAGES) {
      throw new KpeError('PROVIDER_BAD_RESPONSE', '分页超出上限');
    }
    const result = await fetchJson(url, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_PAGE_BYTES,
      headers,
      jsonOptional: true,
    }, fetchImpl);
    pageCount += 1;
    if (result.status === 401 || result.status === 403) {
      throw new KpeError('PROVIDER_AUTH_FAILED', '供应商认证失败，请检查凭证');
    }
    if (result.status !== 200) {
      throw new KpeError('PROVIDER_HTTP_ERROR', `供应商返回 HTTP ${result.status}`);
    }
    const items = extractItems(result.json);
    if (items === undefined) {
      throw new KpeError('PROVIDER_BAD_RESPONSE', '供应商模型列表格式无法识别');
    }
    let skipped = 0;
    for (const item of items) {
      const model = extractModel(item);
      if (model === undefined) {
        skipped += 1;
        continue;
      }
      const existing = seen.get(model.id);
      if (existing === undefined) {
        seen.set(model.id, model);
        models.push(model);
        if (models.length > MAX_MODELS) {
          throw new KpeError('PROVIDER_BAD_RESPONSE', '供应商模型数量超出上限');
        }
      } else {
        accumulateModel(existing, model, warnings);
      }
    }
    if (skipped > 0 && warnings.length < MAX_WARNINGS) {
      warnings.push(`跳过 ${skipped} 个缺少有效 id 的条目`);
    }
    const page = isObject(result.json) ? nextPageUrl(result.json, modelsUrl) : { missingCursor: false };
    if (page.missingCursor) {
      throw new KpeError('PROVIDER_BAD_RESPONSE', '分页声明 has_more 但缺少可用游标');
    }
    if (page.url === undefined) break;
    url = page.url;
  }
  return { models, warnings, pageCount };
}

export function resolveProviderCredential(
  detail: { api_key?: string; api_key_env?: string; has_api_key: boolean },
  env: NodeJS.ProcessEnv = process.env,
): { apiKey?: string } {
  if (typeof detail.api_key === 'string' && detail.api_key !== '') {
    return { apiKey: detail.api_key };
  }
  if (typeof detail.api_key_env === 'string' && detail.api_key_env !== '') {
    const value = env[detail.api_key_env];
    if (typeof value === 'string' && value !== '') return { apiKey: value };
  }
  if (detail.has_api_key) {
    throw new KpeError(
      'PROVIDER_AUTH_REQUIRED',
      '供应商已配置凭证但当前环境无法读取，请在 Kimi 供应商设置中确认',
    );
  }
  return {};
}
