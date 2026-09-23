import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import {
  applyChange,
  buildDiscoveryPreview,
  buildThinkingPreview,
  ChangeStore,
  providerFingerprint,
  SnapshotStore,
  type DiscoverySnapshot,
  type PreviewResult,
  type SnapshotItem,
} from './changes.ts';
import { ModelsDevCatalog } from './catalog.ts';
import {
  fetchProviderModels,
  resolveProviderCredential,
  SUPPORTED_DISCOVERY_WIRES,
  type DiscoveredModel,
} from './discovery.ts';
import { KpeError, toKpeError } from './errors.ts';
import type { FetchLike } from './http.ts';
import { KimiClient, resolveKimiConnection } from './kimi-client.ts';
import {
  buildCandidates,
  normalizeReasoning,
  type CatalogRow,
  type ReasoningControl,
} from './match.ts';
import { catalogCachePath, resolveKimiHome } from './storage.ts';
import type {
  ApplyInput,
  DiscoverInput,
  PreviewInput,
  UpdateThinkingInput,
} from './types.ts';

const PLUGIN_NAME = 'kimi-code-provider-enhanced';
const PLUGIN_VERSION = '0.1.0';
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const MAX_SNAPSHOT_MODELS = 10_000;

export interface ServiceDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  fetchImpl?: FetchLike;
  catalog?: ModelsDevCatalog;
  snapshots?: SnapshotStore;
  changes?: ChangeStore;
}

export class ProviderEnhancedService {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly fetchImpl?: FetchLike;
  private readonly catalog: ModelsDevCatalog;
  private readonly snapshots: SnapshotStore;
  private readonly changes: ChangeStore;

  constructor(deps: ServiceDeps) {
    this.home = deps.home;
    this.env = deps.env;
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl;
    this.catalog =
      deps.catalog ??
      new ModelsDevCatalog({
        cachePath: catalogCachePath(deps.home),
        home: deps.home,
        fetchImpl: deps.fetchImpl,
        now: this.now,
      });
    this.snapshots = deps.snapshots ?? new SnapshotStore(this.now);
    this.changes = deps.changes ?? new ChangeStore(this.now);
  }

  private async connect(): Promise<KimiClient> {
    const connection = await resolveKimiConnection({
      env: this.env,
      home: this.home,
      now: this.now,
      fetchImpl: this.fetchImpl,
    });
    return new KimiClient(connection, this.fetchImpl);
  }

  async listProviders(): Promise<unknown> {
    const client = await this.connect();
    const items = await client.listProviders();
    return {
      providers: items.map((item) => ({
        id: item.id,
        type: item.type,
        base_url: item.base_url,
        default_model: item.default_model,
        api_key_env: item.api_key_env,
        has_api_key: item.has_api_key,
        status: item.status,
        models: item.models,
        discoverable: (SUPPORTED_DISCOVERY_WIRES as readonly string[]).includes(item.type),
      })),
    };
  }

  async discoverModels(input: DiscoverInput): Promise<unknown> {
    const client = await this.connect();
    let snapshot: DiscoverySnapshot;
    if (input.discoveryId !== undefined) {
      const found = this.snapshots.get(input.discoveryId);
      if (found === undefined) {
        throw new KpeError('SNAPSHOT_NOT_FOUND', '发现快照不存在或已过期，请重新发现');
      }
      if (found.serverKey !== client.connection.serverKey) {
        throw new KpeError('SNAPSHOT_INVALID', '快照与当前服务器不一致，请重新发现');
      }
      if (found.providerId !== input.providerId) {
        throw new KpeError('SNAPSHOT_INVALID', '快照不属于该供应商');
      }
      snapshot = found;
    } else {
      snapshot = await this.createSnapshot(client, input);
    }
    const query = input.query?.trim().toLowerCase();
    const filtered =
      query === undefined || query === ''
        ? snapshot.items
        : snapshot.items.filter(
            (item) =>
              item.id.toLowerCase().includes(query) ||
              (item.name?.toLowerCase().includes(query) ?? false),
          );
    const pageSize = Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const cursor = input.cursor ?? 0;
    const page = filtered.slice(cursor, cursor + pageSize);
    const nextCursor = cursor + pageSize < filtered.length ? cursor + pageSize : null;
    return {
      discoveryId: snapshot.id,
      providerId: snapshot.providerId,
      total: snapshot.items.length,
      filteredTotal: filtered.length,
      cursor,
      nextCursor,
      warnings: snapshot.warnings,
      items: page.map((item) => ({
        id: item.id,
        name: item.name,
        context: item.context,
        endpoints: item.endpoints,
        unsupportedReason: item.unsupportedReason,
        alreadyConfigured: item.alreadyConfigured,
        warnings: item.warnings,
        suggestion: suggestionView(item),
        candidates: item.candidates.map((candidate) => ({
          id: candidate.id,
          tier: candidate.tier,
          match: candidate.match,
          sources: candidate.sources,
          control: controlView(candidate.control),
          context: candidate.context,
          contexts: candidate.contexts,
        })),
      })),
    };
  }

  private async createSnapshot(
    client: KimiClient,
    input: DiscoverInput,
  ): Promise<DiscoverySnapshot> {
    const provider = await client.getProvider(input.providerId);
    if (!(SUPPORTED_DISCOVERY_WIRES as readonly string[]).includes(provider.type)) {
      throw new KpeError(
        'UNSUPPORTED_DISCOVERY',
        `供应商类型 ${provider.type || '未知'} 暂不支持模型发现（当前支持 openai/openai_responses/kimi）`,
      );
    }
    if (provider.base_url === undefined || provider.base_url.trim() === '') {
      throw new KpeError('PROVIDER_URL_INVALID', '供应商未配置 base_url，无法发现模型');
    }
    const { apiKey } = resolveProviderCredential(provider, this.env);
    const fetched = await fetchProviderModels({
      baseUrl: provider.base_url,
      apiKey,
      fetchImpl: this.fetchImpl,
    });
    if (fetched.models.length > MAX_SNAPSHOT_MODELS) {
      throw new KpeError('PROVIDER_BAD_RESPONSE', '供应商模型数量超出上限');
    }
    const catalog = await this.catalog.get({ refresh: input.refreshCatalog === true });
    const config = await client.getConfig();
    const warnings = [...fetched.warnings, ...catalog.warnings];
    const configured = new Set<string>();
    for (const record of Object.values(config.models)) {
      if (record['provider'] === provider.id && typeof record['model'] === 'string') {
        configured.add(record['model']);
      }
    }
    const items: SnapshotItem[] = fetched.models.map((model) =>
      this.toSnapshotItem(model, provider, catalog.data.rows, configured),
    );
    const stored = this.snapshots.add({
      serverKey: client.connection.serverKey,
      providerFingerprint: providerFingerprint(provider),
      providerId: provider.id,
      providerWire: provider.type,
      providerEndpoint: provider.base_url,
      items,
      warnings,
    });
    return stored;
  }

  private toSnapshotItem(
    model: DiscoveredModel,
    provider: { id: string; type: string; base_url?: string },
    catalogRows: readonly CatalogRow[],
    configured: ReadonlySet<string>,
  ): SnapshotItem {
    const providerControl =
      model.reasoningOptions !== undefined
        ? normalizeReasoning(model.reasoningOptions, model.reasoning)
        : model.reasoning === false
          ? normalizeReasoning(undefined, false)
          : undefined;
    const built = buildCandidates({
      modelId: model.id,
      providerEndpoint: provider.base_url,
      providerWire: provider.type,
      providerControl,
      providerContext: model.context,
      catalogRows,
    });
    return {
      ...model,
      alreadyConfigured: configured.has(model.id),
      candidates: built.candidates,
      suggestionId: built.suggestion?.id,
      conflict: built.conflict,
      warnings: built.warnings,
    };
  }

  async previewChanges(input: PreviewInput): Promise<PreviewResult> {
    const client = await this.connect();
    const snapshot = this.snapshots.get(input.discoveryId);
    if (snapshot === undefined) {
      throw new KpeError('SNAPSHOT_NOT_FOUND', '发现快照不存在或已过期，请重新发现');
    }
    const provider = await client.getProvider(snapshot.providerId);
    const config = await client.getConfig();
    return buildDiscoveryPreview({
      input,
      snapshot,
      client,
      config,
      provider,
      store: this.changes,
      now: this.now,
    });
  }

  async updateModelThinking(input: UpdateThinkingInput): Promise<PreviewResult> {
    const client = await this.connect();
    const provider = await client.getProvider(input.providerId);
    const config = await client.getConfig();
    return buildThinkingPreview({
      input,
      client,
      config,
      provider,
      store: this.changes,
      now: this.now,
    });
  }

  async applyChanges(input: ApplyInput): Promise<unknown> {
    const client = await this.connect();
    return applyChange({
      changeId: input.changeId,
      store: this.changes,
      client,
      home: this.home,
      now: this.now,
    });
  }
}

function controlView(control: ReasoningControl) {
  return {
    kind: control.kind,
    efforts: control.efforts,
    hasToggle: control.hasToggle,
    hasBudget: control.hasBudget,
    hasNull: control.hasNull,
    offEffort: control.offEffort,
    alwaysThinking: control.alwaysThinking,
  };
}

function suggestionView(item: SnapshotItem) {
  if (item.suggestionId === undefined) return undefined;
  const candidate = item.candidates.find((entry) => entry.id === item.suggestionId);
  if (candidate === undefined) return undefined;
  return {
    candidateId: candidate.id,
    tier: candidate.tier,
    match: candidate.match,
    sources: candidate.sources,
    control: controlView(candidate.control),
  };
}

const effortString = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/)
  .refine((value) => !['off', 'on', 'none'].includes(value));

const modelOverridesSchema = z.strictObject({
  maxContextSize: z.number().int().min(1).max(100_000_000).optional(),
  displayName: z.string().min(1).max(256).optional(),
  capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
  efforts: z.array(effortString).min(1).max(16).optional(),
  defaultEffort: z.string().min(1).max(32).optional(),
  offEffort: z.enum(['none']).optional(),
  alwaysThinking: z.boolean().optional(),
  adaptiveThinking: z.boolean().optional(),
  reasoningKey: z.string().min(1).max(64).optional(),
  protocol: z.enum(['anthropic', 'openai_responses']).optional(),
  allowPartialThinking: z.boolean().optional(),
});

const listProvidersSchema = z.strictObject({});

const discoverSchema = z.strictObject({
  providerId: z.string().min(1).max(128),
  discoveryId: z.string().min(1).max(64).optional(),
  refreshCatalog: z.boolean().optional(),
  query: z.string().max(256).optional(),
  cursor: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

const previewSchema = z.strictObject({
  discoveryId: z.string().min(1).max(64),
  selectedModelIds: z.array(z.string().min(1).max(256)).min(1).max(256),
  overrides: z.record(z.string().max(256), modelOverridesSchema).optional(),
  candidateIds: z.record(z.string().max(256), z.string().min(1).max(64)).optional(),
});

const updateThinkingSchema = z.strictObject({
  providerId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  dryRun: z.literal(true),
  maxContextSize: z.number().int().min(1).max(100_000_000).optional(),
  displayName: z.string().min(1).max(256).optional(),
  capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
  efforts: z.array(effortString).min(1).max(16),
  defaultEffort: z.string().min(1).max(32).optional(),
  offEffort: z.enum(['none']).optional(),
  alwaysThinking: z.boolean().optional(),
  adaptiveThinking: z.boolean().optional(),
  reasoningKey: z.string().min(1).max(64).optional(),
  protocol: z.enum(['anthropic', 'openai_responses']).optional(),
  allowPartialThinking: z.boolean().optional(),
});

const applySchema = z.strictObject({
  changeId: z.string().min(1).max(64),
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function rejectForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) rejectForbiddenKeys(entry);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new KpeError('VALIDATION_FAILED', '参数包含非法键名');
      }
      rejectForbiddenKeys(entry);
    }
  }
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  rejectForbiddenKeys(args);
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new KpeError('VALIDATION_FAILED', '参数校验失败：' + result.error.issues[0]?.message);
  }
  return result.data;
}

export function createProviderEnhancedServer(service: ProviderEnhancedService): McpServer {
  const server = new McpServer({ name: PLUGIN_NAME, version: PLUGIN_VERSION });
  const wrap =
    <T>(handler: (input: T) => Promise<unknown>) =>
    async (
      args: unknown,
    ): Promise<{
      content: { type: 'text'; text: string }[];
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    }> => {
      try {
        const result = (await handler(args as T)) as Record<string, unknown>;
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const kpe = toKpeError(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: { code: kpe.code, message: kpe.message } }),
            },
          ],
        };
      }
    };

  server.registerTool(
    'list_providers',
    {
      description: '列出本地 Kimi 自定义供应商的脱敏摘要，不修改配置。',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrap(async (raw) => {
      parse(listProvidersSchema, raw);
      return service.listProviders();
    }),
  );

  server.registerTool(
    'discover_models',
    {
      description:
        '从指定供应商拉取可用模型，返回可分页的固定快照及有来源的思考档位建议，不修改配置。',
      inputSchema: {
        providerId: z.string(),
        discoveryId: z.string().optional(),
        refreshCatalog: z.boolean().optional(),
        query: z.string().optional(),
        cursor: z.number().optional(),
        pageSize: z.number().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    wrap(async (raw) => service.discoverModels(parse(discoverSchema, raw))),
  );

  server.registerTool(
    'preview_changes',
    {
      description:
        '仅为用户选中的模型生成配置变更预览；展示差异和警告后等待用户确认，不修改配置。',
      inputSchema: {
        discoveryId: z.string(),
        selectedModelIds: z.array(z.string()),
        overrides: z.record(z.string(), modelOverridesSchema).optional(),
        candidateIds: z.record(z.string(), z.string()).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    wrap(async (raw) => service.previewChanges(parse(previewSchema, raw))),
  );

  server.registerTool(
    'update_model_thinking',
    {
      description: '为已有模型的手动思考档位设置生成预览，不修改配置。',
      inputSchema: {
        providerId: z.string(),
        modelId: z.string(),
        dryRun: z.literal(true),
        maxContextSize: z.number().optional(),
        displayName: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        efforts: z.array(z.string()),
        defaultEffort: z.string().optional(),
        offEffort: z.string().optional(),
        alwaysThinking: z.boolean().optional(),
        adaptiveThinking: z.boolean().optional(),
        reasoningKey: z.string().optional(),
        protocol: z.enum(['anthropic', 'openai_responses']).optional(),
        allowPartialThinking: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    wrap(async (raw) => service.updateModelThinking(parse(updateThinkingSchema, raw))),
  );

  server.registerTool(
    'apply_changes',
    {
      description:
        '仅在用户已明确确认所展示的预览后，应用对应 changeId；不删除模型或修改默认模型。',
      inputSchema: { changeId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrap(async (raw) => service.applyChanges(parse(applySchema, raw))),
  );

  return server;
}

async function main(): Promise<void> {
  const home = resolveKimiHome();
  const service = new ProviderEnhancedService({ home, env: process.env });
  const server = createProviderEnhancedServer(service);
  await server.connect(new StdioServerTransport());
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
