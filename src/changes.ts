import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { KpeError } from './errors.ts';
import {
  sanitizeUrlForDisplay,
  type CatalogModelItem,
  type KimiClient,
  type KimiConfig,
  type ProviderDetail,
} from './kimi-client.ts';
import type { Candidate } from './match.ts';
import { auditDir, ensureDir, writeFileAtomic } from './storage.ts';
import type { DiscoveredModel } from './discovery.ts';
import type { ModelOverrides, PreviewInput, UpdateThinkingInput } from './types.ts';

const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const CHANGE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 32;
const GENERIC_OPENAI = new Set(['openai', 'openai_responses']);
const NATIVE_TOGGLE = new Set(['kimi', 'anthropic']);
const THINKING_CAPS = new Set(['thinking', 'always_thinking']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function strArr(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function mid(values: readonly string[]): string {
  return values[Math.floor(values.length / 2)]!;
}

function camelToSnake(key: string): string {
  return key.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (isObject(base) && isObject(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in base ? deepMerge(base[key], value) : value;
    }
    return out;
  }
  return patch;
}

function camelizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const camel = key.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
    out[camel] = isObject(value) ? camelizeRecord(value) : value;
  }
  return out;
}

const DISPLAY_MODEL_KEYS = new Set([
  'provider',
  'model',
  'maxContextSize',
  'maxInputSize',
  'maxOutputSize',
  'displayName',
  'capabilities',
  'supportEfforts',
  'defaultEffort',
  'offEffort',
  'adaptiveThinking',
  'reasoningKey',
  'protocol',
  'betaApi',
]);

function displayModelRecord(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (record === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'overrides') {
      if (isObject(value)) {
        const inner = displayModelRecord(value);
        if (inner !== undefined) out[key] = inner;
      }
      continue;
    }
    if (key === 'baseUrl') {
      const safe = sanitizeUrlForDisplay(typeof value === 'string' ? value : undefined);
      if (safe !== undefined) out[key] = safe;
      continue;
    }
    if (!DISPLAY_MODEL_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      out[key] = [...value];
    }
  }
  return out;
}

function hashableRecord(record: unknown): unknown {
  if (record === undefined) return null;
  if (Array.isArray(record)) return record.map((entry) => hashableRecord(entry));
  if (isObject(record)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === 'has_api_key' || key === 'hasApiKey') continue;
      out[key] = hashableRecord(value);
    }
    return out;
  }
  return record;
}

export function providerFingerprint(detail: ProviderDetail): string {
  return sha256(
    stableStringify({
      id: detail.id,
      type: detail.type,
      base_url: detail.base_url ?? null,
      default_model: detail.default_model ?? null,
      api_key_env: detail.api_key_env ?? null,
      has_api_key: detail.has_api_key === true,
      key_hash:
        typeof detail.api_key === 'string' && detail.api_key !== ''
          ? sha256(detail.api_key)
          : null,
    }),
  );
}

export interface SnapshotItem extends DiscoveredModel {
  alreadyConfigured: boolean;
  candidates: Candidate[];
  suggestionId?: string;
  conflict: boolean;
  warnings: string[];
}

export interface DiscoverySnapshot {
  id: string;
  createdAt: number;
  serverKey: string;
  providerFingerprint: string;
  providerId: string;
  providerWire: string;
  providerEndpoint?: string;
  items: SnapshotItem[];
  warnings: string[];
}

export class SnapshotStore {
  private readonly entries = new Map<string, DiscoverySnapshot>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(now: () => number = Date.now, ttlMs = SNAPSHOT_TTL_MS, max = MAX_ENTRIES) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
  }

  add(snapshot: Omit<DiscoverySnapshot, 'id' | 'createdAt'>): DiscoverySnapshot {
    this.evict();
    const full: DiscoverySnapshot = { ...snapshot, id: randomUUID(), createdAt: this.now() };
    this.entries.set(full.id, full);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return full;
  }

  get(id: string): DiscoverySnapshot | undefined {
    const snapshot = this.entries.get(id);
    if (snapshot === undefined) return undefined;
    if (this.now() - snapshot.createdAt > this.ttlMs) {
      this.entries.delete(id);
      return undefined;
    }
    return snapshot;
  }

  private evict(): void {
    for (const [id, snapshot] of this.entries) {
      if (this.now() - snapshot.createdAt > this.ttlMs) this.entries.delete(id);
    }
  }
}

export interface PreviewItem {
  modelId: string;
  alias: string;
  action: 'add' | 'update';
  patch: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  warnings: string[];
  blocked?: string;
}

export interface ApplyOutcomeItem {
  alias: string;
  modelId: string;
  verified: boolean;
  detail: string;
}

export interface ApplyOutcome {
  status: 'applied' | 'noop' | 'partial' | 'failed' | 'unknown';
  httpPosted: boolean;
  items: ApplyOutcomeItem[];
  warnings: string[];
}

export interface ChangeRecord {
  changeId: string;
  createdAt: number;
  serverKey: string;
  providerFingerprint: string;
  providerId: string;
  stateHash: string;
  blocked: boolean;
  items: PreviewItem[];
  originals: Record<string, Record<string, unknown> | undefined>;
  warnings: string[];
  consumed: boolean;
  outcome?: ApplyOutcome;
}

export class ChangeStore {
  private readonly entries = new Map<string, ChangeRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(now: () => number = Date.now, ttlMs = CHANGE_TTL_MS, max = MAX_ENTRIES) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
  }

  add(record: Omit<ChangeRecord, 'changeId' | 'createdAt' | 'consumed'>): ChangeRecord {
    this.evict();
    const full: ChangeRecord = {
      ...record,
      changeId: randomUUID(),
      createdAt: this.now(),
      consumed: false,
    };
    this.entries.set(full.changeId, full);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return full;
  }

  get(id: string): ChangeRecord {
    const record = this.entries.get(id);
    if (record === undefined) {
      throw new KpeError('CHANGE_NOT_FOUND', '变更不存在或已过期，请重新生成预览');
    }
    if (this.expired(record)) {
      this.entries.delete(id);
      throw new KpeError('CHANGE_EXPIRED', '预览已过期，请重新生成预览并确认');
    }
    return record;
  }

  expired(record: ChangeRecord): boolean {
    return this.now() - record.createdAt > this.ttlMs;
  }

  private evict(): void {
    for (const [id, record] of this.entries) {
      if (this.now() - record.createdAt > this.ttlMs) this.entries.delete(id);
    }
  }
}

function computeStateHash(
  providerFp: string,
  aliases: readonly string[],
  models: Record<string, Record<string, unknown>>,
): string {
  const records: Record<string, unknown> = {};
  for (const alias of aliases) records[alias] = hashableRecord(models[alias]);
  return sha256(stableStringify({ provider: providerFp, records }));
}

interface PlannedWrite {
  scope: 'base' | 'overrides';
  key: string;
  value: unknown;
}

interface PlanResult {
  modelId: string;
  alias: string;
  action: 'add' | 'update';
  writes: PlannedWrite[];
  warnings: string[];
  blocked?: string;
  existing?: Record<string, unknown>;
}

function writeScope(existing: Record<string, unknown> | undefined, key: string): 'base' | 'overrides' {
  if (existing === undefined) return 'base';
  const overrides = existing['overrides'];
  if (isObject(overrides) && overrides[key] !== undefined) return 'overrides';
  return 'base';
}

function findAlias(
  models: Record<string, Record<string, unknown>>,
  providerId: string,
  modelId: string,
): { alias?: string; record?: Record<string, unknown>; ambiguous: boolean } {
  const matches = Object.entries(models).filter(
    ([, record]) => record['provider'] === providerId && record['model'] === modelId,
  );
  if (matches.length > 1) return { ambiguous: true };
  const first = matches[0];
  if (first === undefined) return { ambiguous: false };
  return { alias: first[0], record: first[1], ambiguous: false };
}

function dedupeCaps(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '') continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  return out;
}

function planItem(args: {
  modelId: string;
  provider: ProviderDetail;
  models: Record<string, Record<string, unknown>>;
  discovered?: SnapshotItem;
  candidate?: Candidate;
  override?: ModelOverrides;
  manual: boolean;
}): PlanResult {
  return { modelId: args.modelId, ...planItemBody(args) };
}

function dedupeList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function effectiveValue(record: Record<string, unknown>, key: string): unknown {
  const overrides = record['overrides'];
  if (isObject(overrides) && overrides[key] !== undefined) return overrides[key];
  return record[key];
}

function planItemBody(args: {
  modelId: string;
  provider: ProviderDetail;
  models: Record<string, Record<string, unknown>>;
  discovered?: SnapshotItem;
  candidate?: Candidate;
  override?: ModelOverrides;
  manual: boolean;
}): Omit<PlanResult, 'modelId'> {
  const warnings: string[] = [...(args.discovered?.warnings ?? [])];
  const found = findAlias(args.models, args.provider.id, args.modelId);
  if (found.ambiguous) {
    return {
      alias: '',
      action: 'update',
      writes: [],
      warnings,
      blocked: `存在多个别名同时指向该模型（provider+model 重复），请先在 Kimi 设置中整理`,
    };
  }
  const isNew = found.alias === undefined;
  const alias = found.alias ?? `${args.provider.id}/${args.modelId}`;
  const existing = found.record;
  if (isNew && args.models[alias] !== undefined) {
    return {
      alias,
      action: 'add',
      writes: [],
      warnings,
      blocked: `别名 ${alias} 已被其他供应商或模型占用`,
    };
  }
  if (!args.manual && args.discovered?.unsupportedReason !== undefined) {
    return {
      alias,
      action: isNew ? 'add' : 'update',
      writes: [],
      warnings,
      blocked:
        args.discovered.unsupportedReason === 'embedding'
          ? '该模型为嵌入模型，不支持作为聊天模型导入'
          : '该模型未声明聊天端点，不支持导入',
      existing,
    };
  }

  const effective: Record<string, unknown> = existing === undefined ? {} : { ...existing };
  if (existing !== undefined && isObject(existing['overrides'])) {
    Object.assign(effective, existing['overrides']);
  }
  const writes: PlannedWrite[] = [];
  const push = (key: string, value: unknown) => {
    writes.push({ scope: writeScope(existing, key), key, value });
  };
  const ov = args.override;

  const context =
    ov?.maxContextSize ??
    num(effective['maxContextSize']) ??
    args.discovered?.context ??
    args.candidate?.context;
  if (isNew) {
    if (context === undefined || context <= 0) {
      return {
        alias,
        action: 'add',
        writes: [],
        warnings,
        blocked: '缺少有效的上下文长度，无法导入该模型',
        existing,
      };
    }
    push('provider', args.provider.id);
    push('model', args.modelId);
    push('maxContextSize', context);
  } else if (ov?.maxContextSize !== undefined && ov.maxContextSize !== effective['maxContextSize']) {
    push('maxContextSize', ov.maxContextSize);
  }

  if (ov?.displayName !== undefined) {
    push('displayName', ov.displayName);
  } else if (isNew && args.discovered?.name !== undefined) {
    push('displayName', args.discovered.name);
  }

  const endpoints = args.discovered?.endpoints ?? [];
  const currentProtocol = str(effective['protocol']);
  const desiredWire = ov?.protocol ?? currentProtocol ?? args.provider.type;
  if (endpoints.length > 0) {
    const required =
      desiredWire === 'anthropic'
        ? '/messages'
        : desiredWire === 'openai_responses'
          ? '/responses'
          : '/chat/completions';
    if (!endpoints.includes(required)) {
      return {
        alias,
        action: isNew ? 'add' : 'update',
        writes: [],
        warnings,
        blocked: `该模型不支持 ${required} 端点，与 ${desiredWire} 协议不兼容`,
        existing,
      };
    }
  }

  if (ov?.protocol !== undefined && ov.protocol !== currentProtocol) {
    if (
      currentProtocol === 'anthropic' &&
      ov.protocol !== 'anthropic' &&
      str(effective['baseUrl']) !== undefined
    ) {
      return {
        alias,
        action: isNew ? 'add' : 'update',
        writes: [],
        warnings,
        blocked: '切换协议需要移除模型级 base_url，但当前不支持删除字段，请先在 Kimi 设置中处理',
        existing,
      };
    }
    push('protocol', ov.protocol);
    if (ov.protocol === 'anthropic') {
      const baseUrl = str(args.provider.base_url);
      if (baseUrl !== undefined && /\/v1\/?$/.test(new URL(baseUrl).pathname)) {
        const adjusted = baseUrl.replace(/\/v1\/?$/, '');
        if (str(effective['baseUrl']) !== adjusted) {
          push('baseUrl', adjusted);
          warnings.push(`按 anthropic 协议将模型 base_url 调整为 ${adjusted}`);
        }
      }
    }
  }

  const genericOpenai = GENERIC_OPENAI.has(desiredWire);
  const nativeToggle = NATIVE_TOGGLE.has(desiredWire);
  const control = args.candidate?.control;
  const existingCaps = dedupeCaps(strArr(effective['capabilities']) ?? []);
  const pinnedEfforts = strArr(effective['supportEfforts']);
  const hasAlwaysThinkingCap = existingCaps.some(
    (cap) => cap.toLowerCase() === 'always_thinking',
  );
  const hasThinkingMeta =
    existing !== undefined &&
    (pinnedEfforts !== undefined ||
      effective['defaultEffort'] !== undefined ||
      effective['offEffort'] !== undefined ||
      hasAlwaysThinkingCap);
  const manualEfforts =
    ov?.efforts === undefined ? undefined : dedupeList(ov.efforts);

  let efforts: string[] | undefined;
  let offEffort: string | undefined;
  let wantAlwaysThinking: boolean | undefined;
  if (manualEfforts !== undefined) {
    efforts = manualEfforts;
    offEffort = ov?.offEffort;
    wantAlwaysThinking = ov?.alwaysThinking;
  } else if (hasThinkingMeta) {
    if (control !== undefined && control.kind !== 'unknown' && control.kind !== 'none') {
      warnings.push('已有 support_efforts 等思考配置保持不变（目录建议不同，未覆盖）');
    }
  } else if (control !== undefined) {
    if (genericOpenai && (control.hasToggle || control.hasNull)) {
      return {
        alias,
        action: isNew ? 'add' : 'update',
        writes: [],
        warnings,
        blocked:
          '目录声明开关/空档控制，openai 兼容协议无法编码关闭；可手动指定 efforts 并设置 allowPartialThinking=true',
        existing,
      };
    }
    if (control.kind === 'effort') {
      efforts = control.efforts;
      if (!nativeToggle) offEffort = control.offEffort;
      if (control.alwaysThinking === true) wantAlwaysThinking = true;
    } else if (control.kind === 'none' && control.alwaysThinking === true) {
      wantAlwaysThinking = true;
    } else if (control.kind === 'budget') {
      warnings.push('目录声明 budget_tokens 控制，当前版本不自动映射为离散档位');
    } else if (control.kind === 'unknown') {
      warnings.push('未找到可信的思考档位信息，未写入档位配置');
    }
  }

  if (ov?.alwaysThinking !== undefined) wantAlwaysThinking = ov.alwaysThinking;
  const effectiveOff = ov?.offEffort ?? str(effective['offEffort']) ?? offEffort;
  const finalAlways = ov?.alwaysThinking ?? wantAlwaysThinking ?? hasAlwaysThinkingCap;
  if (finalAlways === true && effectiveOff !== undefined) {
    return {
      alias,
      action: isNew ? 'add' : 'update',
      writes: [],
      warnings,
      blocked: 'alwaysThinking 与已存在的 offEffort 冲突，无法自动移除 offEffort',
      existing,
    };
  }

  if (manualEfforts !== undefined && genericOpenai) {
    const resolvedAlways =
      wantAlwaysThinking === true || (wantAlwaysThinking === undefined && hasAlwaysThinkingCap);
    if (effectiveOff === undefined && !resolvedAlways) {
      if (ov?.allowPartialThinking !== true) {
        return {
          alias,
          action: isNew ? 'add' : 'update',
          writes: [],
          warnings,
          blocked:
            '该协议无法编码关闭；如确认只使用部分档位请设置 allowPartialThinking=true',
          existing,
        };
      }
      warnings.push('已按确认仅配置部分档位；Off 在该协议下不可用');
    }
  }

  const finalEfforts = efforts ?? pinnedEfforts;
  if (
    ov?.defaultEffort !== undefined &&
    (finalEfforts === undefined || !finalEfforts.includes(ov.defaultEffort))
  ) {
    return {
      alias,
      action: isNew ? 'add' : 'update',
      writes: [],
      warnings,
      blocked: 'defaultEffort 必须属于 efforts',
      existing,
    };
  }

  const effortsPinned = manualEfforts === undefined && pinnedEfforts !== undefined;
  let writeEfforts = false;
  if (
    efforts !== undefined &&
    !effortsPinned &&
    (manualEfforts !== undefined || !hasThinkingMeta)
  ) {
    if (existing === undefined || !deepEqual(pinnedEfforts, efforts)) {
      push('supportEfforts', efforts);
      writeEfforts = true;
    }
  }

  if (ov?.defaultEffort !== undefined) {
    if (ov.defaultEffort !== effective['defaultEffort']) push('defaultEffort', ov.defaultEffort);
  } else if (efforts !== undefined && (writeEfforts || (isNew && !hasThinkingMeta))) {
    const existingDefault = str(effective['defaultEffort']);
    const chosen =
      existingDefault !== undefined && efforts.includes(existingDefault)
        ? existingDefault
        : mid(efforts);
    push('defaultEffort', chosen);
  }

  if (ov?.offEffort !== undefined) {
    if (ov.offEffort !== effective['offEffort']) push('offEffort', ov.offEffort);
  } else if (writeEfforts && offEffort !== undefined && effective['offEffort'] === undefined) {
    push('offEffort', offEffort);
  }

  if (ov?.reasoningKey !== undefined) push('reasoningKey', ov.reasoningKey);
  if (ov?.adaptiveThinking !== undefined) push('adaptiveThinking', ov.adaptiveThinking);

  const touchesThinking =
    manualEfforts !== undefined || writeEfforts || wantAlwaysThinking === true;

  let caps: string[] | undefined;
  if (ov?.capabilities !== undefined) {
    caps = dedupeCaps(ov.capabilities);
    if (ov.alwaysThinking !== undefined) {
      const capsAlways = caps.some((cap) => cap.toLowerCase() === 'always_thinking');
      if (capsAlways !== ov.alwaysThinking) {
        return {
          alias,
          action: isNew ? 'add' : 'update',
          writes: [],
          warnings,
          blocked: 'capabilities 与 alwaysThinking 声明矛盾，请修正后重试',
          existing,
        };
      }
    }
  } else if (isNew && args.discovered !== undefined) {
    const declared: string[] = [];
    if (args.discovered.toolCall === true) declared.push('tool_use');
    for (const mod of args.discovered.modalitiesInput ?? []) {
      if (mod === 'image') declared.push('image_in');
      if (mod === 'video') declared.push('video_in');
      if (mod === 'audio') declared.push('audio_in');
    }
    if (declared.length > 0) caps = dedupeCaps(declared);
  }
  if (ov?.alwaysThinking === false) {
    caps = (caps ?? [...existingCaps]).filter(
      (cap) => cap.toLowerCase() !== 'always_thinking',
    );
  }
  if (wantAlwaysThinking === true) {
    caps = (caps ?? [...existingCaps]).filter(
      (cap) => !THINKING_CAPS.has(cap.toLowerCase()),
    );
    caps.push('always_thinking');
  } else if (
    touchesThinking &&
    !(caps ?? existingCaps).some((cap) => THINKING_CAPS.has(cap.toLowerCase()))
  ) {
    caps = [...(caps ?? existingCaps), 'thinking'];
  }
  if (caps !== undefined && !deepEqual(caps, existingCaps)) {
    push('capabilities', caps);
  }

  return {
    alias,
    action: isNew ? 'add' : 'update',
    writes,
    warnings,
    existing,
  };
}

function writesToPatch(writes: readonly PlannedWrite[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const overridesPatch: Record<string, unknown> = {};
  for (const write of writes) {
    if (write.scope === 'overrides') overridesPatch[camelToSnake(write.key)] = write.value;
    else patch[camelToSnake(write.key)] = write.value;
  }
  if (Object.keys(overridesPatch).length > 0) patch['overrides'] = overridesPatch;
  return patch;
}

export interface PreviewResult {
  changeId: string;
  expiresAt: number;
  blocked: boolean;
  items: PreviewItem[];
  warnings: string[];
}

function assemblePreview(args: {
  plans: PlanResult[];
  models: Record<string, Record<string, unknown>>;
  serverKey: string;
  providerFp: string;
  providerId: string;
  warnings: string[];
  store: ChangeStore;
  now: () => number;
}): PreviewResult {
  const items: PreviewItem[] = args.plans.map((plan) => {
    const patch = writesToPatch(plan.writes);
    const before = displayModelRecord(plan.existing);
    const afterRaw = deepMerge(
      plan.existing ?? {},
      camelizeRecord(patch),
    ) as Record<string, unknown>;
    const after = plan.blocked === undefined ? displayModelRecord(afterRaw) : undefined;
    return {
      modelId: plan.modelId,
      alias: plan.alias,
      action: plan.action,
      patch,
      before,
      after,
      warnings: plan.warnings,
      blocked: plan.blocked,
    };
  });
  const originals: Record<string, Record<string, unknown> | undefined> = {};
  for (const plan of args.plans) originals[plan.alias] = plan.existing;
  const blocked = items.some((item) => item.blocked !== undefined);
  const aliases = items.map((item) => item.alias).filter((alias) => alias !== '');
  const stateHash = computeStateHash(args.providerFp, aliases, args.models);
  const record = args.store.add({
    serverKey: args.serverKey,
    providerFingerprint: args.providerFp,
    providerId: args.providerId,
    stateHash,
    blocked,
    items,
    originals,
    warnings: args.warnings,
  });
  return {
    changeId: record.changeId,
    expiresAt: record.createdAt + CHANGE_TTL_MS,
    blocked,
    items,
    warnings: args.warnings,
  };
}

export function buildDiscoveryPreview(args: {
  input: PreviewInput;
  snapshot: DiscoverySnapshot;
  client: KimiClient;
  config: KimiConfig;
  provider: ProviderDetail;
  store: ChangeStore;
  now: () => number;
}): PreviewResult {
  if (args.snapshot.serverKey !== args.client.connection.serverKey) {
    throw new KpeError('SNAPSHOT_INVALID', '发现快照与当前服务器不一致，请重新发现');
  }
  const providerFp = providerFingerprint(args.provider);
  if (providerFp !== args.snapshot.providerFingerprint) {
    throw new KpeError('PROVIDER_CHANGED', '供应商配置在发现后已变化，请重新发现');
  }
  const plans: PlanResult[] = [];
  const seen = new Set<string>();
  for (const modelId of args.input.selectedModelIds) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    const item = args.snapshot.items.find((entry) => entry.id === modelId);
    if (item === undefined) {
      throw new KpeError('SELECTION_INVALID', `模型 ${modelId} 不在当前发现快照中`);
    }
    let candidate: Candidate | undefined;
    const candidateId = args.input.candidateIds?.[modelId];
    if (candidateId !== undefined) {
      candidate = item.candidates.find((entry) => entry.id === candidateId);
      if (candidate === undefined) {
        throw new KpeError('CANDIDATE_INVALID', `候选 ${candidateId} 不属于模型 ${modelId}`);
      }
    } else if (item.suggestionId !== undefined) {
      candidate = item.candidates.find((entry) => entry.id === item.suggestionId);
    } else if (item.conflict) {
      const override = args.input.overrides?.[modelId];
      const existingFound = findAlias(args.config.models, args.provider.id, modelId);
      const hasPinnedEfforts =
        !existingFound.ambiguous &&
        existingFound.record !== undefined &&
        strArr(effectiveValue(existingFound.record, 'supportEfforts')) !== undefined;
      if (override?.efforts === undefined && !hasPinnedEfforts) {
        plans.push({
          modelId,
          alias: '',
          action: 'add',
          writes: [],
          warnings: [],
          blocked: `模型 ${modelId} 存在多个冲突的思考档位候选，请通过 candidateIds 或 overrides 选择`,
        });
        continue;
      }
      plans.push(
        planItem({
          modelId,
          provider: args.provider,
          models: args.config.models,
          discovered: item,
          candidate: undefined,
          override,
          manual: false,
        }),
      );
      continue;
    }
    plans.push(
      planItem({
        modelId,
        provider: args.provider,
        models: args.config.models,
        discovered: item,
        candidate,
        override: args.input.overrides?.[modelId],
        manual: false,
      }),
    );
  }
  return assemblePreview({
    plans,
    models: args.config.models,
    serverKey: args.client.connection.serverKey,
    providerFp,
    providerId: args.provider.id,
    warnings: args.snapshot.warnings,
    store: args.store,
    now: args.now,
  });
}

export function buildThinkingPreview(args: {
  input: UpdateThinkingInput;
  client: KimiClient;
  config: KimiConfig;
  provider: ProviderDetail;
  store: ChangeStore;
  now: () => number;
}): PreviewResult {
  const found = findAlias(args.config.models, args.provider.id, args.input.modelId);
  if (found.ambiguous) {
    throw new KpeError('ALIAS_AMBIGUOUS', '多个别名指向同一模型，请先在 Kimi 设置中整理');
  }
  if (found.alias === undefined) {
    throw new KpeError(
      'MODEL_NOT_CONFIGURED',
      `供应商 ${args.provider.id} 下未配置模型 ${args.input.modelId}`,
    );
  }
  const { providerId: _p, modelId: _m, dryRun: _d, ...override } = args.input;
  const plan = planItem({
    modelId: args.input.modelId,
    provider: args.provider,
    models: args.config.models,
    override,
    manual: true,
  });
  return assemblePreview({
    plans: [plan],
    models: args.config.models,
    serverKey: args.client.connection.serverKey,
    providerFp: providerFingerprint(args.provider),
    providerId: args.provider.id,
    warnings: [],
    store: args.store,
    now: args.now,
  });
}

let applyChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = applyChain.then(task, task);
  applyChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function expectedAfter(
  item: PreviewItem,
  original: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (item.blocked !== undefined) return undefined;
  return deepMerge(original ?? {}, camelizeRecord(item.patch)) as Record<string, unknown>;
}

function recordMatchesExpected(
  record: Record<string, unknown> | undefined,
  item: PreviewItem,
  original: Record<string, unknown> | undefined,
): 'written' | 'unchanged' | 'different' {
  if (record === undefined) return item.action === 'add' ? 'unchanged' : 'different';
  const expected = expectedAfter(item, original);
  if (expected === undefined) return 'different';
  for (const [key, value] of Object.entries(expected)) {
    if (!deepEqual(record[key], value)) {
      return deepEqual(record, original ?? null) ? 'unchanged' : 'different';
    }
  }
  return 'written';
}

export async function applyChange(args: {
  changeId: string;
  store: ChangeStore;
  client: KimiClient;
  home: string;
  now: () => number;
}): Promise<ApplyOutcome> {
  const record = args.store.get(args.changeId);
  if (record.serverKey !== args.client.connection.serverKey) {
    throw new KpeError('CONFIG_CHANGED', '当前服务器与预览时不一致，请重新预览');
  }
  if (record.consumed && record.outcome !== undefined) return record.outcome;
  return enqueue(async () => {
    if (record.consumed) {
      if (record.outcome !== undefined) return record.outcome;
      const outcome: ApplyOutcome = {
        status: 'unknown',
        httpPosted: true,
        items: record.items.map((item) => ({
          alias: item.alias,
          modelId: item.modelId,
          verified: false,
          detail: '提交已发出但结果未知，已锁定该变更',
        })),
        warnings: ['前一次提交未完成，状态未知；不会自动重试'],
      };
      record.outcome = outcome;
      return outcome;
    }
    if (args.store.expired(record)) {
      throw new KpeError('CHANGE_EXPIRED', '预览已过期，请重新生成预览并确认');
    }
    if (record.serverKey !== args.client.connection.serverKey) {
      throw new KpeError('CONFIG_CHANGED', '当前服务器与预览时不一致，请重新预览');
    }
    if (record.blocked) {
      throw new KpeError('CHANGE_BLOCKED', '预览包含阻塞项，请先解决后重新预览');
    }
    const provider = await args.client.getProvider(record.providerId);
    if (providerFingerprint(provider) !== record.providerFingerprint) {
      throw new KpeError('CONFIG_CHANGED', '供应商配置在预览后已变化，请重新预览');
    }
    const config = await args.client.getConfig();
    const aliases = record.items.map((item) => item.alias);
    if (computeStateHash(record.providerFingerprint, aliases, config.models) !== record.stateHash) {
      throw new KpeError('CONFIG_CHANGED', '相关模型配置在预览后已变化，请重新预览');
    }
    record.consumed = true;
    const patch: Record<string, unknown> = {};
    for (const item of record.items) {
      if (Object.keys(item.patch).length > 0) patch[item.alias] = item.patch;
    }
    if (Object.keys(patch).length === 0) {
      record.outcome = {
        status: 'noop',
        httpPosted: false,
        items: record.items.map((item) => ({
          alias: item.alias,
          modelId: item.modelId,
          verified: true,
          detail: '无字段变化',
        })),
        warnings: [],
      };
      await writeAudit(args.home, record, record.outcome);
      return record.outcome;
    }
    let postError: unknown;
    try {
      await args.client.postConfig({ models: patch });
    } catch (error) {
      postError = error;
    }
    const outcome = await classifyApplied(args.client, record, postError);
    record.outcome = outcome;
    await writeAudit(args.home, record, outcome);
    return outcome;
  });
}

async function classifyApplied(
  client: KimiClient,
  record: ChangeRecord,
  postError: unknown,
): Promise<ApplyOutcome> {
  const warnings: string[] = [];
  if (postError !== undefined) {
    warnings.push('提交请求未获成功响应，已按读回结果分类；不会自动重试');
    if (postError instanceof KpeError) warnings.push(`提交错误：${postError.code}`);
  }
  let config: KimiConfig;
  try {
    config = await client.getConfig();
  } catch {
    return {
      status: 'unknown',
      httpPosted: true,
      items: record.items.map((item) => ({
        alias: item.alias,
        modelId: item.modelId,
        verified: false,
        detail: '配置读回失败，状态未知',
      })),
      warnings: [...warnings, '配置读回失败，请在 WebUI 中核对'],
    };
  }
  const catalogItems = await client.listModels().catch(() => undefined);
  const items: ApplyOutcomeItem[] = record.items.map((item) => {
    const current = config.models[item.alias];
    const original = record.originals[item.alias];
    const state = recordMatchesExpected(current, item, original);
    let verified = state === 'written';
    let detail =
      state === 'written'
        ? '字段已写入'
        : state === 'unchanged'
          ? '未检测到写入'
          : '内容部分不一致';
    if (verified) {
      if (catalogItems === undefined) {
        verified = false;
        detail = '模型目录读回失败，无法确认';
      } else {
        const catalogItem = catalogItems.find(
          (entry) => entry.provider === record.providerId && entry.model === item.alias,
        );
        if (catalogItem === undefined) {
          verified = false;
          detail = '配置已写入但模型目录未出现该模型';
        } else {
          const expected = expectedAfter(item, original);
          const mismatch = catalogMismatch(expected, catalogItem);
          if (mismatch !== undefined) {
            verified = false;
            detail = mismatch;
          }
        }
      }
    }
    return { alias: item.alias, modelId: item.modelId, verified, detail };
  });
  let status: ApplyOutcome['status'];
  if (items.every((item) => item.verified)) status = 'applied';
  else if (items.every((item) => !item.verified && item.detail === '未检测到写入')) status = 'failed';
  else if (catalogItems === undefined) status = 'unknown';
  else if (items.every((item) => item.detail === '配置读回失败，状态未知')) status = 'unknown';
  else status = 'partial';
  return { status, httpPosted: true, items, warnings };
}

function catalogMismatch(
  expected: Record<string, unknown> | undefined,
  catalogItem: CatalogModelItem,
): string | undefined {
  if (expected === undefined) return '无法计算预期配置';
  const expectedEfforts = effectiveValue(expected, 'supportEfforts');
  if (
    expectedEfforts !== undefined &&
    !deepEqual(catalogItem.support_efforts ?? null, expectedEfforts)
  ) {
    return '模型目录中的 support_efforts 与预期不一致';
  }
  const expectedDefault = effectiveValue(expected, 'defaultEffort');
  if (
    expectedDefault !== undefined &&
    !deepEqual(catalogItem.default_effort ?? null, expectedDefault)
  ) {
    return '模型目录中的 default_effort 与预期不一致';
  }
  const expectedCaps = effectiveValue(expected, 'capabilities');
  if (expectedCaps !== undefined && Array.isArray(expectedCaps)) {
    const got = [...(catalogItem.capabilities ?? [])].sort();
    const want = [...expectedCaps].sort();
    if (!deepEqual(got, want)) return '模型目录中的 capabilities 与预期不一致';
  }
  return undefined;
}

async function writeAudit(
  home: string,
  record: ChangeRecord,
  outcome: ApplyOutcome,
): Promise<void> {
  try {
    await ensureDir(auditDir(home));
    const payload = {
      changeId: record.changeId,
      providerId: record.providerId,
      at: new Date().toISOString(),
      status: outcome.status,
      items: record.items.map((item) => ({
        alias: item.alias,
        modelId: item.modelId,
        action: item.action,
        patch: item.patch,
      })),
    };
    await writeFileAtomic(
      join(auditDir(home), `${Date.now()}-${record.changeId}.json`),
      JSON.stringify(payload, null, 2),
      0o600,
    );
  } catch {
  }
}
