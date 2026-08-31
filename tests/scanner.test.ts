import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanDirectory } from '../src/scanner.js';

describe('scanner', () => {
  const testDir = join(tmpdir(), 'pitstop-scanner-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });
    mkdirSync(join(testDir, 'node_modules', 'fake-pkg'), { recursive: true });
    mkdirSync(join(testDir, '.git'), { recursive: true });

    // Valid files
    writeFileSync(join(testDir, 'package.json'), '{"name":"test-project"}');
    writeFileSync(join(testDir, 'src', 'index.ts'), 'export const hello = () => "world";\n');
    writeFileSync(join(testDir, 'src', 'calc.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');

    // Secret file
    writeFileSync(join(testDir, 'src', 'secrets.ts'), 'const key = "AIzaSyDummyFakeKeyPattern12345678901234";\n');

    // Files that MUST be ignored
    writeFileSync(join(testDir, 'node_modules', 'fake-pkg', 'index.js'), 'module.exports = {};');
    writeFileSync(join(testDir, '.git', 'config'), '[core]\n');
    writeFileSync(join(testDir, 'package-lock.json'), '{"lockfileVersion": 3}');
    writeFileSync(join(testDir, 'image.png'), Buffer.from([137, 80, 78, 71]));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('scans source files while ignoring node_modules, .git, lockfiles, and binaries', () => {
    const codebase = scanDirectory(testDir);

    expect(codebase.totalFiles).toBeGreaterThan(0);
    const scannedPaths = codebase.files.map((f) => f.path);

    expect(scannedPaths).toContain('package.json');
    expect(scannedPaths).toContain('src/index.ts');
    expect(scannedPaths).toContain('src/calc.ts');

    // Check ignored files are NOT present
    expect(scannedPaths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(scannedPaths.some((p) => p.includes('.git'))).toBe(false);
    expect(scannedPaths.some((p) => p.includes('package-lock.json'))).toBe(false);
    expect(scannedPaths.some((p) => p.includes('image.png'))).toBe(false);
  });

  it('identifies languages correctly', () => {
    const codebase = scanDirectory(testDir);
    expect(codebase.languages['TypeScript']).toBeGreaterThanOrEqual(2);
    expect(codebase.languages['JSON']).toBe(1);
  });

  it('redacts detected API keys and secrets', () => {
    const codebase = scanDirectory(testDir);
    const secretsFile = codebase.files.find((f) => f.path === 'src/secrets.ts');
    expect(secretsFile).toBeDefined();
    expect(secretsFile?.content).toContain('[[REDACTED_API_KEY]]');
    expect(secretsFile?.content).not.toContain('AIzaSyDummyFakeKeyPattern');
  });

  it('respects .gitignore', () => {
    writeFileSync(join(testDir, '.gitignore'), 'temp.ts\n*.log\n');
    writeFileSync(join(testDir, 'temp.ts'), 'console.log("temp");');
    writeFileSync(join(testDir, 'debug.log'), 'error at line 1');

    const codebase = scanDirectory(testDir);
    const paths = codebase.files.map((f) => f.path);

    expect(paths).not.toContain('temp.ts');
    expect(paths).not.toContain('debug.log');
  });
});
