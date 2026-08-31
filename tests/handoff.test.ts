import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatHandoffMarkdown, saveHandoffReport } from '../src/handoff.js';
import type { AuditResult } from '../src/types.js';

describe('handoff', () => {
  const testDir = join(tmpdir(), 'pitstop-handoff-test-' + Date.now());

  const sampleResult: AuditResult = {
    scannedAt: '2026-08-31T00:40:00.000Z',
    targetDir: testDir,
    projectName: 'sample-project',
    modelsUsed: ['opencode-zen/big-pickle', 'deepseek/deepseek-v4-flash'],
    rotationEvents: [
      {
        at: '2026-08-31T00:40:05.000Z',
        from: { providerId: 'opencode-zen', model: 'big-pickle' },
        to: { providerId: 'deepseek', model: 'deepseek-v4-flash' },
        reason: 'rate-limited HTTP 429: Usage limit exceeded',
        attempt: 1,
      },
    ],
    bugs: [
      {
        id: 'BUG-001',
        title: 'Unhandled Promise rejection in request pipeline',
        severity: 'CRITICAL',
        category: 'concurrency',
        file: 'src/server.ts',
        lineStart: 42,
        lineEnd: 46,
        snippet: 'fetchData().then(render);',
        description: 'Promise rejection is not caught, causing Node process to terminate.',
        trigger: 'Network disconnection or 500 error from API.',
        suggestedFix: 'await fetchData().then(render).catch(handleError);',
        agentInstructions: 'Wrap fetch call in try/catch or attach error handler.',
      },
      {
        id: 'BUG-002',
        title: 'Empty catch block suppresses database errors',
        severity: 'HIGH',
        category: 'error-handling',
        file: 'src/db.ts',
        lineStart: 18,
        snippet: 'catch (e) {}',
        description: 'Swallows SQL failure silently without reconnect.',
        trigger: 'Database disconnect.',
        suggestedFix: 'catch (e) { logger.error(e); throw e; }',
        agentInstructions: 'Log and escalate database error.',
      },
    ],
    codebaseStats: {
      totalFiles: 15,
      totalLines: 1250,
      languages: { TypeScript: 12, JSON: 3 },
    },
    summary: 'Sample audit detected 2 bugs requiring remediation.',
  };

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('formats comprehensive agent handoff markdown', () => {
    const md = formatHandoffMarkdown(sampleResult);

    expect(md).toContain('# 🛑 Pitstop Bug Audit & Agent Handoff');
    expect(md).toContain('sample-project');
    expect(md).toContain('CRITICAL ATTENTION REQUIRED');
    expect(md).toContain('Model Rotation History');
    expect(md).toContain('opencode-zen/big-pickle');
    expect(md).toContain('deepseek/deepseek-v4-flash');
    expect(md).toContain('Prompt for the Next Agent');
    expect(md).toContain('- [ ] **[BUG-001]** `[CRITICAL]`');
    expect(md).toContain('- [ ] **[BUG-002]** `[HIGH]`');
    expect(md).toContain('Suggested Fix');
    expect(md).toContain('Instructions for Next Agent');
    expect(md).toContain('```json');
  });

  it('saves handoff report to disk and returns saved path', () => {
    const handoff = saveHandoffReport(sampleResult, {
      outputPath: join(testDir, 'custom-handoff.md'),
      includeJson: true,
    });

    expect(handoff.savedPath).toBe(join(testDir, 'custom-handoff.md'));
    expect(handoff.criticalCount).toBe(1);
    expect(handoff.highCount).toBe(1);
    expect(handoff.bugsCount).toBe(2);

    const savedContent = readFileSync(handoff.savedPath, 'utf8');
    expect(savedContent).toContain('BUG-001');

    expect(handoff.jsonPath).toBeDefined();
    const jsonContent = JSON.parse(readFileSync(handoff.jsonPath!, 'utf8'));
    expect(jsonContent.bugs).toHaveLength(2);
  });
});
