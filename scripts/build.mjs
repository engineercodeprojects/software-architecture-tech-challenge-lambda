// Bundle da function com esbuild: um unico arquivo CommonJS em dist/index.js.
// O bundle mantem o pacote leve (cold start menor) e dispensa node_modules no
// artefato de deploy.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});
