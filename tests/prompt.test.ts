import { describe, it, expect } from 'vitest';
import { buildAuditPrompt, parseModelBugResponse } from '../src/prompt.js';
import type { ScannedCodebase } from '../src/types.js';

describe('prompt', () => {
  const dummyCodebase: ScannedCodebase = {
    targetDir: '/dummy/dir',
    projectName: 'dummy-proj',
    files: [
      {
        path: 'src/main.ts',
        fullPath: '/dummy/dir/src/main.ts',
        size: 100,
        lines: 5,
        language: 'TypeScript',
        content: 'const x: any = null;\nconsole.log(x.foo);',
        isEntryOrConfig: true,
      },
    ],
    totalFiles: 1,
    totalLines: 5,
    languages: { TypeScript: 1 },
    fileTree: 'dummy-proj/\n  ├─ src/main.ts',
    summary: 'dummy summary',
  };

  it('builds system and user prompts with codebase context', () => {
    const prompt = buildAuditPrompt(dummyCodebase);
    expect(prompt.system).toContain('You are Pitstop');
    expect(prompt.user).toContain('dummy-proj');
    expect(prompt.user).toContain('src/main.ts');
    expect(prompt.user).toContain('console.log(x.foo);');
  });

  it('parses raw JSON bug responses correctly', () => {
    const raw = JSON.stringify({
      summary: 'Found critical null pointer dereference',
      bugs: [
        {
          id: 'BUG-001',
          title: 'Null pointer dereference',
          severity: 'CRITICAL',
          category: 'runtime',
          file: 'src/main.ts',
          lineStart: 2,
          lineEnd: 2,
          snippet: 'console.log(x.foo)',
          description: 'x is null and accessing foo crashes with TypeError',
          trigger: 'Running main function',
          suggestedFix: 'if (x) console.log(x.foo);',
          agentInstructions: 'Add null guard before property access',
        },
      ],
    });

    const parsed = parseModelBugResponse(raw);
    expect(parsed.summary).toBe('Found critical null pointer dereference');
    expect(parsed.bugs).toHaveLength(1);
    expect(parsed.bugs[0]?.severity).toBe('CRITICAL');
    expect(parsed.bugs[0]?.file).toBe('src/main.ts');
    expect(parsed.bugs[0]?.lineStart).toBe(2);
  });

  it('parses JSON enclosed in markdown code fences', () => {
    const raw = `Here is my audit report:
\`\`\`json
{
  "summary": "Detected 1 high priority logic bug",
  "bugs": [
    {
      "id": "BUG-001",
      "title": "Off-by-one boundary error",
      "severity": "HIGH",
      "category": "logic",
      "file": "src/loop.ts",
      "lineStart": 10,
      "snippet": "for (let i = 0; i <= arr.length; i++)",
      "description": "Index out of bounds on final iteration",
      "trigger": "Iterating array",
      "suggestedFix": "i < arr.length",
      "agentInstructions": "Change <= to <"
    }
  ]
}
\`\`\`
Hope this helps!`;

    const parsed = parseModelBugResponse(raw);
    expect(parsed.bugs).toHaveLength(1);
    expect(parsed.bugs[0]?.title).toBe('Off-by-one boundary error');
    expect(parsed.bugs[0]?.severity).toBe('HIGH');
    expect(parsed.bugs[0]?.category).toBe('logic');
  });

  it('handles invalid JSON gracefully without throwing', () => {
    const raw = 'Oops, something went wrong, not json at all';
    const parsed = parseModelBugResponse(raw);
    expect(parsed.bugs).toEqual([]);
    expect(parsed.summary).toContain('not valid JSON');
  });
});
