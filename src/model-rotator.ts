import {
  ModelHitch,
  MemoryKeyStore,
  readConfigFile,
  defaultProviders,
  type FailoverEvent,
  type ContentPart,
} from 'modelhitch';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AuditResult,
  BugFinding,
  ModelLane,
  RotationEvent,
  ScannedCodebase,
} from './types.js';
import { buildAuditPrompt, parseModelBugResponse } from './prompt.js';

export interface AuditRunOptions {
  models?: string[];
  mock?: boolean;
  multi?: boolean;
  verbose?: boolean;
  onRotation?: (event: RotationEvent) => void;
  onProgress?: (message: string) => void;
}

export const DEFAULT_CODING_MODELS: ModelLane[] = [
  { providerId: 'deepseek', model: 'deepseek-v4-flash' },
  { providerId: 'opencode-zen', model: 'big-pickle' },
  { providerId: 'opencode-zen', model: 'nemotron-3.5-lightning-free' },
  { providerId: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free' },
  { providerId: 'opencode-zen', model: 'north-mini-code-free' },
];

const ENV_KEY_MAP: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  'opencode-zen': 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  together: 'TOGETHER_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
};

export function getModelhitchConfigPath(): string {
  const home = process.env.MODELHITCH_HOME || join(homedir(), '.modelhitch');
  return join(home, 'config.json');
}

export function extractTextContent(content: string | ContentPart[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if ('text' in part && typeof (part as any).text === 'string') {
          return (part as any).text;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

export function resolveAvailableKeys(): Record<string, string> {
  const keys: Record<string, string> = {};

  // 1. Read from ~/.modelhitch/config.json if present
  try {
    const configPath = getModelhitchConfigPath();
    const config = readConfigFile(configPath);
    if (config?.keys) {
      for (const [provider, key] of Object.entries(config.keys)) {
        if (key && typeof key === 'string' && !key.includes('***')) {
          keys[provider] = key;
        }
      }
    }
  } catch {
    // Ignore file read error
  }

  // 2. Read from process.env (overrides file keys)
  for (const [provider, envVar] of Object.entries(ENV_KEY_MAP)) {
    const envVal = process.env[envVar];
    if (envVal) {
      keys[provider] = envVal;
    }
  }

  return keys;
}

export function parseModelLane(raw: string): ModelLane {
  const parts = raw.trim().split('/');
  if (parts.length >= 2) {
    return {
      providerId: parts[0]!.toLowerCase(),
      model: parts.slice(1).join('/'),
    };
  }
  return {
    providerId: 'opencode-zen',
    model: raw.trim(),
  };
}

export function resolveModelLanes(options: { models?: string[] } = {}): ModelLane[] {
  if (options.models && options.models.length > 0) {
    return options.models.map(parseModelLane);
  }

  // Check config policy
  try {
    const configPath = getModelhitchConfigPath();
    const config = readConfigFile(configPath);
    const lanes: ModelLane[] = [];
    if (config?.policy?.trusted && Array.isArray(config.policy.trusted)) {
      for (const entry of config.policy.trusted) {
        const providerId = entry.providerId;
        const models = entry.models && entry.models.length > 0 ? entry.models : ['default'];
        for (const m of models) {
          lanes.push({ providerId, model: m });
        }
      }
    }
    if (lanes.length > 0) {
      return lanes;
    }
  } catch {
    // fallback
  }

  return [...DEFAULT_CODING_MODELS];
}

export function createMockAuditFindings(codebase: ScannedCodebase): BugFinding[] {
  const findings: BugFinding[] = [];
  let counter = 1;

  for (const file of codebase.files) {
    const lines = file.content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // Check for empty catch block
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line) || /catch\s*\{\s*\}/.test(line)) {
        findings.push({
          id: `BUG-${String(counter++).padStart(3, '0')}`,
          title: `Empty catch block swallows errors silently in ${file.path}`,
          severity: 'HIGH',
          category: 'error-handling',
          file: file.path,
          lineStart: lineNum,
          lineEnd: lineNum,
          snippet: line.trim(),
          description: 'Empty catch block suppresses runtime exceptions without logging or recovery, causing silent failures.',
          trigger: 'When any error or exception occurs in the try block.',
          suggestedFix: 'Log the error or rethrow/handle with fallback logic:\ncatch (err) {\n  console.error("Operation failed:", err);\n  throw err;\n}',
          agentInstructions: 'Inspect surrounding try block in file, add appropriate logging or error escalation, and verify with tests.',
        });
      }

      // Check for missing await on Promise-returning calls
      if (/\b(?:fs\.promises|fetch|axios|prisma|db\.\w+)\.[a-zA-Z0-9_]+\([^)]*\)/.test(line) && !line.includes('await') && !line.includes('.then') && !line.includes('return')) {
        findings.push({
          id: `BUG-${String(counter++).padStart(3, '0')}`,
          title: `Possible unawaited asynchronous call in ${file.path}`,
          severity: 'CRITICAL',
          category: 'concurrency',
          file: file.path,
          lineStart: lineNum,
          lineEnd: lineNum,
          snippet: line.trim(),
          description: 'Asynchronous promise-returning operation is not awaited, creating an unhandled background execution race condition.',
          trigger: 'Executing code path triggers unhandled Promise or race condition.',
          suggestedFix: `await ${line.trim()}`,
          agentInstructions: 'Add await operator and ensure containing function is marked async.',
        });
      }

      // Check for raw SQL / query injection risks
      if (/(?:query|execute|raw)\s*\(\s*`[^`]*\$\{.*?\}[^`]*`\s*\)/i.test(line)) {
        findings.push({
          id: `BUG-${String(counter++).padStart(3, '0')}`,
          title: `Unescaped template string in query execution in ${file.path}`,
          severity: 'CRITICAL',
          category: 'security',
          file: file.path,
          lineStart: lineNum,
          lineEnd: lineNum,
          snippet: line.trim(),
          description: 'Direct string interpolation into database query allows SQL/command injection.',
          trigger: 'User-controlled input passed into variable interpolated in query string.',
          suggestedFix: 'Use parameterized queries or prepared statements with placeholder variables.',
          agentInstructions: 'Refactor query to use parameterized bindings instead of string interpolation.',
        });
      }

      // Check for off-by-one or unchecked array bounds
      if (/for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<=\s*\w+\.length;\s*i\+\+\s*\)/.test(line)) {
        findings.push({
          id: `BUG-${String(counter++).padStart(3, '0')}`,
          title: `Off-by-one error (<= length) causing undefined index access in ${file.path}`,
          severity: 'HIGH',
          category: 'logic',
          file: file.path,
          lineStart: lineNum,
          lineEnd: lineNum,
          snippet: line.trim(),
          description: 'Loop condition `i <= array.length` accesses array[array.length] on final iteration, resulting in undefined index access.',
          trigger: 'Loop runs through the last index and attempts to access out-of-bounds element.',
          suggestedFix: line.replace('<=', '<'),
          agentInstructions: 'Change `<=` to `<` in the loop condition and test loop bounds.',
        });
      }
    }
  }

  // If no obvious pattern was found, add a clean repo note or mock finding for testing
  if (findings.length === 0) {
    findings.push({
      id: 'BUG-001',
      title: `Potential unhandled error state in entry point`,
      severity: 'LOW',
      category: 'error-handling',
      file: codebase.files[0]?.path || 'package.json',
      lineStart: 1,
      snippet: codebase.files[0]?.path || 'entry',
      description: 'Mock audit inspection: verify process-level uncaughtException and unhandledRejection handlers exist.',
      trigger: 'Unhandled rejected Promise in runtime.',
      suggestedFix: 'process.on("unhandledRejection", (err) => console.error("Unhandled:", err));',
      agentInstructions: 'Verify error boundaries exist for the application entry point.',
    });
  }

  return findings;
}

export async function runAuditWithRotation(
  codebase: ScannedCodebase,
  options: AuditRunOptions = {}
): Promise<AuditResult> {
  const scannedAt = new Date().toISOString();
  const rotationEvents: RotationEvent[] = [];
  const modelsUsed: string[] = [];

  const onProgress = options.onProgress ?? (() => {});

  if (options.mock) {
    onProgress('Running in mock mode (deterministic offline bug hunter)...');
    modelsUsed.push('mock/mock-bug-hunter');
    const mockBugs = createMockAuditFindings(codebase);
    return {
      scannedAt,
      targetDir: codebase.targetDir,
      projectName: codebase.projectName,
      modelsUsed,
      rotationEvents: [],
      bugs: mockBugs,
      codebaseStats: {
        totalFiles: codebase.totalFiles,
        totalLines: codebase.totalLines,
        languages: codebase.languages,
      },
      summary: `Pitstop mock audit scanned ${codebase.totalFiles} files across ${codebase.totalLines} lines. Detected ${mockBugs.length} bug findings across error-handling, concurrency, and logic categories.`,
    };
  }

  // Real model run via ModelHitch
  const resolvedKeys = resolveAvailableKeys();
  const lanes = resolveModelLanes({ models: options.models });

  const keystore = new MemoryKeyStore();
  for (const [provider, key] of Object.entries(resolvedKeys)) {
    await keystore.set(provider, key);
  }

  const handleFailover = (event: FailoverEvent) => {
    const rotEvent: RotationEvent = {
      at: event.at,
      from: { providerId: event.from.providerId, model: event.from.model },
      to: { providerId: event.to.providerId, model: event.to.model },
      reason: `${event.error.code}${event.error.status ? ` HTTP ${event.error.status}` : ''}: ${event.error.message}`,
      attempt: event.attempt,
    };
    rotationEvents.push(rotEvent);
    if (options.onRotation) {
      options.onRotation(rotEvent);
    }
    onProgress(
      `[ModelHitch Rotation] Switched from ${event.from.providerId}/${event.from.model} -> ${event.to.providerId}/${event.to.model} (${rotEvent.reason})`
    );
  };

  const primaryLane = lanes[0] ?? DEFAULT_CODING_MODELS[0]!;
  const fallbackLanes = lanes.slice(1);

  const hitch = new ModelHitch({
    providers: defaultProviders,
    keystore,
    defaultProviderId: primaryLane.providerId,
    defaultModel: primaryLane.model,
    autoMode: {
      lanes: fallbackLanes.map((l) => ({ providerId: l.providerId, model: l.model })),
      maxAttempts: lanes.length + 1,
      onFailover: handleFailover,
    },
    onFailover: handleFailover,
  });

  const prompt = buildAuditPrompt(codebase, {
    modelName: `${primaryLane.providerId}/${primaryLane.model}`,
  });

  const allBugs: BugFinding[] = [];
  let combinedSummary = '';

  // Execute primary pass
  onProgress(`Consulting coding model ${primaryLane.providerId}/${primaryLane.model} (ModelHitch failover rotation armed)...`);
  modelsUsed.push(`${primaryLane.providerId}/${primaryLane.model}`);

  try {
    const result = await hitch.chat({
      provider: primaryLane.providerId,
      model: primaryLane.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature: 0.1,
    });

    const parsed = parseModelBugResponse(extractTextContent(result.message.content));
    combinedSummary = parsed.summary;
    allBugs.push(...parsed.bugs);
  } catch (err: any) {
    onProgress(`Primary model pass failed: ${err.message}. Checking manual lane rotation...`);

    // If autoMode didn't rotate (e.g. invalid key format or non-retried error), walk the remaining lanes manually
    let succeeded = false;
    for (const lane of fallbackLanes) {
      onProgress(`Rotating to fallback coding model: ${lane.providerId}/${lane.model}...`);
      const rotEvent: RotationEvent = {
        at: new Date().toISOString(),
        from: primaryLane,
        to: lane,
        reason: err.message,
        attempt: rotationEvents.length + 1,
      };
      rotationEvents.push(rotEvent);
      modelsUsed.push(`${lane.providerId}/${lane.model}`);

      try {
        const result = await hitch.chat({
          provider: lane.providerId,
          model: lane.model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          temperature: 0.1,
        });

        const parsed = parseModelBugResponse(extractTextContent(result.message.content));
        combinedSummary = parsed.summary;
        allBugs.push(...parsed.bugs);
        succeeded = true;
        break;
      } catch (subErr: any) {
        onProgress(`Lane ${lane.providerId}/${lane.model} failed: ${subErr.message}`);
      }
    }

    if (!succeeded) {
      onProgress('All live models failed or exhausted. Falling back to local pattern hunter...');
      modelsUsed.push('mock/local-fallback');
      const fallbackFindings = createMockAuditFindings(codebase);
      allBugs.push(...fallbackFindings);
      combinedSummary = `Live model rotation exhausted across ${lanes.length} lanes (${err.message}). Evaluated codebase using local Pitstop bug patterns.`;
    }
  }

  // Multi-pass rotation if requested
  if (options.multi && lanes.length > 1) {
    const secondLane = lanes[1]!;
    onProgress(`Running secondary rotation pass with ${secondLane.providerId}/${secondLane.model}...`);
    if (!modelsUsed.includes(`${secondLane.providerId}/${secondLane.model}`)) {
      modelsUsed.push(`${secondLane.providerId}/${secondLane.model}`);
    }

    try {
      const secondaryPrompt = buildAuditPrompt(codebase, {
        focus: 'Focus specifically on edge-case concurrency traps, security holes, and unhandled promise rejections.',
        modelName: `${secondLane.providerId}/${secondLane.model}`,
      });

      const secondaryResult = await hitch.chat({
        provider: secondLane.providerId,
        model: secondLane.model,
        messages: [
          { role: 'system', content: secondaryPrompt.system },
          { role: 'user', content: secondaryPrompt.user },
        ],
        temperature: 0.2,
      });

      const secondParsed = parseModelBugResponse(extractTextContent(secondaryResult.message.content));
      // Deduplicate bugs by file and lineStart
      for (const bug of secondParsed.bugs) {
        const isDuplicate = allBugs.some(
          (existing) =>
            existing.file === bug.file &&
            existing.lineStart &&
            bug.lineStart &&
            Math.abs(existing.lineStart - bug.lineStart) <= 2
        );
        if (!isDuplicate) {
          bug.id = `BUG-${String(allBugs.length + 1).padStart(3, '0')}`;
          allBugs.push(bug);
        }
      }
      combinedSummary += ` Secondary review completed by ${secondLane.providerId}/${secondLane.model}.`;
    } catch (e: any) {
      onProgress(`Secondary pass skipped: ${e.message}`);
    }
  }

  // Normalize bug IDs sequentially
  allBugs.forEach((bug, index) => {
    bug.id = `BUG-${String(index + 1).padStart(3, '0')}`;
  });

  return {
    scannedAt,
    targetDir: codebase.targetDir,
    projectName: codebase.projectName,
    modelsUsed,
    rotationEvents,
    bugs: allBugs,
    codebaseStats: {
      totalFiles: codebase.totalFiles,
      totalLines: codebase.totalLines,
      languages: codebase.languages,
    },
    summary: combinedSummary || `Audit complete across ${codebase.totalFiles} files.`,
  };
}
