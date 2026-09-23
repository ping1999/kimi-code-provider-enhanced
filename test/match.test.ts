import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCandidates,
  idMatches,
  normalizeEndpoint,
  normalizeReasoning,
  type CatalogRow,
  type ReasoningControl,
} from '../src/match.ts';

function control(partial: Partial<ReasoningControl> = {}): ReasoningControl {
  return {
    kind: 'effort',
    efforts: ['low', 'high'],
    hasToggle: false,
    hasBudget: false,
    hasNull: false,
    alwaysThinking: false,
    ...partial,
  };
}

describe('normalizeReasoning', () => {
  it('undefined options + reasoning true is unknown', () => {
    const out = normalizeReasoning(undefined, true);
    assert.equal(out.kind, 'unknown');
    assert.deepEqual(out.efforts, []);
    assert.equal(out.alwaysThinking, false);
  });

  it('empty options + reasoning true is none with alwaysThinking', () => {
    const out = normalizeReasoning([], true);
    assert.equal(out.kind, 'none');
    assert.equal(out.alwaysThinking, true);
  });

  it('toggle-only yields no efforts', () => {
    const out = normalizeReasoning([{ type: 'toggle' }]);
    assert.equal(out.kind, 'toggle');
    assert.equal(out.hasToggle, true);
    assert.deepEqual(out.efforts, []);
  });

  it('budget-only yields no invented efforts', () => {
    const out = normalizeReasoning([{ type: 'budget_tokens' }]);
    assert.equal(out.kind, 'budget');
    assert.equal(out.hasBudget, true);
    assert.deepEqual(out.efforts, []);
  });

  it('values [null, none, low, low, high] give hasNull, off none, low/high', () => {
    const out = normalizeReasoning([
      { type: 'effort', values: [null, 'none', 'low', 'low', 'high'] },
    ]);
    assert.equal(out.kind, 'effort');
    assert.equal(out.hasNull, true);
    assert.equal(out.offEffort, 'none');
    assert.deepEqual(out.efforts, ['low', 'high']);
  });

  it('null alone is not treated as off none', () => {
    const out = normalizeReasoning([{ type: 'effort', values: [null, 'low'] }]);
    assert.equal(out.hasNull, true);
    assert.equal(out.offEffort, undefined);
    assert.deepEqual(out.efforts, ['low']);
  });

  it('effort list without off and without toggle/null means alwaysThinking', () => {
    const out = normalizeReasoning([{ type: 'effort', values: ['low', 'high'] }]);
    assert.equal(out.alwaysThinking, true);
  });

  it('effort list with none is not alwaysThinking', () => {
    const out = normalizeReasoning([{ type: 'effort', values: ['none', 'low'] }]);
    assert.equal(out.alwaysThinking, false);
    assert.equal(out.offEffort, 'none');
  });

  it('reasoning false without options is none', () => {
    const out = normalizeReasoning(undefined, false);
    assert.equal(out.kind, 'none');
  });
});

describe('idMatches', () => {
  it('vendor-prefixed id matches bare leaf', () => {
    assert.equal(idMatches('moonshotai/Kimi-K3', 'kimi-k3'), true);
  });

  it('retained suffixes do not match', () => {
    assert.equal(idMatches('kimi-k3-vision', 'kimi-k3'), false);
  });

  it('unknown vendor prefix does not match bare leaf', () => {
    assert.equal(idMatches('foo/Kimi-K3', 'kimi-k3'), false);
  });

  it('conflicting vendors do not match', () => {
    assert.equal(idMatches('openai/gpt-5', 'anthropic/gpt-5'), false);
  });

  it('moonshot alias maps to moonshotai vendor', () => {
    assert.equal(idMatches('moonshot/kimi-k3', 'moonshotai/kimi-k3'), true);
  });
});

describe('buildCandidates', () => {
  const endpoint = 'https://api.example.com/v1';

  it('conflicting same-model candidates are never auto-selected', () => {
    const rows: CatalogRow[] = [
      {
        provider: 'moonshotai',
        model: 'Kimi-K3',
        api: endpoint,
        wire: 'openai',
        control: control({ efforts: ['low', 'high', 'max'] }),
        context: 131072,
      },
      {
        provider: 'other-vendor',
        model: 'Kimi-K3',
        api: 'https://other.example.com/v1',
        wire: 'openai',
        control: control({ efforts: ['max'] }),
        context: 64000,
      },
    ];
    const built = buildCandidates({
      modelId: 'kimi-k3',
      providerEndpoint: 'https://third.example.com/v1',
      providerWire: 'openai',
      catalogRows: rows,
    });
    assert.equal(built.candidates.length, 2);
    assert.equal(built.suggestion, undefined);
    assert.equal(built.conflict, true);
    assert.ok(built.candidates.every((candidate) => candidate.tier === 'suggested'));
  });

  it('exact endpoint match selects the exact source', () => {
    const rows: CatalogRow[] = [
      {
        provider: 'other-vendor',
        model: 'kimi-k3',
        api: 'https://other.example.com/v1',
        wire: 'openai',
        control: control({ efforts: ['max'] }),
      },
      {
        provider: 'moonshotai',
        model: 'kimi-k3',
        api: 'https://api.example.com/v1/',
        wire: 'openai',
        control: control({ efforts: ['low', 'high'] }),
      },
    ];
    const built = buildCandidates({
      modelId: 'kimi-k3',
      providerEndpoint: endpoint,
      providerWire: 'openai',
      catalogRows: rows,
    });
    assert.equal(built.conflict, false);
    assert.equal(built.suggestion?.tier, 'endpoint');
    assert.deepEqual(built.suggestion?.control.efforts, ['low', 'high']);
  });

  it('casefold match works and kept suffix stays distinct', () => {
    const rows: CatalogRow[] = [
      {
        provider: 'moonshotai',
        model: 'Kimi-K3-Vision',
        api: endpoint,
        wire: 'openai',
        control: control(),
      },
    ];
    const built = buildCandidates({
      modelId: 'kimi-k3',
      catalogRows: rows,
    });
    assert.equal(built.candidates.length, 0);
    const cased = buildCandidates({
      modelId: 'Kimi-K3-Vision',
      catalogRows: rows,
    });
    assert.equal(cased.suggestion?.match, 'exact');
  });

  it('same controls across rows group into one suggestion with all sources', () => {
    const shared = control({ efforts: ['low', 'high'] });
    const rows: CatalogRow[] = [
      { provider: 'a', model: 'm1', api: 'https://a.example.com', wire: 'openai', control: shared },
      { provider: 'b', model: 'm1', api: 'https://b.example.com', wire: 'openai', control: shared },
    ];
    const built = buildCandidates({ modelId: 'm1', catalogRows: rows });
    assert.equal(built.candidates.length, 1);
    assert.equal(built.suggestion?.sources.length, 2);
  });

  it('provider-declared control outranks catalog suggestions', () => {
    const rows: CatalogRow[] = [
      {
        provider: 'moonshotai',
        model: 'kimi-k3',
        api: endpoint,
        wire: 'openai',
        control: control({ efforts: ['low'] }),
      },
    ];
    const built = buildCandidates({
      modelId: 'kimi-k3',
      providerEndpoint: endpoint,
      providerWire: 'openai',
      providerControl: control({ kind: 'none', efforts: [] }),
      catalogRows: rows,
    });
    assert.equal(built.suggestion?.tier, 'provider');
    assert.equal(built.suggestion?.control.kind, 'none');
  });

  it('unknown provider control does not outrank informative catalog rows', () => {
    const rows: CatalogRow[] = [
      {
        provider: 'moonshotai',
        model: 'kimi-k3',
        api: 'https://other.example.com/v1',
        wire: 'openai',
        control: control({ efforts: ['low', 'high'] }),
      },
    ];
    const built = buildCandidates({
      modelId: 'kimi-k3',
      providerEndpoint: endpoint,
      providerWire: 'openai',
      providerControl: control({ kind: 'unknown', efforts: [] }),
      catalogRows: rows,
    });
    assert.equal(built.candidates.length, 1);
    assert.equal(built.suggestion?.tier, 'suggested');
    assert.deepEqual(built.suggestion?.control.efforts, ['low', 'high']);
  });

  it('same control rows with conflicting contexts warn and keep all values', () => {
    const shared = control({ efforts: ['low', 'high'] });
    const rows: CatalogRow[] = [
      {
        provider: 'a',
        model: 'm1',
        api: 'https://a.example.com',
        wire: 'openai',
        control: shared,
        context: 128000,
      },
      {
        provider: 'b',
        model: 'm1',
        api: 'https://b.example.com',
        wire: 'openai',
        control: shared,
        context: 64000,
      },
    ];
    const built = buildCandidates({ modelId: 'm1', catalogRows: rows });
    assert.equal(built.candidates.length, 1);
    assert.equal(built.candidates[0]!.context, undefined);
    assert.deepEqual(built.candidates[0]!.contexts, [128000, 64000]);
    assert.ok(built.warnings.some((warning) => warning.includes('上下文')));
  });
});

describe('normalizeEndpoint', () => {
  it('strips only trailing slashes, keeping path intact', () => {
    assert.equal(
      normalizeEndpoint('https://API.example.com/v1/'),
      'https://api.example.com/v1',
    );
    assert.equal(
      normalizeEndpoint('https://api.example.com/openai/v1'),
      'https://api.example.com/openai/v1',
    );
  });

  it('keeps paths case-sensitive', () => {
    assert.notEqual(
      normalizeEndpoint('https://api.example.com/TenantA/v1'),
      normalizeEndpoint('https://api.example.com/tenanta/v1'),
    );
  });

  it('rejects non-http schemes, credentials, query and fragment', () => {
    assert.equal(normalizeEndpoint('ftp://api.example.com'), undefined);
    assert.equal(normalizeEndpoint('https://user:pass@api.example.com/v1'), undefined);
    assert.equal(normalizeEndpoint('https://api.example.com/v1?key=x'), undefined);
    assert.equal(normalizeEndpoint('https://api.example.com/v1#frag'), undefined);
  });
});
