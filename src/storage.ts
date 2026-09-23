import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveKimiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

export function pluginDataDir(home: string): string {
  return join(home, 'provider-enhanced');
}

export function catalogCachePath(home: string): string {
  return join(pluginDataDir(home), 'catalog.json');
}

export function auditDir(home: string): string {
  return join(pluginDataDir(home), 'audit');
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let renamed = false;
  try {
    const handle = await open(tmpPath, 'w', mode);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await chmod(tmpPath, mode).catch(() => undefined);
    await rename(tmpPath, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(tmpPath).catch(() => undefined);
  }
}

export interface ServerInstance {
  serverId: string;
  pid: number;
  host: string;
  port: number;
  startedAt: number;
  heartbeatAt: number;
  serverVersion?: string;
}

const HEARTBEAT_MAX_AGE_MS = 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function decodeInstance(raw: unknown): ServerInstance | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const parsed = raw as Record<string, unknown>;
  if (
    typeof parsed['server_id'] !== 'string' ||
    typeof parsed['pid'] !== 'number' ||
    typeof parsed['host'] !== 'string' ||
    typeof parsed['port'] !== 'number' ||
    typeof parsed['started_at'] !== 'number' ||
    typeof parsed['heartbeat_at'] !== 'number'
  ) {
    return undefined;
  }
  const info: ServerInstance = {
    serverId: parsed['server_id'],
    pid: parsed['pid'],
    host: parsed['host'],
    port: parsed['port'],
    startedAt: parsed['started_at'],
    heartbeatAt: parsed['heartbeat_at'],
  };
  if (typeof parsed['host_version'] === 'string') {
    return { ...info, serverVersion: parsed['host_version'] };
  }
  return info;
}

export async function listLiveServerInstances(
  home: string,
  now: () => number = Date.now,
): Promise<ServerInstance[]> {
  const dir = join(home, 'server', 'instances');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const live: ServerInstance[] = [];
  const nowMs = now();
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const info = decodeInstance(await readJsonFile(join(dir, name)));
    if (info === undefined) continue;
    if (!Number.isInteger(info.pid) || info.pid <= 0) continue;
    if (!Number.isFinite(info.startedAt) || !Number.isFinite(info.heartbeatAt)) continue;
    if (info.heartbeatAt > nowMs + HEARTBEAT_MAX_AGE_MS) continue;
    if (nowMs - info.heartbeatAt > HEARTBEAT_MAX_AGE_MS) continue;
    if (!isLoopbackHost(info.host)) continue;
    if (!Number.isInteger(info.port) || info.port <= 0 || info.port > 65535) continue;
    if (!pidAlive(info.pid)) continue;
    live.push(info);
  }
  live.sort((a, b) => a.startedAt - b.startedAt);
  return live;
}

export async function readServerToken(home: string): Promise<string | undefined> {
  try {
    const tokenPath = join(home, 'server.token');
    const info = await stat(tokenPath);
    if (!info.isFile()) return undefined;
    const token = (await readFile(tokenPath, 'utf8')).trim();
    return token.length === 0 ? undefined : token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
}
