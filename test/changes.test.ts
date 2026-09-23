import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  applyChange,
  buildDiscoveryPreview,
  buildThinkingPreview,
  ChangeStore,
  providerFingerprint,
  type DiscoverySnapshot,
} from '../src/changes.ts';
import { KpeError } from '../src/errors.ts';
import type { KimiClient } from '../src/kimi-client.ts';
import type { PreviewInput } from '../src/types.ts';
import {
  FakeKimiClient,
  makeConfig,
  makeProvider,
  makeSnapshot,
} from './helpers.ts';

const SECRET = 'test-provider-key-SECRET';

let home: string;
let now: number;
let store: ChangeStore;
let provider: ReturnType<typeof makeProvider>;
let client: FakeKimiClient;
let snapshot: DiscoverySnapshot;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kpe-changes-'));
  now = 1_000_000;
  store = new ChangeStore(() => now);
  provider = makeProvider();
  client = new FakeKimiClient(provider, makeConfig());
  snapshot = makeSnapshot({ providerFingerprint: providerFingerprint(provider) });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function previewInput(extra: Partial<PreviewInput> = {}): PreviewInput {
  return {
    discoveryId: snapshot.id,
    selectedModelIds: ['example-model-one'],
    ...extra,
  };
}

function preview(input: PreviewInput = previewInput()) {
  return buildDiscoveryPreview({
    input,
    snapshot,
    client: client as unknown as KimiClient,
    config: client.config,
    provider,
    store,
    now: () => now,
  });
}

async function apply(changeId: string) {
  return applyChange({
    changeId,
    store,
    client: client as unknown as KimiClient,
    home,
    now: () => now,
  });
}

describe('preview', () => {
  it('generates an add patch without writing anything', () => {
    const result = preview();
    assert.equal(result.blocked, false);
    assert.equal(client.postCalls.length, 0);
    const item = result.items[0]!;
    assert.equal(item.alias, 'demo/example-model-one');
    assert.equal(item.action, 'add');
    assert.equal(item.patch['provider'], 'demo');
    assert.equal(item.patch['model'], 'example-model-one');
    assert.equal(item.patch['max_context_size'], 32768);
    assert.deepEqual(item.patch['support_efforts'], ['low', 'high']);
    assert.equal(item.patch['off_effort'], 'none');
    assert.ok(item.patch['default_effort'] !== undefined);
    assert.deepEqual(item.patch['capabilities'], ['thinking']);
    assert.equal(item.before, undefined);
    assert.equal(item.after?.['maxContextSize'], 32768);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });

  it('reuses a noncanonical existing alias and patches only changed fields', async () => {
    client.config.models['My Custom Alias'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      custom_field: 'keep-me',
      customHeaders: { Authorization: 'private-test-secret' },
    };
    const result = preview();
    const item = result.items[0]!;
    assert.equal(item.alias, 'My Custom Alias');
    assert.equal(item.action, 'update');
    assert.equal(item.patch['provider'], undefined);
    assert.equal(item.patch['model'], undefined);
    assert.equal(item.patch['custom_field'], undefined);
    assert.deepEqual(item.patch['support_efforts'], ['low', 'high']);
    assert.equal(item.after?.['customField'], undefined);
    assert.equal(item.before?.['custom_field'], undefined);
    assert.ok(!JSON.stringify(result).includes('private-test-secret'));
    client.catalogItems = [
      {
        provider: 'demo',
        model: 'My Custom Alias',
        max_context_size: 32768,
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        capabilities: ['thinking'],
      },
    ];
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'applied');
    assert.equal(client.config.models['My Custom Alias']?.['custom_field'], 'keep-me');
    assert.deepEqual(client.config.models['My Custom Alias']?.['customHeaders'], {
      Authorization: 'private-test-secret',
    });
  });

  it('preserves underscore alias spellings', () => {
    client.config.models['vendor_model_one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
    };
    const result = preview();
    assert.equal(result.items[0]!.alias, 'vendor_model_one');
  });

  it('does not overwrite pinned existing support_efforts', () => {
    client.config.models['demo/example-model-one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      supportEfforts: ['low'],
    };
    const result = preview();
    const item = result.items[0]!;
    assert.equal(item.patch['support_efforts'], undefined);
    assert.ok(item.warnings.some((warning) => warning.includes('support_efforts')));
  });

  it('blocks conflicting candidates until candidateIds picks one', () => {
    snapshot.items[0]!.candidates.push({
      id: 'c1',
      tier: 'suggested',
      match: 'alias',
      sources: [{ provider: 'other', model: 'example-model-one' }],
      control: {
        kind: 'effort',
        efforts: ['max'],
        hasToggle: false,
        hasBudget: false,
        hasNull: false,
        alwaysThinking: true,
      },
      contexts: [],
    });
    snapshot.items[0]!.suggestionId = undefined;
    snapshot.items[0]!.conflict = true;
    const result = preview();
    assert.equal(result.blocked, true);
    assert.match(result.items[0]!.blocked ?? '', /candidateIds/);
    const chosen = preview(
      previewInput({ candidateIds: { 'example-model-one': 'c1' } }),
    );
    assert.equal(chosen.blocked, false);
    assert.deepEqual(chosen.items[0]!.patch['support_efforts'], ['max']);
  });

  it('rejects model ids not present in the snapshot', () => {
    assert.throws(
      () => preview(previewInput({ selectedModelIds: ['not-in-snapshot'] })),
      (error: unknown) => error instanceof KpeError && error.code === 'SELECTION_INVALID',
    );
  });

  it('blocks when the canonical alias is owned by another provider', () => {
    client.config.models['demo/example-model-one'] = {
      provider: 'other-provider',
      model: 'other-model',
      maxContextSize: 4096,
    };
    const result = preview();
    assert.equal(result.items[0]!.blocked !== undefined, true);
  });

  it('blocks provider fingerprint drift between discovery and preview', () => {
    const drifted = makeSnapshot({ providerFingerprint: 'deadbeef' });
    assert.throws(
      () =>
        buildDiscoveryPreview({
          input: previewInput(),
          snapshot: drifted,
          client: client as unknown as KimiClient,
          config: client.config,
          provider,
          store,
          now: () => now,
        }),
      (error: unknown) => error instanceof KpeError && error.code === 'PROVIDER_CHANGED',
    );
  });

  it('blocks messages-only models without explicit protocol override', () => {
    snapshot.items[0]!.endpoints = ['/messages'];
    const result = preview();
    assert.match(result.items[0]!.blocked ?? '', /不兼容/);
    const allowed = preview(
      previewInput({ overrides: { 'example-model-one': { protocol: 'anthropic' } } }),
    );
    assert.equal(allowed.blocked, false);
    assert.equal(allowed.items[0]!.patch['protocol'], 'anthropic');
  });

  it('manual effort override blocks unencoded upstream toggle without acknowledgment', () => {
    snapshot.items[0]!.candidates[0]!.control = {
      kind: 'effort',
      efforts: ['low', 'high'],
      hasToggle: true,
      hasBudget: false,
      hasNull: false,
      alwaysThinking: false,
    };
    const blocked = preview(
      previewInput({ overrides: { 'example-model-one': { efforts: ['low', 'high'] } } }),
    );
    assert.match(blocked.items[0]!.blocked ?? '', /allowPartialThinking/);
    const allowed = preview(
      previewInput({
        overrides: {
          'example-model-one': { efforts: ['low', 'high'], allowPartialThinking: true },
        },
      }),
    );
    assert.equal(allowed.blocked, false);
    assert.deepEqual(allowed.items[0]!.patch['support_efforts'], ['low', 'high']);
  });

  it('toggle or null controls on generic openai block automated config', () => {
    snapshot.items[0]!.candidates[0]!.control = {
      kind: 'effort',
      efforts: ['low', 'high'],
      hasToggle: false,
      hasBudget: false,
      hasNull: true,
      alwaysThinking: false,
    };
    const result = preview();
    assert.match(result.items[0]!.blocked ?? '', /无法编码/);
  });

  it('new model without context is blocked, never invents one', () => {
    snapshot.items[0]!.context = undefined;
    snapshot.items[0]!.candidates[0]!.context = undefined;
    const result = preview();
    assert.match(result.items[0]!.blocked ?? '', /上下文/);
  });

  it('manual efforts resolve candidate conflicts', () => {
    snapshot.items[0]!.conflict = true;
    snapshot.items[0]!.suggestionId = undefined;
    const blocked = preview();
    assert.equal(blocked.blocked, true);
    const manual = preview(
      previewInput({
        overrides: {
          'example-model-one': { efforts: ['low', 'high'], allowPartialThinking: true },
        },
      }),
    );
    assert.equal(manual.blocked, false);
    assert.deepEqual(manual.items[0]!.patch['support_efforts'], ['low', 'high']);
  });

  it('existing pinned efforts bypass candidate conflicts', () => {
    client.config.models['demo/example-model-one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      supportEfforts: ['low'],
      offEffort: 'none',
    };
    snapshot.items[0]!.conflict = true;
    snapshot.items[0]!.suggestionId = undefined;
    const result = preview();
    assert.equal(result.blocked, false);
    assert.equal(result.items[0]!.patch['support_efforts'], undefined);
  });

  it('manual efforts are deduplicated preserving order', () => {
    const result = preview(
      previewInput({
        overrides: {
          'example-model-one': {
            efforts: ['high', 'low', 'high'],
            allowPartialThinking: true,
          },
        },
      }),
    );
    assert.deepEqual(result.items[0]!.patch['support_efforts'], ['high', 'low']);
  });

  it('alwaysThinking conflicts with effective offEffort and blocks', () => {
    const result = preview(
      previewInput({
        overrides: {
          'example-model-one': {
            efforts: ['low', 'high'],
            offEffort: 'none',
            alwaysThinking: true,
          },
        },
      }),
    );
    assert.match(result.items[0]!.blocked ?? '', /alwaysThinking|offEffort/);
  });

  it('existing always_thinking is preserved for graded efforts unless explicitly removed', () => {
    client.config.models['demo/example-model-one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      capabilities: ['always_thinking'],
    };
    const kept = preview(
      previewInput({
        overrides: {
          'example-model-one': { efforts: ['low', 'high'], allowPartialThinking: true },
        },
      }),
    );
    assert.equal(kept.blocked, false);
    assert.equal(kept.items[0]!.patch['capabilities'], undefined);
    const allowed = preview(
      previewInput({
        overrides: {
          'example-model-one': {
            efforts: ['low', 'high'],
            allowPartialThinking: true,
            alwaysThinking: false,
          },
        },
      }),
    );
    assert.equal(allowed.blocked, false);
    assert.deepEqual(allowed.items[0]!.patch['capabilities'], ['thinking']);
  });

  it('manual capabilities replace discovered flags on new models', () => {
    snapshot.items[0]!.toolCall = true;
    const result = preview(
      previewInput({
        overrides: {
          'example-model-one': {
            efforts: ['low'],
            allowPartialThinking: true,
            capabilities: ['image_in'],
          },
        },
      }),
    );
    assert.deepEqual(result.items[0]!.patch['capabilities'], ['image_in', 'thinking']);
  });

  it('sanitizes credential-bearing base URLs in displayed records', () => {
    client.config.models['demo/example-model-one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      baseUrl: 'http://user:pass@127.0.0.1:9/v1?key=abc#frag',
      supportEfforts: ['low'],
    };
    const result = preview();
    const before = result.items[0]!.before;
    assert.equal(before?.['baseUrl'], 'http://127.0.0.1:9/v1');
    assert.ok(!JSON.stringify(result).includes('user:pass'));
    assert.ok(!JSON.stringify(result).includes('key=abc'));
  });
});

describe('update_model_thinking', () => {
  beforeEach(() => {
    client.config.models['vendor_model_one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      overrides: { supportEfforts: ['low'], custom: 'stay' },
      supportEfforts: ['low'],
    };
  });

  function thinkingPreview(overrides: Record<string, unknown> = {}) {
    return buildThinkingPreview({
      input: {
        providerId: 'demo',
        modelId: 'example-model-one',
        dryRun: true,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        allowPartialThinking: true,
        ...overrides,
      },
      client: client as unknown as KimiClient,
      config: client.config,
      provider,
      store,
      now: () => now,
    });
  }

  it('patches effective overrides scope, preserving unrelated overrides', () => {
    const result = thinkingPreview();
    const item = result.items[0]!;
    assert.equal(item.alias, 'vendor_model_one');
    const patchOverrides = item.patch['overrides'] as Record<string, unknown>;
    assert.deepEqual(patchOverrides['support_efforts'], ['low', 'high']);
    assert.equal(item.patch['default_effort'], 'high');
    assert.equal(item.patch['support_efforts'], undefined);
    assert.equal(item.patch['custom'], undefined);
  });

  it('does not leak nested unknown override fields in displayed records', () => {
    const existing = client.config.models['vendor_model_one']!;
    existing['overrides'] = {
      ...(existing['overrides'] as Record<string, unknown>),
      customToken: 'nested-test-secret',
    };
    const result = thinkingPreview();
    assert.ok(!JSON.stringify(result).includes('nested-test-secret'));
    const afterOverrides = result.items[0]!.after?.['overrides'] as
      | Record<string, unknown>
      | undefined;
    assert.equal(afterOverrides?.['customToken'], undefined);
  });

  it('rejects defaultEffort outside efforts', () => {
    const result = thinkingPreview({ defaultEffort: 'max' });
    assert.match(result.items[0]!.blocked ?? '', /defaultEffort/);
  });

  it('rejects default-only override not in pinned efforts', () => {
    const result = thinkingPreview({ efforts: undefined, defaultEffort: 'max' });
    assert.match(result.items[0]!.blocked ?? '', /defaultEffort/);
  });

  it('manual efforts on an always-on model keep always and need no partial flag', () => {
    client.config.models['vendor_model_one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      supportEfforts: ['low'],
      capabilities: ['always_thinking'],
    };
    const result = thinkingPreview({
      efforts: ['low', 'max'],
      defaultEffort: 'max',
      allowPartialThinking: undefined,
    });
    const item = result.items[0]!;
    assert.equal(item.blocked, undefined);
    assert.equal(item.patch['capabilities'], undefined);
    assert.deepEqual(
      (item.patch['overrides'] as Record<string, unknown> | undefined)?.['support_efforts'] ??
        item.patch['support_efforts'],
      ['low', 'max'],
    );
  });

  it('alwaysThinking false with efforts drops always and produces thinking', () => {
    client.config.models['vendor_model_one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      capabilities: ['always_thinking'],
    };
    const result = thinkingPreview({
      efforts: ['low'],
      defaultEffort: 'low',
      alwaysThinking: false,
    });
    const item = result.items[0]!;
    assert.equal(item.blocked, undefined);
    assert.deepEqual(item.patch['capabilities'], ['thinking']);
  });

  it('alwaysThinking true with offEffort is contradictory and blocked', () => {
    const result = thinkingPreview({
      efforts: ['low'],
      defaultEffort: 'low',
      alwaysThinking: true,
      offEffort: 'none',
    });
    assert.match(result.items[0]!.blocked ?? '', /alwaysThinking|offEffort/);
  });

  it('explicit capabilities contradicting explicit alwaysThinking are blocked', () => {
    const result = thinkingPreview({
      efforts: ['low'],
      defaultEffort: 'low',
      alwaysThinking: true,
      capabilities: ['thinking'],
    });
    assert.match(result.items[0]!.blocked ?? '', /矛盾/);
  });

  it('missing model is a controlled error', () => {
    assert.throws(
      () =>
        buildThinkingPreview({
          input: {
            providerId: 'demo',
            modelId: 'absent',
            dryRun: true,
            efforts: ['low'],
          },
          client: client as unknown as KimiClient,
          config: client.config,
          provider,
          store,
          now: () => now,
        }),
      (error: unknown) =>
        error instanceof KpeError && error.code === 'MODEL_NOT_CONFIGURED',
    );
  });
});

describe('apply', () => {
  it('applies a minimal patch and readback verifies', async () => {
    const result = preview();
    client.catalogItems = [
      {
        provider: 'demo',
        model: 'demo/example-model-one',
        max_context_size: 32768,
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        capabilities: ['thinking'],
      },
    ];
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'applied');
    assert.equal(outcome.httpPosted, true);
    assert.equal(client.postCalls.length, 1);
    const patch = client.postCalls[0]!;
    assert.deepEqual(Object.keys(patch), ['models']);
    const models = patch['models'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(models), ['demo/example-model-one']);
    assert.equal(client.config.default_model, 'other-provider/existing');
    assert.equal(client.config.default_provider, 'other-provider');
  });

  it('preserves unknown fields and unrelated models on apply', async () => {
    client.config.models['other/keep'] = {
      provider: 'other-provider',
      model: 'keep',
      maxContextSize: 8192,
      unknown_field: { nested: true },
    };
    const result = preview();
    client.catalogItems = [
      {
        provider: 'demo',
        model: 'demo/example-model-one',
        max_context_size: 32768,
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        capabilities: ['thinking'],
      },
    ];
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'applied');
    assert.deepEqual(client.config.models['other/keep'], {
      provider: 'other-provider',
      model: 'keep',
      maxContextSize: 8192,
      unknown_field: { nested: true },
    });
  });

  it('expired change ids fail with CHANGE_EXPIRED', async () => {
    const result = preview();
    now += 11 * 60 * 1000;
    await assert.rejects(
      apply(result.changeId),
      (error: unknown) => error instanceof KpeError && error.code === 'CHANGE_EXPIRED',
    );
    assert.equal(client.postCalls.length, 0);
  });

  it('server identity change fails', async () => {
    const result = preview();
    (client.connection as { serverKey: string }).serverKey = 'other-server';
    await assert.rejects(
      apply(result.changeId),
      (error: unknown) => error instanceof KpeError && error.code === 'CONFIG_CHANGED',
    );
    assert.equal(client.postCalls.length, 0);
  });

  it('server identity change after a consumed apply fails before cached outcome', async () => {
    const result = preview();
    client.catalogItems = [
      {
        provider: 'demo',
        model: 'demo/example-model-one',
        max_context_size: 32768,
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        capabilities: ['thinking'],
      },
    ];
    const first = await apply(result.changeId);
    assert.equal(first.status, 'applied');
    assert.equal(client.postCalls.length, 1);
    (client.connection as { serverKey: string }).serverKey = 'other-server';
    await assert.rejects(
      apply(result.changeId),
      (error: unknown) => error instanceof KpeError && error.code === 'CONFIG_CHANGED',
    );
    assert.equal(client.postCalls.length, 1);
  });

  it('config drift fails with CONFIG_CHANGED and never posts', async () => {
    const result = preview();
    client.config.models['demo/example-model-one'] = { provider: 'demo', model: 'drifted' };
    await assert.rejects(
      apply(result.changeId),
      (error: unknown) => error instanceof KpeError && error.code === 'CONFIG_CHANGED',
    );
    assert.equal(client.postCalls.length, 0);
  });

  it('provider drift fails with CONFIG_CHANGED', async () => {
    const result = preview();
    provider.base_url = 'http://127.0.0.1:9/v2';
    await assert.rejects(
      apply(result.changeId),
      (error: unknown) => error instanceof KpeError && error.code === 'CONFIG_CHANGED',
    );
    assert.equal(client.postCalls.length, 0);
  });

  it('credential change fails with CONFIG_CHANGED without leaking the key', async () => {
    const result = preview();
    provider.api_key = 'rotated-key-SECRET-2';
    await assert.rejects(
      apply(result.changeId),
      (error: unknown) => {
        assert.ok(error instanceof KpeError);
        assert.ok(!error.message.includes(SECRET));
        assert.ok(!error.message.includes('rotated-key-SECRET-2'));
        return true;
      },
    );
  });

  it('blocked previews cannot be applied', async () => {
    snapshot.items[0]!.context = undefined;
    snapshot.items[0]!.candidates[0]!.context = undefined;
    const result = preview();
    await assert.rejects(
      apply(result.changeId),
      (error: unknown) => error instanceof KpeError && error.code === 'CHANGE_BLOCKED',
    );
    assert.equal(client.postCalls.length, 0);
  });

  it('concurrent applies produce exactly one POST', async () => {
    const result = preview();
    client.catalogItems = [
      {
        provider: 'demo',
        model: 'demo/example-model-one',
        max_context_size: 32768,
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        capabilities: ['thinking'],
      },
    ];
    const [first, second] = await Promise.all([
      apply(result.changeId),
      apply(result.changeId),
    ]);
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'applied');
    assert.equal(client.postCalls.length, 1);
  });

  it('no-op change does not POST', async () => {
    client.config.models['demo/example-model-one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      offEffort: 'none',
      capabilities: ['thinking'],
    };
    const result = preview();
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'noop');
    assert.equal(outcome.httpPosted, false);
    assert.equal(client.postCalls.length, 0);
  });

  it('lost POST response classifies via readback as failed when nothing was written', async () => {
    const result = preview();
    client.postApplies = false;
    client.postError = new KpeError('NETWORK', '网络请求失败或被重定向');
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.httpPosted, true);
    assert.ok(outcome.warnings.some((warning) => warning.includes('不会自动重试')));
  });

  it('lost POST response classifies as applied when write actually landed', async () => {
    const result = preview();
    client.postApplies = true;
    client.postError = new KpeError('NETWORK', '网络请求失败或被重定向');
    client.catalogItems = [
      {
        provider: 'demo',
        model: 'demo/example-model-one',
        max_context_size: 32768,
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        capabilities: ['thinking'],
      },
    ];
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'applied');
  });

  it('partial readback is classified as partial', async () => {
    const first = snapshot.items[0]!;
    snapshot.items.push({
      ...first,
      id: 'example-model-two',
      candidates: first.candidates.map((candidate) => ({ ...candidate, id: 'c0b' })),
      suggestionId: 'c0b',
    });
    const result = preview(
      previewInput({ selectedModelIds: ['example-model-one', 'example-model-two'] }),
    );
    client.postApplyLimit = 1;
    client.postError = new KpeError('NETWORK', '网络请求失败或被重定向');
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'partial');
  });

  it('readback requiring model catalog evidence fails closed', async () => {
    const result = preview();
    client.catalogItems = [];
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.items[0]!.verified, false);
  });

  it('partial within one model is classified as partial, never failed', async () => {
    const result = preview();
    client.postDropKeys = ['support_efforts'];
    client.postError = new KpeError('NETWORK', '网络请求失败或被重定向');
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.items[0]!.verified, false);
    assert.equal(outcome.items[0]!.detail, '内容部分不一致');
  });

  it('wrong catalog effort after timeout is not reported as applied', async () => {
    const result = preview();
    client.postError = new KpeError('NETWORK', '网络请求失败或被重定向');
    client.catalogItems = [
      {
        provider: 'demo',
        model: 'demo/example-model-one',
        max_context_size: 32768,
        support_efforts: ['low'],
        default_effort: 'low',
        capabilities: ['thinking'],
      },
    ];
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.items[0]!.verified, false);
  });

  it('verifies effective efforts merged from base and overrides', async () => {
    client.config.models['vendor_model_one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
      supportEfforts: ['low'],
      overrides: { supportEfforts: ['low', 'high'] },
    };
    const result = preview(
      previewInput({ overrides: { 'example-model-one': { displayName: 'New Name' } } }),
    );
    assert.deepEqual(result.items[0]!.patch, { display_name: 'New Name' });
    client.catalogItems = [
      {
        provider: 'demo',
        model: 'vendor_model_one',
        max_context_size: 32768,
        support_efforts: ['low', 'high'],
      },
    ];
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'applied');
  });

  it('missing record on update readback is different, not unchanged', async () => {
    client.config.models['vendor_model_one'] = {
      provider: 'demo',
      model: 'example-model-one',
      maxContextSize: 32768,
    };
    const result = preview();
    client.postDeleteAliases = ['vendor_model_one'];
    client.postError = new KpeError('NETWORK', '网络请求失败或被重定向');
    const outcome = await apply(result.changeId);
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.items[0]!.detail, '内容部分不一致');
  });

  it('expiry is rechecked inside the apply queue and never posts', async () => {
    const first = preview();
    const second = preview(previewInput({ selectedModelIds: ['example-model-one'] }));
    client.postHook = () => {
      now += 11 * 60 * 1000;
    };
    client.catalogItems = [
      {
        provider: 'demo',
        model: 'demo/example-model-one',
        max_context_size: 32768,
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        capabilities: ['thinking'],
      },
    ];
    const [settled1, settled2] = await Promise.allSettled([
      apply(first.changeId),
      apply(second.changeId),
    ]);
    assert.equal(settled1.status, 'fulfilled');
    assert.equal(settled2.status, 'rejected');
    assert.ok(
      settled2.status === 'rejected' &&
        settled2.reason instanceof KpeError &&
        settled2.reason.code === 'CHANGE_EXPIRED',
    );
    assert.equal(client.postCalls.length, 1);
  });
});
