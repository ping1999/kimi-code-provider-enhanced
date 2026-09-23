import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pluginBuildOptions } from './build-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'dist', 'server.mjs');

await mkdir(resolve(root, 'dist'), { recursive: true });
await build(pluginBuildOptions(root, outfile));
console.log(`built ${outfile}`);
