import { describe, it, expect } from 'vitest';
import {
  resolveModelLanes,
  parseModelLane,
  createMockAuditFindings,
  runAuditWithRotation,
} from '../src/model-rotator.js';
import type { ScannedCodebase } from '../src/types.js';

describe('model-rotator', () => {
  it('parses model lane strings with provider and model', () => {
    const lane1 = parseModelLane('deepseek/deepseek-v4-flash');
    expect(lane1.providerId).toBe('deepseek');
    expect(lane1.model).toBe('deepseek-v4-flash');

    const lane2 = parseModelLane('openrouter/nvidia/nemotron-3.5-lightning:free');
    expect(lane2.providerId).toBe('openrouter');
    expect(lane2.model).toBe('nvidia/nemotron-3.5-lightning:free');

    const lane3 = parseModelLane('big-pickle');
    expect(lane3.providerId).toBe('opencode-zen');
    expect(lane3.model).toBe('big-pickle');
  });

  it('resolves default and custom model lanes', () => {
    const custom = resolveModelLanes({ models: ['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'] });
    expect(custom).toHaveLength(2);
    expect(custom[0]?.providerId).toBe('openai');
    expect(custom[1]?.providerId).toBe('anthropic');

    const defaults = resolveModelLanes();
    expect(defaults.length).toBeGreaterThan(0);
  });

  it('detects common pattern bugs in mock mode', () => {
    const buggyCodebase: ScannedCodebase = {
      targetDir: '/test',
      projectName: 'buggy-project',
      files: [
        {
          path: 'src/bad.ts',
          fullPath: '/test/src/bad.ts',
          size: 200,
          lines: 6,
          language: 'TypeScript',
          content: 'try {\n  doSomething();\n} catch (e) {}\nfor (let i = 0; i <= arr.length; i++) {\n  console.log(arr[i]);\n}',
          isEntryOrConfig: false,
        },
      ],
      totalFiles: 1,
      totalLines: 6,
      languages: { TypeScript: 1 },
      fileTree: 'buggy-project/\n  ├─ src/bad.ts',
      summary: 'test summary',
    };

    const bugs = createMockAuditFindings(buggyCodebase);
    expect(bugs.length).toBeGreaterThanOrEqual(2);

    const emptyCatch = bugs.find((b) => b.category === 'error-handling');
    expect(emptyCatch).toBeDefined();
    expect(emptyCatch?.severity).toBe('HIGH');

    const offByOne = bugs.find((b) => b.category === 'logic');
    expect(offByOne).toBeDefined();
  });

  it('runs full mock audit with rotation', async () => {
    const testCodebase: ScannedCodebase = {
      targetDir: '/test',
      projectName: 'test-app',
      files: [
        {
          path: 'src/index.ts',
          fullPath: '/test/src/index.ts',
          size: 100,
          lines: 3,
          language: 'TypeScript',
          content: 'export const run = () => true;',
          isEntryOrConfig: true,
        },
      ],
      totalFiles: 1,
      totalLines: 3,
      languages: { TypeScript: 1 },
      fileTree: 'test-app/\n  ├─ src/index.ts',
      summary: 'test summary',
    };

    const result = await runAuditWithRotation(testCodebase, { mock: true });
    expect(result.modelsUsed).toContain('mock/mock-bug-hunter');
    expect(result.bugs.length).toBeGreaterThan(0);
    expect(result.codebaseStats.totalFiles).toBe(1);
  });
});
