import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE = process.env['KPE_WEB_BASE'] ?? 'http://127.0.0.1:1688';
const PROVIDER_BASE = process.env['KPE_PROVIDER_BASE'] ?? 'http://127.0.0.1:1689';
const PROVIDER_KEY = process.env['KPE_PROVIDER_KEY'] ?? 'fake-provider-key';
const HOME = process.env['KPE_KIMI_HOME'] ?? resolve(process.cwd(), '.tmp', 'kimi-home');
const WORKSPACE = process.env['KPE_WORKSPACE'] ?? resolve(process.cwd(), '.tmp', 'workspace');
const TOKEN = readFile(`${HOME}/server.token`, 'utf8').then((v) => v.trim());
const RUN_STAMP = `kpe-web-${Date.now()}`;

let fixtureVerified: Promise<void> | undefined;
function ensureFixture(): Promise<void> {
  fixtureVerified ??= (async () => {
    const markerPath = process.env['KPE_FIXTURE_MARKER'];
    if (markerPath === undefined) {
      throw new Error(
        'refusing to run against unmanaged endpoints: KPE_FIXTURE_MARKER is not set',
      );
    }
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    const expected = {
      createdBy: 'kpe-web-fixture',
      home: resolve(HOME),
      workspace: resolve(WORKSPACE),
      kimiBase: BASE,
      providerBase: PROVIDER_BASE,
    };
    if (
      marker['createdBy'] !== expected.createdBy ||
      marker['home'] !== expected.home ||
      marker['workspace'] !== expected.workspace ||
      marker['kimiBase'] !== expected.kimiBase ||
      marker['providerBase'] !== expected.providerBase ||
      typeof marker['serverId'] !== 'string'
    ) {
      throw new Error(
        `fixture marker mismatch for ${markerPath}; refusing API writes against unmanaged endpoints`,
      );
    }
    const meta = await api('GET', '/meta');
    const liveId = (meta['data'] as Record<string, unknown> | undefined)?.['server_id'];
    if (liveId !== marker['serverId']) {
      throw new Error(
        `fixture server id ${String(marker['serverId'])} does not match live server ${String(liveId)}`,
      );
    }
  })();
  return fixtureVerified;
}

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (method !== 'GET') await ensureFixture();
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { httpStatus: response.status, raw: text };
  }
}

async function getConfig(): Promise<Record<string, unknown>> {
  const json = await api('GET', '/config');
  return (json['data'] ?? {}) as Record<string, unknown>;
}

async function capturedRequests(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${PROVIDER_BASE}/__test/requests`, {
    headers: { Authorization: `Bearer ${PROVIDER_KEY}` },
  });
  const json = (await response.json()) as { requests: Array<Record<string, unknown>> };
  return json.requests ?? [];
}

async function waitForRequest(
  predicate: (item: Record<string, unknown>) => boolean,
  baseline: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const items = await capturedRequests();
    for (const item of items.slice(baseline)) {
      if (predicate(item)) return item;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  const items = await capturedRequests();
  throw new Error(`timed out waiting for provider request; captured=${JSON.stringify(items)}`);
}

async function dismissWelcomeOnce(page: Page): Promise<boolean> {
  const skip = page
    .getByRole('button', { name: /skip|跳过/i })
    .first();
  if (!(await skip.isVisible().catch(() => false))) return false;
  await skip.click();
  await expect(skip).toBeHidden({ timeout: 10_000 });
  return true;
}

async function dismissWelcome(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (await dismissWelcomeOnce(page)) return;
    await page.waitForTimeout(500);
  }
}

async function openApp(page: Page, sessionId: string): Promise<void> {
  await page.goto(`${BASE}/sessions/${sessionId}#token=${await TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
}

async function composer(page: Page) {
  const input = page.locator('.ProseMirror[contenteditable="true"]:visible').last();
  await expect(input).toBeVisible({ timeout: 30_000 });
  return input;
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const input = await composer(page);
  await input.click();
  await input.fill(text);
  await expect(input).toHaveText(text, { timeout: 10_000 });
  const send = page.getByRole('button', { name: /^send|^发送/i }).first();
  await expect(send).toBeEnabled({ timeout: 10_000 });
  await send.click();
  await expect(input).toHaveText(/^\s*$/, { timeout: 15_000 });
}

function pickerButton(page: Page) {
  return page
    .locator('button')
    .filter({ hasText: /Example Model One|示例模型一|·/i })
    .last();
}

function effortTab(page: Page, effort: 'low' | 'high' | 'off') {
  const labels = { low: '低', high: '高', off: '关闭' } as const;
  return page.getByRole('tab', {
    name: new RegExp(`^(${effort}|${labels[effort]})$`, 'i'),
  });
}

async function thinkingLevel(sessionId: string): Promise<string | undefined> {
  const json = await api('GET', `/sessions/${sessionId}/status`);
  const data = json['data'] as Record<string, unknown> | undefined;
  return typeof data?.['thinking_level'] === 'string'
    ? (data['thinking_level'] as string)
    : undefined;
}

async function selectModelOne(page: Page): Promise<void> {
  const button = pickerButton(page);
  await expect(button).toBeVisible({ timeout: 30_000 });
  const label = (await button.innerText()) ?? '';
  if (/example.?model.?one|示例/i.test(label)) return;
  await dismissWelcomeOnce(page);
  await button.click({ force: true });
  const item = page
    .getByText(/Example Model One|示例模型一/i)
    .last();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click({ force: true });
  await expect(pickerButton(page)).toContainText(/Example Model One|示例模型一/i, {
    timeout: 15_000,
  });
}

async function chooseEffort(
  page: Page,
  sessionId: string,
  effort: 'low' | 'high' | 'off',
): Promise<void> {
  if ((await thinkingLevel(sessionId)) === effort) return;
  const button = pickerButton(page);
  const tab = effortTab(page, effort);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await dismissWelcomeOnce(page);
    if ((await tab.count()) === 0) {
      await button.click({ force: true });
      await page.waitForTimeout(400);
      continue;
    }
    await tab.first().click({ force: true });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if ((await thinkingLevel(sessionId)) === effort) return;
      await page.waitForTimeout(400);
    }
  }
  throw new Error(`failed to select effort ${effort}`);
}

async function waitForAssistantText(
  page: Page,
  pattern: RegExp,
  timeoutMs = 90_000,
): Promise<void> {
  const approve = page
    .getByRole('button', { name: /approve for session|会话内允许|始终允许/i })
    .first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await approve.isVisible().catch(() => false)) {
      await approve.click({ force: true });
      await page.waitForTimeout(500);
      continue;
    }
    const text = await page.locator('body').innerText();
    const failures = text.match(/KPE_NO_TOOL:[a-z_]+/g);
    if (failures !== null && failures.length > 0) {
      throw new Error(`provider reported missing tool(s): ${failures.join(', ')}`);
    }
    if (pattern.test(text)) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`timed out waiting for ${pattern}`);
}

async function prepareWorkspaceAndSession() {
  const created = await api('POST', '/workspaces', { root: WORKSPACE, name: 'kpe-e2e' });
  const wsData = (created['data'] ?? created) as Record<string, unknown>;
  const wsId = (wsData['id'] ?? wsData['workspace_id']) as string;
  expect(
    typeof wsId === 'string' && wsId.length > 0,
    `workspace creation failed: ${JSON.stringify(created)}`,
  ).toBe(true);
  await api('POST', `/workspaces/${wsId}/trust`, {});
  const session = await api('POST', '/sessions', {
    title: RUN_STAMP,
    workspace_id: wsId,
    agent_config: { model: 'demo/example-model-one', permission_mode: 'manual' },
  });
  const sessionData = (session['data'] ?? {}) as Record<string, unknown>;
  const sessionId = sessionData['id'] as string;
  expect(
    typeof sessionId === 'string' && sessionId.length > 0,
    `session creation failed: ${JSON.stringify(session)}`,
  ).toBe(true);
  const profile = await api('POST', `/sessions/${sessionId}/profile`, {
    agent_config: { model: 'demo/example-model-one', permission_mode: 'manual' },
  });
  expect(
    profile['code'] === 0,
    `profile update failed: ${JSON.stringify(profile)}`,
  ).toBe(true);
  const skills = await api('GET', `/sessions/${sessionId}/skills`);
  const skillsText = JSON.stringify(skills['data'] ?? skills);
  expect(
    skillsText.includes('provider-enhanced'),
    `provider-enhanced skill must be advertised, got ${skillsText}`,
  ).toBe(true);
  return { wsId, sessionId };
}

async function sessionToolOutputs(sessionId: string): Promise<string[]> {
  const page = await api('GET', `/sessions/${sessionId}/messages?page_size=100`);
  const items = ((page['data'] as Record<string, unknown> | undefined)?.['items'] ?? []) as Array<
    Record<string, unknown>
  >;
  const outputs: string[] = [];
  for (const message of items) {
    for (const part of (message['content'] ?? []) as Array<Record<string, unknown>>) {
      if (part['type'] !== 'tool_result') continue;
      const output = part['output'];
      if (typeof output === 'string') {
        outputs.push(output);
      } else if (Array.isArray(output)) {
        outputs.push(
          output
            .map((entry) =>
              typeof entry === 'object' && entry !== null
                ? String((entry as Record<string, unknown>)['text'] ?? '')
                : String(entry),
            )
            .join(''),
        );
      }
    }
  }
  return outputs;
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  await ensureFixture();
});

test('model picker wires thinking effort to provider request', async ({ page }) => {
  const { sessionId } = await prepareWorkspaceAndSession();
  const baseline = (await capturedRequests()).length;
  await openApp(page, sessionId);
  await selectModelOne(page);

  await pickerButton(page).click({ force: true });
  await expect(effortTab(page, 'low').first()).toBeVisible({ timeout: 15_000 });
  await expect(effortTab(page, 'high').first()).toBeVisible();
  await expect(effortTab(page, 'off').first()).toBeVisible();
  await page.keyboard.press('Escape');

  for (const effort of ['low', 'high', 'off'] as const) {
    await chooseEffort(page, sessionId, effort);
    await sendMessage(page, `KPE wire ${effort}`);
    await waitForAssistantText(page, /KPE_OK/);
    const expected = effort === 'off' ? 'none' : effort;
    const captured = await waitForRequest(
      (item) =>
        item['model'] === 'example-model-one' &&
        item['userText'] === `KPE wire ${effort}` &&
        item['reasoning_effort'] === expected,
      baseline,
    );
    expect(captured['reasoning_effort']).toBe(expected);
  }
  await page.screenshot({ path: 'test-results/model-picker.png', fullPage: true });
});

test('provider settings persist across save and reload', async ({ page }) => {
  const { sessionId } = await prepareWorkspaceAndSession();
  const before = await getConfig();
  await openApp(page, sessionId);
  const settings = page
    .getByRole('button', { name: /settings|设置/i })
      .first();
  await expect(settings).toBeVisible({ timeout: 30_000 });
  await settings.click({ force: true });

  const providersTab = page
    .getByRole('tab', { name: /model providers|模型供应商|供应商/i })
    .first();
  await expect(providersTab).toBeVisible({ timeout: 30_000 });
  await providersTab.click({ force: true });
  const providerField = page.getByText(/^demo$|demo · |demo\s/i).first();
  await expect(providerField).toBeVisible({ timeout: 30_000 });
  await providerField.click({ force: true });
  const save = page.getByRole('button', { name: /save|保存/i }).first();
  await expect(save).toBeVisible({ timeout: 30_000 });
  await save.click({ force: true });
  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.waitForTimeout(2000);

  const after = await getConfig();
  expect(after['providers']).toEqual(before['providers']);
  expect(after['models']).toEqual(before['models']);
  expect(after['default_model']).toBe(before['default_model']);
  expect(after['default_provider']).toBe(before['default_provider']);
});

test('native plugin tools discover, preview and apply a model', async ({ page }) => {
  test.setTimeout(300_000);
  const { sessionId } = await prepareWorkspaceAndSession();
  const configBefore = await getConfig();
  const modelsBefore = (configBefore['models'] ?? {}) as Record<string, unknown>;
  expect(modelsBefore['demo/example-model-three']).toBeUndefined();
  await openApp(page, sessionId);

  await sendMessage(page, 'KPE discover models');
  await waitForAssistantText(page, /KPE_DISCOVERY_DONE/, 120_000);

  await sendMessage(page, 'KPE preview example-model-three');
  await waitForAssistantText(page, /KPE_PREVIEW_DONE/, 120_000);

  const configAfterPreview = await getConfig();
  expect(
    ((configAfterPreview['models'] ?? {}) as Record<string, unknown>)[
      'demo/example-model-three'
    ],
  ).toBeUndefined();

  await sendMessage(page, 'KPE confirm change');
  await waitForAssistantText(page, /KPE_APPLY_DONE/, 120_000);
  await page.screenshot({ path: 'test-results/tool-flow.png', fullPage: true });

  const outputs = await sessionToolOutputs(sessionId);
  const applyOutputs = outputs.filter((output) => output.includes('"status"'));
  const applied = applyOutputs.find((output) => {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      return parsed['status'] === 'applied';
    } catch {
      return false;
    }
  });
  expect(
    applied,
    `apply_changes tool result must report status applied; outputs=${JSON.stringify(outputs)}`,
  ).toBeDefined();

  const configAfter = await getConfig();
  const modelsAfter = (configAfter['models'] ?? {}) as Record<string, unknown>;
  const added = modelsAfter['demo/example-model-three'] as Record<string, unknown> | undefined;
  expect(added, 'example-model-three must exist in /models config after apply').toBeDefined();
  expect(added?.['model']).toBe('example-model-three');
  expect(configAfter['default_model']).toBe(configBefore['default_model']);
  expect(configAfter['providers']).toEqual(configBefore['providers']);
  const otherBefore = modelsBefore['other-provider/other-model'];
  expect(modelsAfter['other-provider/other-model']).toEqual(otherBefore);
});
