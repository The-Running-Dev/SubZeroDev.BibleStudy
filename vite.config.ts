import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const publicDir = 'src/client/public';

function publicFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? publicFiles(join(dir, entry.name)) : [`/${relative(publicDir, join(dir, entry.name)).replaceAll('\\', '/')}`],
  );
}

// S14: emits /sw.js listing the built shell, so the app starts with no connection. Its version changes with any shell file.
function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle)
        .filter((name) => !name.endsWith('.map') && name !== 'index.html')
        .map((name) => `/${name}`);
      const shell = ['/', ...built, ...publicFiles(publicDir)].sort();
      const hash = createHash('sha256');
      for (const [name, output] of Object.entries(bundle)) hash.update(name).update(output.type === 'chunk' ? output.code : output.source);
      for (const file of publicFiles(publicDir)) hash.update(readFileSync(join(publicDir, file)));
      const version = hash.digest('hex').slice(0, 16);
      const source = `const version = ${JSON.stringify(version)};\nconst shell = ${JSON.stringify(shell)};\n${readFileSync('src/client/service-worker.js', 'utf8')}`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  root: 'src/client',
  plugins: [react(), serviceWorker()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/__build-id': 'http://localhost:3000',
    },
  },
});
