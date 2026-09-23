export type Wire =
  | 'openai'
  | 'openai_responses'
  | 'kimi'
  | 'anthropic'
  | 'google-genai'
  | 'vertexai';

export interface ModelOverrides {
  maxContextSize?: number;
  displayName?: string;
  capabilities?: string[];
  efforts?: string[];
  defaultEffort?: string;
  offEffort?: string;
  alwaysThinking?: boolean;
  adaptiveThinking?: boolean;
  reasoningKey?: string;
  protocol?: 'anthropic' | 'openai_responses';
  allowPartialThinking?: boolean;
}

export interface DiscoverInput {
  providerId: string;
  discoveryId?: string;
  refreshCatalog?: boolean;
  query?: string;
  cursor?: number;
  pageSize?: number;
}

export interface PreviewInput {
  discoveryId: string;
  selectedModelIds: string[];
  overrides?: Record<string, ModelOverrides>;
  candidateIds?: Record<string, string>;
}

export interface UpdateThinkingInput extends ModelOverrides {
  providerId: string;
  modelId: string;
  efforts: string[];
  dryRun: true;
}

export interface ApplyInput {
  changeId: string;
}
