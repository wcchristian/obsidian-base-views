import esbuild from 'esbuild';

const isProd = process.argv.includes('prod');
const isWatch = process.argv.includes('watch');

const options = {
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
};

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching for changes…');
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
