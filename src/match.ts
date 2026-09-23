import type { Wire } from './types.ts';

export interface ReasoningControl {
  kind: 'unknown' | 'none' | 'toggle' | 'budget' | 'effort';
  efforts: string[];
  hasToggle: boolean;
  hasBudget: boolean;
  hasNull: boolean;
  offEffort?: string;
  alwaysThinking: boolean;
}

export function normalizeReasoning(options: unknown, reasoning?: boolean): ReasoningControl {
  const out: ReasoningControl = {
    kind: 'unknown',
    efforts: [],
    hasToggle: false,
    hasBudget: false,
    hasNull: false,
    alwaysThinking: false,
  };
  if (!Array.isArray(options)) return reasoning === false ? { ...out, kind: 'none' } : out;
  if (options.length === 0) return { ...out, kind: 'none', alwaysThinking: reasoning === true };
  for (const option of options) {
    if (!option || typeof option !== 'object') continue;
    if (option.type === 'toggle') out.hasToggle = true;
    if (option.type === 'budget_tokens') out.hasBudget = true;
    if (option.type !== 'effort' || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      if (value === null) {
        out.hasNull = true;
        continue;
      }
      if (typeof value !== 'string') continue;
      const level = value.trim().toLowerCase();
      if (level === 'none') {
        out.offEffort = 'none';
        continue;
      }
      if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default'].includes(level))
        continue;
      if (!out.efforts.includes(level)) out.efforts.push(level);
    }
  }
  out.kind = out.efforts.length
    ? 'effort'
    : out.hasBudget
      ? 'budget'
      : out.hasToggle
        ? 'toggle'
        : 'unknown';
  out.alwaysThinking =
    out.kind === 'effort' && !out.hasToggle && !out.hasNull && out.offEffort === undefined;
  return out;
}

const VENDOR_PREFIXES = new Map([
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['deepseek', 'deepseek'],
  ['moonshotai', 'moonshotai'],
  ['moonshot', 'moonshotai'],
  ['z-ai', 'z-ai'],
  ['zai', 'z-ai'],
  ['xiaomi', 'xiaomi'],
  ['meta', 'meta'],
  ['google', 'google'],
  ['qwen', 'alibaba'],
  ['alibaba', 'alibaba'],
  ['x-ai', 'xai'],
  ['xai', 'xai'],
]);

export function identity(id: string): { full: string; leaf: string; vendor?: string } {
  const full = id.trim().toLowerCase();
  const parts = full.split('/');
  if (parts.length === 2 && VENDOR_PREFIXES.has(parts[0]!))
    return { full, leaf: parts[1]!, vendor: VENDOR_PREFIXES.get(parts[0]!) };
  return { full, leaf: full };
}

export function idMatches(a: string, b: string): boolean {
  const x = identity(a),
    y = identity(b);
  return (
    x.full === y.full || (x.leaf === y.leaf && !(x.vendor && y.vendor && x.vendor !== y.vendor))
  );
}

export type CandidateTier = 'provider' | 'endpoint' | 'suggested';

export interface CandidateSource {
  provider: string;
  model: string;
}

export interface Candidate {
  id: string;
  tier: CandidateTier;
  match: 'exact' | 'casefold' | 'alias' | 'declared';
  sources: CandidateSource[];
  endpoint?: string;
  wire?: string;
  control: ReasoningControl;
  context?: number;
  contexts: number[];
}

export interface CatalogRow {
  provider: string;
  model: string;
  api?: string;
  wire?: Wire;
  control: ReasoningControl;
  context?: number;
}

const TIER_ORDER: Record<CandidateTier, number> = { provider: 0, endpoint: 1, suggested: 2 };
const MATCH_ORDER = { exact: 0, casefold: 1, alias: 2, declared: 0 } as const;

export function normalizeEndpoint(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

export function wireCompatible(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a === b;
}

function matchRank(a: string, b: string): Candidate['match'] | undefined {
  if (a === b) return 'exact';
  if (a.toLowerCase() === b.toLowerCase()) return 'casefold';
  if (idMatches(a, b)) return 'alias';
  return undefined;
}

function canonicalControl(control: ReasoningControl): string {
  return JSON.stringify({
    kind: control.kind,
    efforts: control.efforts,
    hasToggle: control.hasToggle,
    hasBudget: control.hasBudget,
    hasNull: control.hasNull,
    offEffort: control.offEffort ?? null,
    alwaysThinking: control.alwaysThinking,
  });
}

export interface BuildCandidatesInput {
  modelId: string;
  providerEndpoint?: string;
  providerWire?: string;
  providerControl?: ReasoningControl;
  providerContext?: number;
  catalogRows: readonly CatalogRow[];
}

export interface CandidateBuild {
  candidates: Candidate[];
  suggestion?: Candidate;
  conflict: boolean;
  warnings: string[];
}

export function buildCandidates(input: BuildCandidatesInput): CandidateBuild {
  const raw: Omit<Candidate, 'id'>[] = [];
  if (input.providerControl !== undefined && input.providerControl.kind !== 'unknown') {
    raw.push({
      tier: 'provider',
      match: 'declared',
      sources: [{ provider: input.providerEndpoint ?? '', model: input.modelId }],
      endpoint: input.providerEndpoint,
      wire: input.providerWire,
      control: input.providerControl,
      context: input.providerContext,
      contexts: input.providerContext === undefined ? [] : [input.providerContext],
    });
  }
  const providerEndpoint = normalizeEndpoint(input.providerEndpoint);
  for (const row of input.catalogRows) {
    const match = matchRank(input.modelId, row.model);
    if (match === undefined) continue;
    const rowEndpoint = normalizeEndpoint(row.api);
    const sameProvider =
      providerEndpoint !== undefined &&
      rowEndpoint !== undefined &&
      rowEndpoint === providerEndpoint &&
      wireCompatible(row.wire, input.providerWire);
    raw.push({
      tier: sameProvider ? 'endpoint' : 'suggested',
      match,
      sources: [{ provider: row.provider, model: row.model }],
      endpoint: row.api,
      wire: row.wire,
      control: row.control,
      context: row.context,
      contexts: row.context === undefined ? [] : [row.context],
    });
  }
  const grouped = new Map<string, Omit<Candidate, 'id'>>();
  const warnings: string[] = [];
  for (const candidate of raw.toSorted(
    (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || MATCH_ORDER[a.match] - MATCH_ORDER[b.match],
  )) {
    const key = `${candidate.tier}${canonicalControl(candidate.control)}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, candidate);
    } else {
      existing.sources.push(...candidate.sources);
      for (const context of candidate.contexts) {
        if (!existing.contexts.includes(context)) existing.contexts.push(context);
      }
      if (existing.context !== candidate.context) {
        existing.context = undefined;
      }
    }
  }
  const candidates = [...grouped.values()].map((candidate, index) => ({
    ...candidate,
    id: `c${index}`,
  }));
  for (const candidate of candidates) {
    if (candidate.context === undefined && candidate.contexts.length > 1) {
      warnings.push(
        `模型 ${input.modelId} 的候选来源声明了不同的上下文长度，请手动确认 maxContextSize`,
      );
    }
  }
  const bestTier = candidates.length === 0 ? undefined : candidates[0]!.tier;
  const best = candidates.filter((candidate) => candidate.tier === bestTier);
  const suggestion = best.length === 1 ? best[0] : undefined;
  return { candidates, suggestion, conflict: suggestion === undefined && candidates.length > 0, warnings };
}
