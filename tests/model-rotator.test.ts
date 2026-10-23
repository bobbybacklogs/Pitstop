import { describe, it, expect } from 'vitest';
import { ModelHitchError } from 'modelhitch';
import {
  resolveModelLanes,
  parseModelLane,
  createMockAuditFindings,
  runAuditWithRotation,
} from '../src/model-rotator.js';
import type { ScannedCodebase } from '../src/types.js';
import type { Provider } from 'modelhitch';

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

function makeProvider(handler: (model: string) => any): Provider {
  return {
    id: 'fake',
    name: 'Fake',
    defaultModel: 'ok-model',
    capabilities: { streaming: true, toolCalling: true, vision: false, embeddings: false },
    async chat(params: any) {
      return handler(params.model);
    },
    async *stream() {
      yield { type: 'text-delta', text: '' };
      yield { type: 'finish', finishReason: 'stop' };
    },
  } as unknown as Provider;
}

describe('model-rotator', () => {
  it('parses model lane strings with provider and model', () => {
    const lane1 = parseModelLane('deepseek/deepseek-v4-flash');
    expect(lane1.providerId).toBe('deepseek');
    expect(lane1.model).toBe('deepseek-v4-flash');

    const lane2 = parseModelLane('openrouter/nvidia/nemotron-3.5-lightning:free');
    expect(lane2.providerId).toBe('openrouter');
    expect(lane2.model).toBe('nvidia/nemotron-3.5-lightning:free');

    const lane3 = parseModelLane('openai/gpt-5.4');
    expect(lane3.providerId).toBe('openai');
    expect(lane3.model).toBe('gpt-5.4');

    const bare = parseModelLane('gpt-5.4');
    expect(bare.providerId).toBe('vercel-ai-gateway');
    expect(bare.model).toBe('gpt-5.4');
  });

  it('resolves default and custom model lanes', () => {
    const prevHome = process.env.MODELHITCH_HOME;
    process.env.MODELHITCH_HOME = '/nonexistent/modelhitch-home-for-tests';
    try {
      const custom = resolveModelLanes({ models: ['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'] });
      expect(custom).toHaveLength(2);
      expect(custom[0]?.providerId).toBe('openai');
      expect(custom[1]?.providerId).toBe('anthropic');

      const defaults = resolveModelLanes();
      expect(defaults.length).toBeGreaterThan(0);
      expect(defaults[0]?.providerId).toBe('vercel-ai-gateway');
    } finally {
      if (prevHome === undefined) delete process.env.MODELHITCH_HOME;
      else process.env.MODELHITCH_HOME = prevHome;
    }
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

  it('runs a full audit through an injected model lane and parses findings', async () => {
    const json = JSON.stringify({
      summary: 'found one',
      bugs: [
        {
          id: 'BUG-001',
          title: 'null deref',
          severity: 'HIGH',
          category: 'runtime',
          file: 'src/index.ts',
          lineStart: 1,
          description: 'd',
          trigger: 't',
          suggestedFix: 'f',
          agentInstructions: 'a',
        },
      ],
    });
    const provider = makeProvider(() => ({
      message: { role: 'assistant', content: json },
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    }));
    const result = await runAuditWithRotation(testCodebase, {
      models: ['fake/ok-model'],
      providers: [provider],
    });
    expect(result.bugs).toHaveLength(1);
    expect(result.bugs[0]?.title).toBe('null deref');
    expect(result.modelsUsed).toContain('fake/ok-model');
    expect(result.usage?.totalTokens).toBe(12);
    expect(result.usage?.byModel).toHaveLength(1);
  });

  it('records truncated responses when finishReason is length', async () => {
    const json = JSON.stringify({ summary: 's', bugs: [] });
    const provider = makeProvider(() => ({
      message: { role: 'assistant', content: json },
      finishReason: 'length',
    }));
    const result = await runAuditWithRotation(testCodebase, {
      models: ['fake/ok-model'],
      providers: [provider],
    });
    expect(result.truncated).toBe(true);
  });

  it('falls back to the local pattern hunter when every lane fails', async () => {
    const provider = makeProvider(() => {
      throw new ModelHitchError('bad-request', 'boom', { status: 400, providerId: 'fake' });
    });
    const result = await runAuditWithRotation(testCodebase, {
      models: ['fake/only-model'],
      providers: [provider],
    });
    expect(result.modelsUsed).toContain('mock/local-fallback');
    expect(result.bugs.length).toBeGreaterThan(0);
  });

  it('rotates manually from a failing lane to a working lane', async () => {
    const json = JSON.stringify({ summary: 'ok', bugs: [] });
    const provider = makeProvider((model: string) => {
      if (model === 'fail-model') {
        throw new ModelHitchError('bad-request', 'nope', { status: 400, providerId: 'fake' });
      }
      return { message: { role: 'assistant', content: json }, finishReason: 'stop' };
    });
    const result = await runAuditWithRotation(testCodebase, {
      models: ['fake/fail-model', 'fake/ok-model'],
      providers: [provider],
    });
    expect(result.rotationEvents).toHaveLength(1);
    expect(result.rotationEvents[0]?.to.model).toBe('ok-model');
    expect(result.modelsUsed).toContain('fake/ok-model');
  });

  it('aggregates findings across all lanes in --multi mode', async () => {
    const jsonA = JSON.stringify({
      summary: 'a',
      bugs: [{ title: 'bugA', severity: 'HIGH', category: 'logic', file: 'src/a.ts', lineStart: 1, description: 'd', trigger: 't', suggestedFix: 'f', agentInstructions: 'a' }],
    });
    const jsonB = JSON.stringify({
      summary: 'b',
      bugs: [{ title: 'bugB', severity: 'MEDIUM', category: 'runtime', file: 'src/b.ts', lineStart: 5, description: 'd', trigger: 't', suggestedFix: 'f', agentInstructions: 'a' }],
    });
    const provider = makeProvider((model: string) => ({
      message: { role: 'assistant', content: model === 'lane-a' ? jsonA : jsonB },
      finishReason: 'stop',
    }));
    const result = await runAuditWithRotation(testCodebase, {
      models: ['fake/lane-a', 'fake/lane-b'],
      providers: [provider],
      multi: true,
    });
    expect(result.bugs).toHaveLength(2);
    const titles = result.bugs.map((b) => b.title);
    expect(titles).toContain('bugA');
    expect(titles).toContain('bugB');
  });
});
