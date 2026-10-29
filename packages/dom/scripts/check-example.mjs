import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXPECTED_OUTPUT = 'goToTop';

function readmeExample(readme) {
  const match = /```ts\n([\s\S]*?)```/.exec(readme);
  if (!match) throw new Error('README.md has no ```ts example');
  return match[1];
}

function tsconfig() {
  return {
    compilerOptions: {
      strict: true,
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'es2023',
      lib: ['es2023', 'dom'],
      types: [],
      skipLibCheck: false,
      outDir: 'out',
    },
    files: ['example.ts'],
  };
}

function installTarball(tarball, dir, name) {
  const scope = join(dir, 'node_modules', '@shortcutkit');
  mkdirSync(scope, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', scope]);
  renameSync(join(scope, 'package'), join(scope, name));
  return join(scope, name);
}

function runner() {
  const happyDom = JSON.stringify(import.meta.resolve('happy-dom'));
  return `import { Window } from ${happyDom};
const window = new Window({ url: 'http://localhost/' });
for (const [name, value] of [
  ['window', window],
  ['document', window.document],
  ['localStorage', window.localStorage],
  ['KeyboardEvent', window.KeyboardEvent],
]) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
await import('./out/example.js');
await window.happyDOM.close();
`;
}

function checkExample(tarball) {
  const dir = mkdtempSync(join(tmpdir(), 'shortcutkit-example-'));
  try {
    const pkg = installTarball(tarball, dir, 'dom');
    execFileSync('pnpm', ['pack', '--out', join(dir, 'core.tgz')], {
      cwd: resolve(import.meta.dirname, '../../core'),
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    installTarball(join(dir, 'core.tgz'), dir, 'core');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig()));
    writeFileSync(
      join(dir, 'example.ts'),
      readmeExample(readFileSync(join(pkg, 'README.md'), 'utf8')),
    );
    writeFileSync(join(dir, 'runner.mjs'), runner());
    execFileSync('tsc', ['-p', dir], { stdio: 'inherit' });
    const output = execFileSync('node', [join(dir, 'runner.mjs')], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (output.trim() !== EXPECTED_OUTPUT) {
      throw new Error(
        `README example printed ${JSON.stringify(output)}, expected "${EXPECTED_OUTPUT}"`,
      );
    }
    console.log('README example type-checks and runs against the packed package');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

checkExample(resolve(process.argv[2]));
