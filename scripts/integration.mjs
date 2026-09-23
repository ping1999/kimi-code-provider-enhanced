import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIMI_EXE =
  process.env.KPE_KIMI_EXE ??
  join(homedir(), '.kimi-code', 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
const KEEP_RUNNING = process.argv.includes('--keep-running');
await mkdir(join(root, '.tmp'), { recursive: true });
const RUN_DIR = await mkdtemp(join(root, '.tmp', 'run-'));
const HOME = join(RUN_DIR, 'kimi-home');
const WORKSPACE = join(RUN_DIR, 'workspace');
const STATE_PATH = join(root, '.tmp', 'integration-state.json');
const FAKE_PROVIDER_KEY = 'fake-provider-key';

function childEnv() {
  const env = { ...process.env };
  delete env['KPE_KIMI_URL'];
  delete env['KPE_KIMI_TOKEN'];
  return env;
}

const results = { steps: [], failures: [] };
function step(name, ok, detail) {
  results.steps.push({ name, ok, detail });
  if (!ok) results.failures.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
    server.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function api(base, token, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

async function waitForServer(base, token, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await api(base, token, 'GET', '/meta');
      if (res.status === 200 || res.status === 401) return true;
    } catch {
    }
    await sleep(500);
  }
  return false;
}

class McpClient {
  constructor(child) {
    this.child = child;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutLines = [];
    this.stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      for (;;) {
        const index = this.buffer.indexOf('\n');
        if (index < 0) break;
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line === '') continue;
        this.stdoutLines.push(line);
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && this.pending.has(message.id)) {
            this.pending.get(message.id)(message);
            this.pending.delete(message.id);
          }
        } catch {
        }
      }
    });
    child.stderr.on('data', (chunk) => this.stderr.push(String(chunk)));
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolveRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolveRequest({ jsonrpc: '2.0', id, error: { code: -1, message: 'timeout' } });
      }, 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolveRequest(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args }).then((message) => {
      if (message.error !== undefined) return { error: message.error };
      const result = message.result;
      if (result === undefined) return { error: { message: 'no result' } };
      const text = result.content?.[0]?.text ?? '';
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
      return { isError: result.isError === true, payload, structured: result.structuredContent };
    });
  }
}

async function main() {
  await mkdir(HOME, { recursive: true });
  await mkdir(WORKSPACE, { recursive: true });

  if (!existsSync(join(root, 'dist', 'server.mjs'))) {
    const built = spawnSync('node', [join(root, 'scripts', 'build.mjs')], { cwd: root });
    if (built.status !== 0) {
      step('build', false, 'esbuild failed');
      throw new Error('esbuild build failed');
    }
  }
  step('build', true);

  const kimiPort = await freePort();
  const providerPort = await freePort();

  const fake = spawn('node', [join(root, 'scripts', 'fake-provider.mjs'), String(providerPort), FAKE_PROVIDER_KEY], {
    detached: true,
    stdio: 'ignore',
  });
  fake.unref();
  fakeProcess = fake;
  await sleep(400);

  const kimi = spawn(
    KIMI_EXE,
    ['web', '--port', String(kimiPort), '--no-open', '--log-level', 'silent'],
    {
      cwd: WORKSPACE,
      detached: true,
      stdio: 'ignore',
      env: { ...childEnv(), KIMI_CODE_HOME: HOME },
    },
  );
  kimi.unref();
  kimiProcess = kimi;

  const tokenPath = join(HOME, 'server.token');
  let token;
  for (let i = 0; i < 120; i += 1) {
    try {
      token = (await readFile(tokenPath, 'utf8')).trim();
      if (token !== '') break;
    } catch {
    }
    await sleep(500);
  }
  const kimiBase = `http://127.0.0.1:${kimiPort}`;
  const ready = token !== undefined && token !== '' && (await waitForServer(kimiBase, token));
  step('kimi-started', ready, { port: kimiPort, pid: kimi.pid });
  if (!ready) throw new Error('kimi web server did not become ready');

  const otherProvider = await api(kimiBase, token, 'POST', '/providers', {
    id: 'other-provider',
    type: 'openai',
    base_url: 'http://127.0.0.1:1/v1',
    api_key: 'unused-other-key',
    models: [{ model: 'other-model', max_context_size: 8192 }],
  });
  step('other-provider-created', otherProvider.status === 201 || otherProvider.json?.code === 0, otherProvider.json?.code);

  const demo = await api(kimiBase, token, 'POST', '/providers', {
    id: 'demo',
    type: 'openai',
    base_url: `http://127.0.0.1:${providerPort}/v1`,
    api_key: FAKE_PROVIDER_KEY,
    models: [{ model: 'pre-existing', max_context_size: 4096 }],
  });
  step('demo-provider-created', demo.status === 201 || demo.json?.code === 0, demo.json?.code);

  const configBefore = await api(kimiBase, token, 'GET', '/config');
  const defaultModelBefore = configBefore.json?.data?.default_model;
  step('config-read', configBefore.status === 200, { default_model: defaultModelBefore });

  staged = await mkdtemp(join(tmpdir(), 'kpe-plugin-src-'));
  await cp(join(root, 'kimi.plugin.json'), join(staged, 'kimi.plugin.json'));
  await cp(join(root, 'skills'), join(staged, 'skills'), { recursive: true });
  await cp(join(root, 'dist'), join(staged, 'dist'), { recursive: true });
  const install = await api(kimiBase, token, 'POST', '/plugins', { source: staged });
  step('plugin-installed', install.json?.code === 0, install.json?.data?.name ?? install.json?.msg);

  const plugins = await api(kimiBase, token, 'GET', '/plugins');
  const pluginList = plugins.json?.data?.plugins ?? [];
  const ours = Array.isArray(pluginList)
    ? pluginList.find((p) => p.id === 'kimi-code-provider-enhanced' || p.name === 'kimi-code-provider-enhanced')
    : undefined;
  step('plugin-listed', ours !== undefined && ours.state === 'ok', {
    count: pluginList.length,
    skillCount: ours?.skillCount,
    mcpServerCount: ours?.mcpServerCount,
    enabledMcpServerCount: ours?.enabledMcpServerCount,
    state: ours?.state,
  });

  mcpChild = spawn('node', [join(root, 'dist', 'server.mjs')], {
    env: { ...childEnv(), KIMI_CODE_HOME: HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const mcp = new McpClient(mcpChild);
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'kpe-integration', version: '0.0.0' },
  });
  step('mcp-initialize', init.result !== undefined);
  mcp.notify('notifications/initialized');

  const tools = await mcp.request('tools/list');
  step('mcp-tools', tools.result?.tools?.length === 5, tools.result?.tools?.map((t) => t.name));

  const listed = await mcp.callTool('list_providers', {});
  step('list-providers', listed.isError === false && Array.isArray(listed.payload?.providers), {
    count: listed.payload?.providers?.length,
  });

  const discovery = await mcp.callTool('discover_models', { providerId: 'demo' });
  const items = discovery.payload?.items ?? [];
  step('discover-models', discovery.isError === false && items.length >= 2, {
    count: items.length,
    ids: items.map((item) => item.id),
    warnings: discovery.payload?.warnings,
  });
  const discoveryId = discovery.payload?.discoveryId;

  const page2 = await mcp.callTool('discover_models', {
    providerId: 'demo',
    discoveryId,
    pageSize: 2,
  });
  step(
    'discover-pagination',
    page2.isError === false && page2.payload?.items?.length === 2 && page2.payload?.nextCursor === 2,
    { nextCursor: page2.payload?.nextCursor },
  );

  const previewOne = await mcp.callTool('preview_changes', {
    discoveryId,
    selectedModelIds: ['example-model-one'],
  });
  const oneItem = previewOne.payload?.items?.[0];
  step('preview-one', previewOne.isError === false && previewOne.payload?.blocked === false, {
    alias: oneItem?.alias,
    patch: oneItem?.patch,
  });

  const applied = await mcp.callTool('apply_changes', { changeId: previewOne.payload?.changeId });
  step('apply-one', applied.isError === false && applied.payload?.status === 'applied', {
    status: applied.payload?.status,
    items: applied.payload?.items,
  });

  const configAfter = await api(kimiBase, token, 'GET', '/config');
  const added = configAfter.json?.data?.models?.['demo/example-model-one'];
  step(
    'readback-config',
    added !== undefined &&
      added.provider === 'demo' &&
      added.model === 'example-model-one' &&
      Array.isArray(added.supportEfforts ?? added.support_efforts) &&
      (added.supportEfforts ?? added.support_efforts).includes('low'),
    added,
  );
  step(
    'defaults-preserved',
    configAfter.json?.data?.default_model === defaultModelBefore &&
      configAfter.json?.data?.models?.['other-provider/other-model'] !== undefined,
    { default_model: configAfter.json?.data?.default_model },
  );

  const models = await api(kimiBase, token, 'GET', '/models');
  const catalogItem = models.json?.data?.items?.find(
    (entry) => entry.provider === 'demo' && entry.model === 'demo/example-model-one',
  );
  step('readback-models-catalog', catalogItem !== undefined, {
    support_efforts: catalogItem?.support_efforts,
    default_effort: catalogItem?.default_effort,
  });

  const blockedPreview = await mcp.callTool('preview_changes', {
    discoveryId,
    selectedModelIds: ['example-model-two'],
  });
  step(
    'null-effort-blocked',
    blockedPreview.isError === false && blockedPreview.payload?.blocked === true,
    { blocked: blockedPreview.payload?.items?.[0]?.blocked },
  );

  const stdoutOk = mcp.stdoutLines.every((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed.jsonrpc === '2.0';
    } catch {
      return false;
    }
  });
  step('stdout-jsonrpc-only', stdoutOk && mcp.stdoutLines.length > 0);

  const stderrText = mcp.stderr.join('');
  step('no-secret-in-stderr', !stderrText.includes(FAKE_PROVIDER_KEY) && !stderrText.includes(token));

  mcpChild.kill('SIGKILL');

  const state = {
    kimiPort,
    providerPort,
    kimiPid: kimi.pid,
    fakeProviderPid: fake.pid,
    home: HOME,
    workspace: WORKSPACE,
    keepRunning: KEEP_RUNNING,
  };
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`SUMMARY ${JSON.stringify({ ...state, failures: results.failures, steps: results.steps.length })}`);
  if (results.failures.length > 0) process.exitCode = 1;
}

let kimiProcess;
let fakeProcess;
let mcpChild;
let staged;

async function run() {
  try {
    await main();
  } finally {
    if (staged !== undefined) {
      await rm(staged, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!KEEP_RUNNING) {
      if (mcpChild !== undefined) {
        try { mcpChild.kill('SIGKILL'); } catch {}
      }
      if (kimiProcess !== undefined) {
        try { process.kill(kimiProcess.pid, 'SIGKILL'); } catch {}
      }
      if (fakeProcess !== undefined) {
        try { process.kill(fakeProcess.pid, 'SIGKILL'); } catch {}
      }
      await rm(RUN_DIR, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

run().catch((error) => {
  console.error('integration failed', error);
  process.exitCode = 1;
});
