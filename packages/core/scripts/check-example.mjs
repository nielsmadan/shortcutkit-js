import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXPECTED_OUTPUT = 'save';

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

function installTarball(tarball, dir) {
  const scope = join(dir, 'node_modules', '@shortcutkit');
  mkdirSync(scope, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', scope]);
  renameSync(join(scope, 'package'), join(scope, 'core'));
  return join(scope, 'core');
}

function checkExample(tarball) {
  const dir = mkdtempSync(join(tmpdir(), 'shortcutkit-example-'));
  try {
    const pkg = installTarball(tarball, dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig()));
    writeFileSync(
      join(dir, 'example.ts'),
      readmeExample(readFileSync(join(pkg, 'README.md'), 'utf8')),
    );
    execFileSync('tsc', ['-p', dir], { stdio: 'inherit' });
    const output = execFileSync('node', [join(dir, 'out', 'example.js')], { encoding: 'utf8' });
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
