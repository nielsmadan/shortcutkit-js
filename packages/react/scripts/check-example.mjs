import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const EXPECTED_OUTPUT = '⌘S';
const PACKAGE_DIR = resolve(import.meta.dirname, '..');
const LINKED_MODULES = ['react', 'react-dom', '@types/react', '@types/react-dom'];

function readmeExample(readme) {
  const match = /```tsx\n([\s\S]*?)```/.exec(readme);
  if (!match) throw new Error('README.md has no ```tsx example');
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
      jsx: 'react-jsx',
      types: [],
      skipLibCheck: false,
      outDir: 'out',
    },
    files: ['example.tsx'],
  };
}

function installTarball(tarball, dir, name) {
  const scope = join(dir, 'node_modules', '@shortcutkit');
  mkdirSync(scope, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', scope]);
  renameSync(join(scope, 'package'), join(scope, name));
  return join(scope, name);
}

function packSibling(dir, name) {
  const tarball = join(dir, `${name}.tgz`);
  execFileSync('pnpm', ['pack', '--out', tarball], {
    cwd: resolve(PACKAGE_DIR, '..', name),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  installTarball(tarball, dir, name);
}

function linkModule(dir, from, name) {
  const link = join(dir, 'node_modules', name);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(from, link, 'dir');
}

function linkDependencies(dir) {
  const modules = join(PACKAGE_DIR, 'node_modules');
  LINKED_MODULES.forEach((name) => linkModule(dir, realpathSync(join(modules, name)), name));
  const typesReact = createRequire(join(realpathSync(join(modules, '@types/react')), 'index.d.ts'));
  linkModule(dir, dirname(typesReact.resolve('csstype/package.json')), 'csstype');
}

function checkExample(tarball) {
  const dir = mkdtempSync(join(tmpdir(), 'shortcutkit-example-'));
  try {
    const pkg = installTarball(tarball, dir, 'react');
    packSibling(dir, 'core');
    packSibling(dir, 'dom');
    linkDependencies(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig()));
    writeFileSync(
      join(dir, 'example.tsx'),
      readmeExample(readFileSync(join(pkg, 'README.md'), 'utf8')),
    );
    execFileSync('tsc', ['-p', dir], { stdio: 'inherit' });
    const output = execFileSync('node', [join(dir, 'out', 'example.js')], {
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
