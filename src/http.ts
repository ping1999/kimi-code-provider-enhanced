import { KpeError } from './errors.ts';

export interface FetchJsonOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly jsonOptional?: boolean;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<{
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface FetchJsonResult {
  status: number;
  json: unknown;
}

async function readLimited(
  response: { body: ReadableStream<Uint8Array> | null; text(): Promise<string> },
  maxBytes: number,
): Promise<string> {
  try {
    if (response.body === null || response.body === undefined) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new KpeError('RESPONSE_TOO_LARGE', '响应超出大小限制');
      }
      return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new KpeError('RESPONSE_TOO_LARGE', '响应超出大小限制');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  } catch (error) {
    if (error instanceof KpeError) throw error;
    throw new KpeError('NETWORK', '网络请求失败或被重定向');
  }
}

export async function fetchJson(
  url: string | URL,
  options: FetchJsonOptions,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<FetchJsonResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new KpeError('NETWORK', '网络请求失败或被重定向');
  }
  const text = await readLimited(response, options.maxBytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    if (options.jsonOptional === true) {
      return { status: response.status, json: undefined };
    }
    throw new KpeError('BAD_JSON', '响应不是有效 JSON');
  }
  return { status: response.status, json };
}
