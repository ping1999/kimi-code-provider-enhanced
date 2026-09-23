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
const FAKE_PROVIDER_KEY = 'fake-provider-key';

await mkdir(join(root, '.tmp'), { recursive: true });
const RUN_DIR = await mkdtemp(join(root, '.tmp', 'web-run-'));
const HOME = join(RUN_DIR, 'kimi-home');
const WORKSPACE = join(RUN_DIR, 'workspace');
const FIXTURE_PATH = join(RUN_DIR, 'fixture.json');

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

function childEnv() {
  const env = { ...process.env };
  delete env['KPE_KIMI_URL'];
  delete env['KPE_KIMI_TOKEN'];
  return env;
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

const children = [];
let staged;

async function main() {
  await mkdir(HOME, { recursive: true });
  await mkdir(WORKSPACE, { recursive: true });

  if (!existsSync(join(root, 'dist', 'server.mjs'))) {
    const built = spawnSync('node', [join(root, 'scripts', 'build.mjs')], { cwd: root });
    if (built.status !== 0) throw new Error('esbuild build failed');
  }

  const kimiPort = await freePort();
  const providerPort = await freePort();

  const fake = spawn(
    'node',
    [join(root, 'scripts', 'fake-provider.mjs'), String(providerPort), FAKE_PROVIDER_KEY],
    { detached: true, stdio: 'ignore' },
  );
  fake.unref();
  children.push(fake);

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
  children.push(kimi);

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
  const providerBase = `http://127.0.0.1:${providerPort}`;
  let meta;
  if (token !== undefined && token !== '') {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        meta = await api(kimiBase, token, 'GET', '/meta');
        if (meta.status === 200) break;
      } catch {
      }
      await sleep(500);
    }
  }
  if (meta === undefined || meta.status !== 200) {
    throw new Error('isolated kimi server did not become ready');
  }
  const serverId = meta.json?.data?.server_id;

  const providerDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      const probe = await fetch(`${providerBase}/v1/models`, {
        headers: { Authorization: `Bearer ${FAKE_PROVIDER_KEY}` },
      });
      if (probe.status === 200) break;
    } catch {
    }
    if (Date.now() > providerDeadline) throw new Error('fake provider did not become ready');
    await sleep(250);
  }

  const other = await api(kimiBase, token, 'POST', '/providers', {
    id: 'other-provider',
    type: 'openai',
    base_url: 'http://127.0.0.1:1/v1',
    api_key: 'unused-other-key',
    models: [{ model: 'other-model', max_context_size: 8192 }],
  });
  if (other.json?.code !== 0) throw new Error('failed to create other-provider');

  const demo = await api(kimiBase, token, 'POST', '/providers', {
    id: 'demo',
    type: 'openai',
    base_url: `${providerBase}/v1`,
    api_key: FAKE_PROVIDER_KEY,
    models: [
      { model: 'pre-existing', display_name: 'Pre Existing', max_context_size: 4096 },
      {
        model: 'example-model-one',
        display_name: 'Example Model One',
        max_context_size: 128000,
        capabilities: ['tool_use', 'thinking'],
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        off_effort: 'none',
      },
    ],
  });
  if (demo.json?.code !== 0) throw new Error('failed to create demo provider');

  const seeded = await api(kimiBase, token, 'POST', '/config', {
    models: {
      'demo/example-model-one': { defaultEffort: 'high', offEffort: 'none' },
    },
  });
  if (seeded.json?.code !== 0) {
    throw new Error(`failed to seed model effort defaults: ${JSON.stringify(seeded.json)}`);
  }

  staged = await mkdtemp(join(tmpdir(), 'kpe-plugin-src-'));
  await cp(join(root, 'kimi.plugin.json'), join(staged, 'kimi.plugin.json'));
  await cp(join(root, 'skills'), join(staged, 'skills'), { recursive: true });
  await cp(join(root, 'dist'), join(staged, 'dist'), { recursive: true });
  const install = await api(kimiBase, token, 'POST', '/plugins', { source: staged });
  if (install.json?.code !== 0) throw new Error(`plugin install failed: ${install.json?.msg}`);

  const fixture = {
    createdBy: 'kpe-web-fixture',
    home: HOME,
    workspace: WORKSPACE,
    kimiBase,
    providerBase,
    serverId,
    kimiPid: kimi.pid,
    fakeProviderPid: fake.pid,
  };
  await writeFile(FIXTURE_PATH, JSON.stringify(fixture, null, 2));

  const env = {
    ...process.env,
    KPE_WEB_BASE: kimiBase,
    KPE_PROVIDER_BASE: providerBase,
    KPE_PROVIDER_KEY: FAKE_PROVIDER_KEY,
    KPE_KIMI_HOME: HOME,
    KPE_WORKSPACE: WORKSPACE,
    KPE_FIXTURE_MARKER: FIXTURE_PATH,
  };
  console.log(`web fixture ready kimi=${kimiBase} provider=${providerBase} home=${HOME}`);
  const run = spawnSync('npx', ['playwright', 'test', '-c', 'playwright.config.ts'], {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (run.status !== 0) process.exitCode = run.status ?? 1;
}

try {
  await main();
} finally {
  if (staged !== undefined) await rm(staged, { recursive: true, force: true }).catch(() => undefined);
  if (!KEEP_RUNNING) {
    for (const child of children) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
      }
    }
    await rm(RUN_DIR, { recursive: true, force: true }).catch(() => undefined);
  } else {
    console.log(`web fixture kept running at ${RUN_DIR}`);
  }
}
