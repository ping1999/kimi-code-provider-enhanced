import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist', 'server.mjs');

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class StdioClient {
  private child: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (message: JsonRpcMessage) => void>();
  readonly stdoutLines: string[] = [];

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const index = this.buffer.indexOf('\n');
        if (index < 0) break;
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line === '') continue;
        this.stdoutLines.push(line);
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.id !== undefined) this.pending.get(message.id)?.(message);
      }
    });
  }

  request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const promise = new Promise<JsonRpcMessage>((resolvePromise) => {
      this.pending.set(id, resolvePromise);
      setTimeout(() => resolvePromise({ jsonrpc: '2.0', id, error: { code: -1, message: 'timeout' } }), 15_000);
    });
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    this.child.kill('SIGKILL');
  }
}

let kimiStub: Server;
let kimiBase = '';
let child: ChildProcess;
let client: StdioClient;
let home = '';
const stderrChunks: string[] = [];

before(async () => {
  if (!existsSync(bundle)) {
    const built = spawnSync('node', [join(root, 'scripts', 'build.mjs')], { cwd: root });
    assert.equal(built.status, 0, 'build must succeed for the stdio smoke test');
  }
  home = await mkdtemp(join(tmpdir(), 'kpe-mcp-home-'));
  kimiStub = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/meta') {
      res.end(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { server_id: 'stub-server-1', started_at: '2025-01-01T00:00:00Z' },
        }),
      );
      return;
    }
    if (req.url === '/api/v1/providers') {
      res.end(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            items: [
              {
                id: 'demo',
                type: 'openai',
                base_url: 'http://127.0.0.1:9/v1',
                has_api_key: true,
              },
            ],
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 40400, msg: 'not found', data: null }));
  });
  await new Promise<void>((resolveListen) => kimiStub.listen(0, '127.0.0.1', resolveListen));
  const address = kimiStub.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  kimiBase = `http://127.0.0.1:${address.port}`;
  child = spawn('node', [bundle], {
    env: {
      ...process.env,
      KIMI_CODE_HOME: home,
      KPE_KIMI_URL: kimiBase,
      KPE_KIMI_TOKEN: 'test-kimi-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr!.on('data', (chunk) => stderrChunks.push(String(chunk)));
  client = new StdioClient(child);
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'kpe-test', version: '0.0.0' },
  });
  assert.ok(init.result !== undefined, `initialize failed: ${JSON.stringify(init.error)}`);
  client.notify('notifications/initialized');
});

after(async () => {
  client.close();
  await new Promise<void>((resolveClose) => kimiStub.close(() => resolveClose()));
  await rm(home, { recursive: true, force: true });
});

describe('MCP stdio smoke', () => {
  it('lists the five expected tools', async () => {
    const response = await client.request('tools/list');
    assert.ok(response.result !== undefined, JSON.stringify(response.error));
    const tools = (response.result as { tools: { name: string; description?: string }[] }).tools;
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'apply_changes',
      'discover_models',
      'list_providers',
      'preview_changes',
      'update_model_thinking',
    ]);
    const listTool = tools.find((tool) => tool.name === 'list_providers');
    assert.equal(
      listTool?.description,
      '列出本地 Kimi 自定义供应商的脱敏摘要，不修改配置。',
    );
  });

  it('list_providers returns the redacted stub provider', async () => {
    const response = await client.request('tools/call', {
      name: 'list_providers',
      arguments: {},
    });
    assert.ok(response.result !== undefined, JSON.stringify(response.error));
    const result = response.result as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0]!.text) as {
      providers: { id: string; has_api_key: boolean; api_key?: string }[];
    };
    assert.equal(payload.providers[0]!.id, 'demo');
    assert.equal(payload.providers[0]!.has_api_key, true);
    assert.equal(payload.providers[0]!.api_key, undefined);
    assert.ok(!result.content[0]!.text.includes('test-kimi-token'));
  });

  it('rejects forbidden keys in tool arguments without pollution', async () => {
    const response = await client.request('tools/call', {
      name: 'preview_changes',
      arguments: {
        discoveryId: 'x',
        selectedModelIds: ['a'],
        overrides: { constructor: { efforts: ['low'] } },
      },
    });
    if (response.error !== undefined) {
      assert.ok(response.error.message.length > 0);
    } else {
      const result = response.result as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /VALIDATION_FAILED/);
    }
    assert.equal(({} as Record<string, unknown>)['efforts'], undefined);
    const protoResponse = await client.request('tools/call', {
      name: 'preview_changes',
      arguments: JSON.parse('{"discoveryId":"x","selectedModelIds":["a"],"__proto__":{}}'),
    });
    assert.ok(protoResponse.error !== undefined || (protoResponse.result as { isError?: boolean })?.isError === true);
    assert.equal(({} as Record<string, unknown>)['x'], undefined);
  });

  it('stdout carries only JSON-RPC frames', () => {
    for (const line of client.stdoutLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.equal(parsed['jsonrpc'], '2.0');
    }
  });
});
