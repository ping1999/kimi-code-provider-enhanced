import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pluginBuildOptions } from './build-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, 'artifacts');
const manifest = JSON.parse(await readFile(resolve(root, 'kimi.plugin.json'), 'utf8'));

const LICENSE_FILE_NAMES = new Set(
  [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENCE',
    'LICENCE.md',
    'COPYING',
    'NOTICE',
  ].map((entry) => entry.toUpperCase()),
);

function bundledPackageDirs(metafile) {
  const dirs = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const normalized = input.replaceAll('\\', '/');
    const index = normalized.lastIndexOf('node_modules/');
    if (index < 0 || (index > 0 && normalized[index - 1] !== '/')) continue;
    const after = normalized.slice(index + 'node_modules/'.length);
    const parts = after.split('/');
    if (parts[0] === undefined || parts[0] === '') continue;
    const pkgName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0];
    if (pkgName.endsWith('/')) continue;
    const absolute = resolve(
      root,
      normalized.slice(0, index).replaceAll('/', sep),
      'node_modules',
      ...pkgName.split('/'),
    );
    const dir = existsSync(absolute)
      ? absolute
      : resolve(root, 'node_modules', ...pkgName.split('/'));
    dirs.set(dir, pkgName);
  }
  return dirs;
}

async function copyLicenses(stageDir, metafile) {
  const targets = join(stageDir, 'LICENSES');
  await mkdir(targets, { recursive: true });
  const missing = [];
  for (const [dir, pkgName] of bundledPackageDirs(metafile)) {
    const entries = existsSync(dir) ? await readdir(dir) : [];
    const found = entries.find((entry) => LICENSE_FILE_NAMES.has(entry.toUpperCase()));
    if (found === undefined) {
      missing.push(pkgName);
      continue;
    }
    const name = pkgName
      .replaceAll('@', '')
      .replaceAll(/[^a-zA-Z0-9_-]/g, '-')
      .toUpperCase();
    await cp(join(dir, found), join(targets, `${name}-LICENSE`));
  }
  if (missing.length > 0) {
    throw new Error(`missing license files for bundled packages: ${missing.join(', ')}`);
  }
}

const baseName = `${manifest.name}-${manifest.version}`;
let outZip = join(artifacts, `${baseName}.zip`);
if (existsSync(outZip)) {
  outZip = join(artifacts, `${baseName}-${Date.now()}.zip`);
}

const stage = await mkdtemp(join(tmpdir(), 'kpe-package-'));
try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(join(stage, 'dist'), { recursive: true });

  const result = await build({
    ...pluginBuildOptions(root, join(stage, 'dist', 'server.mjs')),
    logLevel: 'warning',
    metafile: true,
  });

  await cp(resolve(root, 'kimi.plugin.json'), join(stage, 'kimi.plugin.json'));
  await cp(resolve(root, 'skills'), join(stage, 'skills'), { recursive: true });
  await copyLicenses(stage, result.metafile);

  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${stage.replaceAll("'", "''")}\\*' -DestinationPath '${outZip.replaceAll("'", "''")}' -Force`,
    ],
    { stdio: 'inherit' },
  );
  if (ps.status !== 0) {
    throw new Error('Compress-Archive failed');
  }
  console.log(`packaged ${outZip}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
