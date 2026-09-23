import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2]);
const expectedKey = process.argv[3] ?? 'fake-provider-key';

const MODELS = {
  data: [
    {
      id: 'example-model-one',
      name: 'Example Model One',
      context_length: 32768,
      supported_endpoints: ['/chat/completions'],
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
      tool_call: true,
    },
    {
      id: 'example-model-two',
      name: 'Example Model Two',
      context_length: 65536,
      supported_endpoints: ['/chat/completions'],
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: [null, 'minimal', 'low', 'medium', 'high'] }],
    },
    {
      id: 'example-model-three',
      name: 'Example Model Three',
      context_length: 49152,
      supported_endpoints: ['/chat/completions'],
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
    },
    {
      id: 'text-embedding-fake',
      name: 'Fake Embedding',
      context_length: 8192,
      supported_endpoints: ['/embeddings'],
    },
  ],
};

const captured = [];
const MAX_CAPTURED = 64;
let pending = null;
const sessionState = { discoveryId: undefined, changeId: undefined };

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const PLUGIN_SERVER_RUNTIME = 'plugin-kimi-code-provider-enhanced:provider-enhanced';

function stableHash8(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.codePointAt(i);
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  return hash.toString(16).padStart(8, '0');
}

function sanitizeNamePart(part) {
  return part.replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
}

function qualifyToolName(serverName, toolName) {
  const full = `mcp__${sanitizeNamePart(serverName)}__${sanitizeNamePart(toolName)}`;
  if (full.length <= 64) return full;
  const hash = stableHash8(full);
  return `${full.slice(0, 64 - hash.length - 1)}_${hash}`;
}

function findTool(tools, toolName) {
  if (!Array.isArray(tools)) return undefined;
  const qualified = qualifyToolName(PLUGIN_SERVER_RUNTIME, toolName);
  return tools.find((tool) => {
    const name = tool?.function?.name ?? tool?.name;
    return name === qualified || name === toolName;
  });
}

function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => tool?.function?.name ?? tool?.name)
    .filter((name) => typeof name === 'string');
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' && typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = messageText(message.content).trim();
    if (text === '' || text.startsWith('<system-reminder>')) continue;
    return text;
  }
  return '';
}

function lastToolContent(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'tool') {
      const content = message.content;
      return typeof content === 'string' ? content : JSON.stringify(content);
    }
  }
  return undefined;
}

function extractField(text, key) {
  if (typeof text !== 'string') return undefined;
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
  return match?.[1];
}

function sseChunks(res, parts) {
  const id = `chatcmpl-${randomUUID()}`;
  for (const part of parts) {
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: part.delta, finish_reason: part.finish ?? null }] })}\n\n`,
    );
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function respondText(res, body, text, stream) {
  if (stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.statusCode = 200;
    sseChunks(res, [
      { delta: { role: 'assistant' } },
      { delta: { content: text }, finish: 'stop' },
    ]);
    return;
  }
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

function respondToolCall(res, body, toolName, args, stream) {
  const callId = `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const argText = JSON.stringify(args);
  const toolCall = {
    id: callId,
    type: 'function',
    function: { name: toolName, arguments: argText },
  };
  if (stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.statusCode = 200;
    sseChunks(res, [
      { delta: { role: 'assistant' } },
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: 'function',
              function: { name: toolName, arguments: '' },
            },
          ],
        },
      },
      { delta: { tool_calls: [{ index: 0, function: { arguments: argText } }] } },
      { delta: {}, finish: 'tool_calls' },
    ]);
    return;
  }
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', tool_calls: [toolCall] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

function handleChat(req, res, body) {
  const tools = body.tools;
  const names = toolNames(tools);
  const userText = lastUserText(body.messages);
  captured.push({
    model: typeof body.model === 'string' ? body.model : undefined,
    reasoning_effort:
      typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
    toolNames: names,
    userText: userText.slice(0, 64),
  });
  if (captured.length > MAX_CAPTURED) captured.shift();
  const stream = body.stream === true;
  const toolResult = lastToolContent(body.messages);
  if (toolResult !== undefined && pending !== null) {
    if (pending === 'discover') {
      sessionState.discoveryId = extractField(toolResult, 'discoveryId');
      pending = null;
      respondText(res, body, 'KPE_DISCOVERY_DONE', stream);
      return;
    }
    if (pending === 'preview') {
      sessionState.changeId = extractField(toolResult, 'changeId');
      pending = null;
      respondText(res, body, 'KPE_PREVIEW_DONE', stream);
      return;
    }
    if (pending === 'apply') {
      pending = null;
      respondText(res, body, 'KPE_APPLY_DONE', stream);
      return;
    }
    pending = null;
    respondText(res, body, 'KPE_OK', stream);
    return;
  }
  if (userText === 'KPE wire low' || userText === 'KPE wire high' || userText === 'KPE wire off') {
    respondText(res, body, 'KPE_OK', stream);
    return;
  }
  if (userText === 'KPE discover models') {
    const tool = findTool(tools, 'discover_models');
    if (tool === undefined) {
      respondText(res, body, 'KPE_NO_TOOL:discover_models', stream);
      return;
    }
    pending = 'discover';
    const name = tool?.function?.name ?? tool?.name;
    respondToolCall(res, body, name, { providerId: 'demo' }, stream);
    return;
  }
  if (userText === 'KPE preview example-model-three') {
    const tool = findTool(tools, 'preview_changes');
    if (tool === undefined || sessionState.discoveryId === undefined) {
      respondText(res, body, 'KPE_NO_TOOL:preview_changes', stream);
      return;
    }
    pending = 'preview';
    const name = tool?.function?.name ?? tool?.name;
    respondToolCall(
      res,
      body,
      name,
      {
        discoveryId: sessionState.discoveryId,
        selectedModelIds: ['example-model-three'],
      },
      stream,
    );
    return;
  }
  if (userText === 'KPE confirm change') {
    const tool = findTool(tools, 'apply_changes');
    if (tool === undefined || sessionState.changeId === undefined) {
      respondText(res, body, 'KPE_NO_TOOL:apply_changes', stream);
      return;
    }
    pending = 'apply';
    const name = tool?.function?.name ?? tool?.name;
    respondToolCall(res, body, name, { changeId: sessionState.changeId }, stream);
    return;
  }
  respondText(res, body, 'KPE_OK', stream);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const auth = req.headers['authorization'];
  if (url.pathname === '/__test/requests') {
    res.setHeader('content-type', 'application/json');
    if (auth !== `Bearer ${expectedKey}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    res.end(JSON.stringify({ requests: captured, sessionState }));
    return;
  }
  if (auth !== `Bearer ${expectedKey}`) {
    res.setHeader('content-type', 'application/json');
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (url.pathname === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(MODELS));
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    readBody(req)
      .then((text) => {
        let body = {};
        try {
          body = JSON.parse(text);
        } catch {
        }
        res.setHeader('content-type', 'application/json');
        handleChat(req, res, body);
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'bad request' }));
      });
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`fake-provider listening on ${port}\n`);
});
