import { createHash } from 'node:crypto';

import { KpeError } from './errors.ts';
import { fetchJson, type FetchLike } from './http.ts';
import {
  isLoopbackHost,
  listLiveServerInstances,
  readServerToken,
  type ServerInstance,
} from './storage.ts';

const API_PREFIX = '/api/v1';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface KimiConnection {
  baseUrl: string;
  token?: string;
  serverKey: string;
  instance?: ServerInstance;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function validateKimiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KpeError('INVALID_SERVER_URL', 'KIMI 服务器地址无效');
  }
  if (url.protocol !== 'http:') {
    throw new KpeError('INVALID_SERVER_URL', '仅允许本机 http 回环地址');
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new KpeError('INVALID_SERVER_URL', '仅允许本机回环地址');
  }
  if (url.username !== '' || url.password !== '') {
    throw new KpeError('INVALID_SERVER_URL', '地址不允许包含用户信息');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new KpeError('INVALID_SERVER_URL', '地址不允许包含查询或片段');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new KpeError('INVALID_SERVER_URL', '地址不允许包含路径');
  }
  const host = url.hostname === '::1' ? '[::1]' : url.hostname;
  return `http://${host}${url.port === '' ? '' : `:${url.port}`}`;
}

export interface ResolveConnectionOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  now?: () => number;
  fetchImpl?: FetchLike;
}

function instanceBaseUrl(instance: ServerInstance): string {
  const host = instance.host === '::1' || instance.host === '[::1]' ? '[::1]' : instance.host;
  return `http://${host}:${instance.port}`;
}

interface ServerMeta {
  serverId: string;
  startedAt: string;
}

async function fetchServerMeta(
  baseUrl: string,
  token: string | undefined,
  fetchImpl?: FetchLike,
): Promise<ServerMeta> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;
  let result;
  try {
    result = await fetchJson(
      `${baseUrl}${API_PREFIX}/meta`,
      { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: 1024 * 1024, headers },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof KpeError && error.code === 'BAD_JSON') {
      throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
    }
    throw new KpeError('KIMI_UNREACHABLE', '无法连接本机 Kimi 服务器');
  }
  if (result.status === 401 || result.status === 403) {
    throw new KpeError('KIMI_AUTH_FAILED', 'Kimi 服务器认证失败，请提供有效凭证');
  }
  const envelope = result.json;
  if (result.status !== 200 || !isObject(envelope) || envelope['code'] !== 0) {
    throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
  }
  const data = envelope['data'];
  if (!isObject(data) || typeof data['server_id'] !== 'string') {
    throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
  }
  return {
    serverId: data['server_id'],
    startedAt: typeof data['started_at'] === 'string' ? data['started_at'] : '',
  };
}

export async function resolveKimiConnection(
  options: ResolveConnectionOptions,
): Promise<KimiConnection> {
  const now = options.now ?? Date.now;
  const explicit = options.env['KPE_KIMI_URL'];
  if (explicit !== undefined && explicit.trim() !== '') {
    const baseUrl = validateKimiBaseUrl(explicit.trim());
    const envToken = options.env['KPE_KIMI_TOKEN'];
    let token = envToken !== undefined && envToken.trim() !== '' ? envToken.trim() : undefined;
    let instance: ServerInstance | undefined;
    if (token === undefined) {
      const instances = await listLiveServerInstances(options.home, now);
      instance = instances.find((entry) => instanceBaseUrl(entry) === baseUrl);
      if (instance !== undefined) {
        token = await readServerToken(options.home);
      }
    }
    const meta = await fetchServerMeta(baseUrl, token, options.fetchImpl);
    return {
      baseUrl,
      token,
      serverKey: sha256(`meta|${meta.serverId}|${meta.startedAt}|${baseUrl}`),
      instance,
    };
  }
  const instances = await listLiveServerInstances(options.home, now);
  if (instances.length === 0) {
    throw new KpeError(
      'NO_SERVER',
      '未发现运行中的 Kimi 服务器；请先启动 Kimi，或设置 KPE_KIMI_URL',
    );
  }
  if (instances.length > 1) {
    throw new KpeError(
      'MULTIPLE_SERVERS',
      '发现多个运行中的 Kimi 服务器；请设置 KPE_KIMI_URL 指定目标',
    );
  }
  const instance = instances[0]!;
  const baseUrl = instanceBaseUrl(instance);
  const token = await readServerToken(options.home);
  const meta = await fetchServerMeta(baseUrl, token, options.fetchImpl);
  return {
    baseUrl,
    token,
    serverKey: sha256(`meta|${meta.serverId}|${meta.startedAt}|${baseUrl}`),
    instance,
  };
}

export interface ProviderConfigEntry {
  type: string;
  base_url?: string;
  default_model?: string;
  api_key_env?: string;
  has_api_key: boolean;
}

export interface KimiConfig {
  providers: Record<string, ProviderConfigEntry>;
  models: Record<string, Record<string, unknown>>;
  default_model?: string;
  default_provider?: string;
  raw: Record<string, unknown>;
}

export interface ProviderDetail extends ProviderConfigEntry {
  id: string;
  status?: string;
  models?: string[];
  api_key?: string;
}

export interface CatalogModelItem {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeUrlForDisplay(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export class KimiClient {
  readonly connection: KimiConnection;
  private readonly fetchImpl: FetchLike;

  constructor(connection: KimiConnection, fetchImpl?: FetchLike) {
    this.connection = connection;
    this.fetchImpl = fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.connection.token !== undefined) {
      headers['Authorization'] = `Bearer ${this.connection.token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let result;
    try {
      result = await fetchJson(`${this.connection.baseUrl}${API_PREFIX}${path}`, {
        method,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        jsonOptional: true,
      }, this.fetchImpl);
    } catch (error) {
      if (error instanceof KpeError) throw error;
      throw new KpeError('KIMI_UNREACHABLE', '无法连接本机 Kimi 服务器');
    }
    if (result.status === 401 || result.status === 403) {
      throw new KpeError('KIMI_AUTH_FAILED', 'Kimi 服务器认证失败');
    }
    if (result.status < 200 || result.status >= 300) {
      throw new KpeError('KIMI_HTTP_ERROR', `Kimi 服务器返回 HTTP ${result.status}`);
    }
    if (!isObject(result.json)) {
      throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
    }
    const envelope = result.json;
    if (envelope['code'] !== 0) {
      const code = envelope['code'];
      if (code === 40412) throw new KpeError('PROVIDER_NOT_FOUND', '供应商不存在');
      if (code === 40413) throw new KpeError('MODEL_NOT_FOUND', '模型不存在');
      throw new KpeError(
        'KIMI_ERROR',
        `Kimi 服务器返回错误（code ${typeof code === 'number' ? code : '?'}）`,
      );
    }
    return envelope['data'];
  }

  async getConfig(): Promise<KimiConfig> {
    const data = await this.call('GET', '/config');
    if (!isObject(data)) {
      throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
    }
    const rawProviders = data['providers'];
    if (!isObject(rawProviders)) {
      throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
    }
    const providers: Record<string, ProviderConfigEntry> = {};
    for (const [id, value] of Object.entries(rawProviders)) {
      if (!isObject(value)) {
        throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
      }
      providers[id] = {
        type: typeof value['type'] === 'string' ? value['type'] : '',
        base_url: typeof value['base_url'] === 'string' ? value['base_url'] : undefined,
        default_model:
          typeof value['default_model'] === 'string' ? value['default_model'] : undefined,
        api_key_env:
          typeof value['api_key_env'] === 'string' ? value['api_key_env'] : undefined,
        has_api_key: value['has_api_key'] === true,
      };
    }
    const rawModels = data['models'];
    if (rawModels !== undefined && !isObject(rawModels)) {
      throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
    }
    const models: Record<string, Record<string, unknown>> = {};
    if (isObject(rawModels)) {
      for (const [alias, record] of Object.entries(rawModels)) {
        if (!isObject(record)) {
          throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
        }
        models[alias] = record;
      }
    }
    return {
      providers,
      models,
      default_model:
        typeof data['default_model'] === 'string' ? data['default_model'] : undefined,
      default_provider:
        typeof data['default_provider'] === 'string' ? data['default_provider'] : undefined,
      raw: data,
    };
  }

  async listProviders(): Promise<ProviderDetail[]> {
    const data = await this.call('GET', '/providers');
    const items = isObject(data) ? data['items'] : undefined;
    if (!Array.isArray(items)) {
      throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
    }
    const out: ProviderDetail[] = [];
    for (const item of items) {
      if (!isObject(item) || typeof item['id'] !== 'string') {
        throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
      }
      out.push({
        id: item['id'],
        type: typeof item['type'] === 'string' ? item['type'] : '',
        base_url: sanitizeUrlForDisplay(
          typeof item['base_url'] === 'string' ? item['base_url'] : undefined,
        ),
        default_model:
          typeof item['default_model'] === 'string' ? item['default_model'] : undefined,
        api_key_env:
          typeof item['api_key_env'] === 'string' ? item['api_key_env'] : undefined,
        has_api_key: item['has_api_key'] === true,
        status: typeof item['status'] === 'string' ? item['status'] : undefined,
        models: Array.isArray(item['models'])
          ? item['models'].filter((entry): entry is string => typeof entry === 'string')
          : undefined,
      });
    }
    return out;
  }

  async getProvider(providerId: string): Promise<ProviderDetail> {
    const data = await this.call('GET', `/providers/${encodeURIComponent(providerId)}`);
    if (!isObject(data) || typeof data['id'] !== 'string') {
      throw new KpeError('PROVIDER_NOT_FOUND', `供应商 ${providerId} 不存在`);
    }
    if (data['id'] !== providerId) {
      throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
    }
    return {
      id: data['id'],
      type: typeof data['type'] === 'string' ? data['type'] : '',
      base_url: typeof data['base_url'] === 'string' ? data['base_url'] : undefined,
      default_model:
        typeof data['default_model'] === 'string' ? data['default_model'] : undefined,
      api_key_env: typeof data['api_key_env'] === 'string' ? data['api_key_env'] : undefined,
      has_api_key: data['has_api_key'] === true,
      status: typeof data['status'] === 'string' ? data['status'] : undefined,
      models: Array.isArray(data['models'])
        ? data['models'].filter((entry): entry is string => typeof entry === 'string')
        : undefined,
      api_key: typeof data['api_key'] === 'string' ? data['api_key'] : undefined,
    };
  }

  async listModels(): Promise<CatalogModelItem[]> {
    const data = await this.call('GET', '/models');
    const items = isObject(data) ? data['items'] : undefined;
    if (!Array.isArray(items)) {
      throw new KpeError('KIMI_BAD_RESPONSE', 'Kimi 服务器响应格式异常');
    }
    const out: CatalogModelItem[] = [];
    for (const item of items) {
      if (!isObject(item)) continue;
      if (typeof item['provider'] !== 'string' || typeof item['model'] !== 'string') continue;
      out.push({
        provider: item['provider'],
        model: item['model'],
        display_name:
          typeof item['display_name'] === 'string' ? item['display_name'] : undefined,
        max_context_size:
          typeof item['max_context_size'] === 'number' ? item['max_context_size'] : 0,
        capabilities: Array.isArray(item['capabilities'])
          ? item['capabilities'].filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        support_efforts: Array.isArray(item['support_efforts'])
          ? item['support_efforts'].filter(
              (entry): entry is string => typeof entry === 'string',
            )
          : undefined,
        default_effort:
          typeof item['default_effort'] === 'string' ? item['default_effort'] : undefined,
      });
    }
    return out;
  }

  async postConfig(patch: Record<string, unknown>): Promise<KimiConfig> {
    await this.call('POST', '/config', patch);
    return this.getConfig();
  }
}
