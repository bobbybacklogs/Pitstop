import type { BugFinding, BugSeverity, BugCategory, ScannedCodebase } from './types.js';

export const AUDIT_SYSTEM_PROMPT = `You are Pitstop, an automated elite code auditor and bug detection engine.
Your sole mission: scan the provided codebase files and identify obvious, real, and uncaught bugs.

Categories of bugs to detect:
1. RUNTIME: Unhandled exceptions, null/undefined property dereferences, array index out of bounds, missing catch handlers.
2. LOGIC: Flawed boolean conditions, inverted logic, off-by-one errors, incorrect arithmetic, broken state machine transitions.
3. CONCURRENCY: Missing await on promises, unhandled promise rejections, race conditions on shared state, deadlock.
4. SECURITY: Command injection, path traversal, hardcoded secrets/keys, unsafe deserialization, insecure regex (ReDoS).
5. CONTRACT: Mismatched function signatures, broken imports/exports, wrong parameter orders, missing mandatory arguments.
6. ERROR HANDLING: Swallowed exceptions that silently fail, throwing non-Error objects, unreachable recovery paths.

CRITICAL RULES:
- DO NOT report stylistic preferences, missing documentation, or speculative architectural refactorings.
- ONLY report REAL, actionable bugs that produce incorrect results, crashes, vulnerabilities, or regressions.
- If the codebase has no bugs, return an empty bugs array: "bugs": [].
- Every bug must have clear instructions so the next coding agent can fix it immediately without ambiguity.

You MUST respond strictly with valid JSON conforming to this schema (optionally enclosed in a \`\`\`json code block):

{
  "summary": "High-level summary of code quality and bugs found",
  "bugs": [
    {
      "id": "BUG-001",
      "title": "Short descriptive title of the bug",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "category": "runtime" | "logic" | "concurrency" | "security" | "contract" | "error-handling" | "syntax",
      "file": "relative/path/to/file.ext",
      "lineStart": 10,
      "lineEnd": 15,
      "snippet": "problematic lines of code",
      "description": "Clear explanation of what happens and why it is a bug",
      "trigger": "Exact condition or input that triggers this failure",
      "suggestedFix": "Code diff or replacement snippet solving the bug",
      "agentInstructions": "Exact step-by-step instructions for the next agent to implement and verify the fix"
    }
  ]
}`;

export function buildAuditPrompt(
  codebase: ScannedCodebase,
  options: { focus?: string; modelName?: string } = {}
): { system: string; user: string } {
  const fileSections: string[] = [];

  for (const file of codebase.files) {
    fileSections.push(
      `--- FILE: ${file.path} (${file.language}, ${file.lines} lines) ---\n${file.content}\n--- END OF FILE: ${file.path} ---`
    );
  }

  const userPrompt = `Audit the following codebase: "${codebase.projectName}".
Target directory: ${codebase.targetDir}
Total files scanned: ${codebase.totalFiles}
Total lines of code: ${codebase.totalLines}

DIRECTORY STRUCTURE:
${codebase.fileTree}

${options.focus ? `SPECIAL AUDIT FOCUS: ${options.focus}\n` : ''}
CODEBASE CONTENTS:
${fileSections.join('\n\n')}

Analyze these files thoroughly. Find any obvious and uncaught bugs. Return your findings in the required JSON format.`;

  return {
    system: AUDIT_SYSTEM_PROMPT,
    user: userPrompt,
  };
}

export function parseModelBugResponse(rawResponse: string): {
  summary: string;
  bugs: BugFinding[];
} {
  let cleaned = rawResponse.trim();

  // Strip markdown code fences if present
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (jsonMatch) {
    cleaned = jsonMatch[1].trim();
  } else {
    // If there is preamble before { and text after }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Attempt minor JSON cleanup (e.g. trailing commas)
    try {
      const relaxed = cleaned.replace(/,\s*([}\]])/g, '$1');
      parsed = JSON.parse(relaxed);
    } catch {
      return {
        summary: `Audit completed, but raw response was not valid JSON: ${(err as Error).message}`,
        bugs: [],
      };
    }
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary : 'Codebase audit complete.';
  const rawBugs = Array.isArray(parsed.bugs) ? parsed.bugs : [];

  const bugs: BugFinding[] = rawBugs.map((b: any, index: number): BugFinding => {
    const rawSev = String(b.severity || 'MEDIUM').toUpperCase();
    const severity: BugSeverity = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(rawSev)
      ? (rawSev as BugSeverity)
      : 'MEDIUM';

    const rawCat = String(b.category || 'logic').toLowerCase();
    const category: BugCategory = [
      'logic',
      'runtime',
      'concurrency',
      'security',
      'contract',
      'error-handling',
      'syntax',
    ].includes(rawCat)
      ? (rawCat as BugCategory)
      : 'logic';

    const num = String(index + 1).padStart(3, '0');
    const id = b.id && /^BUG-\d+/i.test(b.id) ? b.id.toUpperCase() : `BUG-${num}`;

    return {
      id,
      title: String(b.title || `Bug in ${b.file || 'codebase'}`).trim(),
      severity,
      category,
      file: String(b.file || 'unknown').replace(/\\/g, '/'),
      lineStart: typeof b.lineStart === 'number' ? b.lineStart : undefined,
      lineEnd: typeof b.lineEnd === 'number' ? b.lineEnd : undefined,
      snippet: b.snippet ? String(b.snippet).trim() : undefined,
      description: String(b.description || 'No description provided.').trim(),
      trigger: String(b.trigger || 'Trigger condition unspecified.').trim(),
      suggestedFix: String(b.suggestedFix || 'Review code and correct logic.').trim(),
      agentInstructions: String(
        b.agentInstructions || 'Apply suggested fix and add regression test.'
      ).trim(),
    };
  });

  return { summary, bugs };
}
