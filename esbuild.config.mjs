import esbuild from 'esbuild';

const isProd = process.argv.includes('prod');

esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  sourcemap: !isProd,
  minify: isProd,
  target: ['es2020'],
  platform: 'node',
  external: ['obsidian'],
  define: {
    'process.env.NODE_ENV': isProd ? '"production"' : '"development"'
  }
}).catch(() => process.exit(1));
