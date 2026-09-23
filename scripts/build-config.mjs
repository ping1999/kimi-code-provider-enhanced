import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

export function pluginBuildOptions(root, outfile) {
  return {
    entryPoints: [resolve(root, 'src', 'server.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'bundle',
    external: ['node:*', ...builtinModules],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  };
}
