import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

describe('cli', () => {
  const cliDistPath = join(process.cwd(), 'dist', 'cli.js');
  const tempHandoffPath = join(process.cwd(), 'test-handoff-output.md');

  afterEach(() => {
    try {
      if (existsSync(tempHandoffPath)) {
        rmSync(tempHandoffPath, { force: true });
      }
    } catch {
      // ignore
    }
  });

  it('prints help message with options', () => {
    const output = execSync(`node "${cliDistPath}" --help`, { encoding: 'utf8' });
    expect(output).toContain('pitstop');
    expect(output).toContain('--models');
    expect(output).toContain('--mock');
    expect(output).toContain('--output');
  });

  it('runs mock audit and outputs saved report location', () => {
    const output = execSync(
      `node "${cliDistPath}" . --mock -o "${tempHandoffPath}" --max-files 10`,
      { encoding: 'utf8' }
    );

    expect(output).toContain('Pitstop');
    expect(output).toContain('Scanning codebase');
    expect(output).toContain('Mock Bug Hunter');
    expect(output).toContain('HANDOFF REPORT SAVED');
    expect(output).toContain(tempHandoffPath);
    expect(output).toContain('READY FOR NEXT AGENT HANDOFF');

    expect(existsSync(tempHandoffPath)).toBe(true);
  });
});
