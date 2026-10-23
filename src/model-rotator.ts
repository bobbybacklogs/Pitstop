import {
  ModelHitch,
  MemoryKeyStore,
  readConfigFile,
  defaultProviders,
  DEFAULT_FAILOVER_LANES,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL,
  isMaskedSecret,
  isModelHitchError,
  policyFromConfig,
  buildCooldownFromConfig,
  buildCatalogOptions,
  customLaneProviders,
  openCodeByokProviders,
  chatGptPlanProviders,
  applyCustomLanesPlan,
  applyOpenCodeByokPlan,
  applyChatGptPlanPlan,
  ChatGptPlanAuth,
  defaultChatGptPlanCredentialsPath,
  listChatGptPlanAccountModels,
  readOpenCodeLocalState,
  type FailoverEvent,
  type ContentPart,
  type ModelHitchConfig,
  type Policy,
  type Provider,
  type Usage,
  type OpenCodeLocalState,
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
  /** Override the provider registry (useful for tests / custom integrations). */
  providers?: Provider[];
  onRotation?: (event: RotationEvent) => void;
  onProgress?: (message: string) => void;
}

/** Default coding lanes aligned with ModelHitch V2 (Vercel AI Gateway first). */
export const DEFAULT_CODING_MODELS: ModelLane[] = [
  { providerId: 'vercel-ai-gateway', model: VERCEL_AI_GATEWAY_DEFAULT_MODEL },
  ...DEFAULT_FAILOVER_LANES,
];

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
        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

function readModelhitchConfig(): ModelHitchConfig | null {
  try {
    return readConfigFile(getModelhitchConfigPath());
  } catch {
    return null;
  }
}

export function resolveAvailableKeys(): Record<string, string> {
  const keys: Record<string, string> = {};

  // Read from ~/.modelhitch/config.json if present. The SDK itself resolves
  // provider env vars (explicit > keystore > env fallback), so we only need to
  // seed the keystore with whatever real (non-masked) keys the config holds.
  const config = readModelhitchConfig();
  if (config?.keys) {
    for (const [provider, key] of Object.entries(config.keys)) {
      if (key && typeof key === 'string' && !isMaskedSecret(key)) {
        keys[provider] = key;
      }
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
    providerId: 'vercel-ai-gateway',
    model: raw.trim(),
  };
}

function safeReadOpenCodeState(): OpenCodeLocalState | undefined {
  try {
    return readOpenCodeLocalState();
  } catch {
    return undefined;
  }
}

function composePlan(config: ModelHitchConfig | null, accountModels: string[] = []) {
  const basePolicy = config ? policyFromConfig(config) : undefined;
  let plan = applyOpenCodeByokPlan({
    config: config ?? undefined,
    policy: basePolicy,
    defaultProviderId: config?.defaultProviderId,
    defaultModel: config?.defaultModel,
    state: config?.opencodeByok?.syncFromOpenCode ? safeReadOpenCodeState() : undefined,
  });
  plan = applyCustomLanesPlan({
    config: config ?? undefined,
    policy: plan.policy,
    defaultProviderId: plan.defaultProviderId,
    defaultModel: plan.defaultModel,
  });
  const composed = applyChatGptPlanPlan({
    config: config ?? undefined,
    policy: plan.policy,
    defaultProviderId: plan.defaultProviderId,
    defaultModel: plan.defaultModel,
    accountModels,
  });
  return {
    policy: composed.policy,
    defaultProviderId: composed.defaultProviderId,
    defaultModel: composed.defaultModel,
  };
}

function buildProviders(config: ModelHitchConfig | null, accountModels: string[] = []): Provider[] {
  const providers = [...defaultProviders];
  const merge = (ps: Provider[]) => {
    for (const p of ps) {
      if (!providers.some((x) => x.id === p.id)) providers.push(p);
    }
  };
  merge(openCodeByokProviders(config ?? undefined));
  merge(customLaneProviders(config ?? undefined));
  try {
    const auth = new ChatGptPlanAuth({ path: defaultChatGptPlanCredentialsPath() });
    merge(chatGptPlanProviders(config ?? undefined, { tokens: auth, accountModels }));
  } catch {
    // ignore — lane just won't be routable
  }
  return providers;
}

function lanesFromPolicy(policy: Policy, providers: Provider[] = defaultProviders): ModelLane[] {
  const lanes: ModelLane[] = [];
  const providersById = new Map(providers.map((p) => [p.id, p] as const));
  const pushEntry = (entry: { providerId: string; models?: string[] }) => {
    const provider = providersById.get(entry.providerId);
    const models =
      entry.models && entry.models.length > 0
        ? entry.models
        : [provider?.defaultModel ?? VERCEL_AI_GATEWAY_DEFAULT_MODEL];
    for (const model of models) {
      lanes.push({ providerId: entry.providerId, model });
    }
  };

  for (const entry of policy.trusted ?? []) pushEntry(entry);
  for (const entry of policy.fallback ?? []) pushEntry(entry);
  return lanes;
}

export function resolveModelLanes(options: { models?: string[] } = {}): ModelLane[] {
  if (options.models && options.models.length > 0) {
    return options.models.map(parseModelLane);
  }

  const config = readModelhitchConfig();
  const { policy, defaultProviderId, defaultModel } = composePlan(config);
  if (policy) {
    const providers = buildProviders(config);
    const lanes = lanesFromPolicy(policy, providers);
    if (lanes.length > 0) {
      return lanes;
    }
  }

  if (defaultProviderId && defaultModel) {
    return [{ providerId: defaultProviderId, model: defaultModel }];
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

function formatError(err: unknown): string {
  if (isModelHitchError(err)) {
    const status = err.status ? ` HTTP ${err.status}` : '';
    const prov = err.providerId ? ` [${err.providerId}]` : '';
    const retry = err.retryAfterMs ? ` (retry after ${Math.ceil(err.retryAfterMs / 1000)}s)` : '';
    return `${err.code}${status}${prov}: ${err.message}${retry}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
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

  // Real model run via ModelHitch V2
  // When a provider registry is injected (e.g. tests), stay fully isolated from
  // the user's ~/.modelhitch config so policy validation can't trip over
  // providers that aren't in the injected set.
  const config = options.providers ? null : readModelhitchConfig();
  const resolvedKeys = options.providers ? {} : resolveAvailableKeys();

  const keystore = new MemoryKeyStore();
  for (const [provider, key] of Object.entries(resolvedKeys)) {
    await keystore.set(provider, key);
  }

  // ChatGPT plan account models (best-effort; lane won't serve if unavailable).
  let chatgptAccountModels: string[] = [];
  if (config?.chatgptPlan?.enabled) {
    try {
      const auth = new ChatGptPlanAuth({ path: defaultChatGptPlanCredentialsPath() });
      chatgptAccountModels = await listChatGptPlanAccountModels({ tokens: auth });
    } catch {
      chatgptAccountModels = [];
    }
  }

  const { policy: finalPolicy, defaultProviderId: composedDefaultProviderId, defaultModel: composedDefaultModel } =
    composePlan(config, chatgptAccountModels);
  const providers = options.providers ?? buildProviders(config, chatgptAccountModels);

  const lanes = (() => {
    if (options.models && options.models.length > 0) {
      return options.models.map(parseModelLane);
    }
    if (finalPolicy) {
      const resolved = lanesFromPolicy(finalPolicy, providers);
      if (resolved.length > 0) return resolved;
    }
    if (composedDefaultProviderId && composedDefaultModel) {
      return [{ providerId: composedDefaultProviderId, model: composedDefaultModel }];
    }
    return [...DEFAULT_CODING_MODELS];
  })();

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

  const passProviders = options.providers ? providers : (providers.length > defaultProviders.length ? providers : undefined);

  const hitch = await ModelHitch.create({
    providers: passProviders,
    keystore,
    defaultProviderId: primaryLane.providerId,
    defaultModel: primaryLane.model,
    ...(finalPolicy
      ? { policy: finalPolicy }
      : {
          autoMode:
            fallbackLanes.length > 0
              ? {
                  lanes: fallbackLanes.map((l) => ({
                    providerId: l.providerId,
                    model: l.model,
                  })),
                  maxAttempts: lanes.length + 1,
                }
              : true,
        }),
    onFailover: handleFailover,
    intents: config?.intents,
    cooldown: buildCooldownFromConfig({ cooldown: config?.cooldown }),
    ...buildCatalogOptions({ catalog: config?.catalog }) ? { catalog: buildCatalogOptions({ catalog: config?.catalog }) } : {},
  });

  const prompt = buildAuditPrompt(codebase, {
    modelName: `${primaryLane.providerId}/${primaryLane.model}`,
  });

  const allBugs: BugFinding[] = [];
  let combinedSummary = '';
  let truncated = false;
  const laneUsage: Array<{ model: string; inputTokens: number; outputTokens: number; totalTokens: number }> = [];
  const addUsage = (lane: string, usage?: Usage) => {
    if (!usage) return;
    laneUsage.push({
      model: lane,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
    });
  };

  let primaryServingLane: ModelLane | null = null;
  const primaryFailedKeys = new Set<string>();
  const laneKey = (l: ModelLane) => `${l.providerId}/${l.model}`;

  // Execute primary pass
  onProgress(
    `Consulting coding model ${primaryLane.providerId}/${primaryLane.model} (ModelHitch ${finalPolicy ? 'policy' : 'autoMode'} armed)...`
  );
  modelsUsed.push(`${primaryLane.providerId}/${primaryLane.model}`);

  const rotMark = rotationEvents.length;

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

    let serving = primaryLane;
    for (let i = rotMark; i < rotationEvents.length; i++) {
      const ev = rotationEvents[i]!;
      serving = { providerId: ev.to.providerId, model: ev.to.model };
    }
    primaryServingLane = serving;
    addUsage(`${serving.providerId}/${serving.model}`, result.usage);
    if (result.finishReason === 'length') truncated = true;

    const parsed = parseModelBugResponse(extractTextContent(result.message.content));
    combinedSummary = parsed.summary;
    allBugs.push(...parsed.bugs);
  } catch (err: unknown) {
    const errMessage = formatError(err);
    onProgress(`Primary model pass failed: ${errMessage}. Checking manual lane rotation...`);

    // If autoMode/policy didn't rotate (e.g. non-retryable error), walk remaining lanes manually
    let succeeded = false;
    for (const lane of fallbackLanes) {
      onProgress(`Rotating to fallback coding model: ${lane.providerId}/${lane.model}...`);
      const rotEvent: RotationEvent = {
        at: new Date().toISOString(),
        from: primaryLane,
        to: lane,
        reason: errMessage,
        attempt: rotationEvents.length + 1,
      };
      rotationEvents.push(rotEvent);
      if (options.onRotation) {
        options.onRotation(rotEvent);
      }
      onProgress(
        `[ModelHitch Rotation] Switched from ${primaryLane.providerId}/${primaryLane.model} -> ${lane.providerId}/${lane.model} (${rotEvent.reason})`
      );
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

        addUsage(`${lane.providerId}/${lane.model}`, result.usage);
        if (result.finishReason === 'length') truncated = true;
        const parsed = parseModelBugResponse(extractTextContent(result.message.content));
        combinedSummary = parsed.summary;
        allBugs.push(...parsed.bugs);
        primaryServingLane = lane;
        succeeded = true;
        break;
      } catch (subErr: unknown) {
        onProgress(`Lane ${lane.providerId}/${lane.model} failed: ${formatError(subErr)}`);
        primaryFailedKeys.add(laneKey(lane));
      }
    }

    primaryFailedKeys.add(laneKey(primaryLane));

    if (!succeeded) {
      onProgress('All live models failed or exhausted. Falling back to local pattern hunter...');
      modelsUsed.push('mock/local-fallback');
      const fallbackFindings = createMockAuditFindings(codebase);
      allBugs.push(...fallbackFindings);
      combinedSummary = `Live model rotation exhausted across ${lanes.length} lanes (${errMessage}). Evaluated codebase using local Pitstop bug patterns.`;
    }
  }

  // Multi-pass rotation if requested: run the security-focused pass on every
  // remaining lane (not just the first), aggregating + deduplicating findings.
  if (options.multi && lanes.length > 1) {
    const skipKeys = new Set(primaryFailedKeys);
    if (primaryServingLane) skipKeys.add(laneKey(primaryServingLane));
    const multiLanes = lanes.filter((l) => !skipKeys.has(laneKey(l)));

    if (multiLanes.length === 0) {
      onProgress('Multi-pass skipped: all lanes exhausted in primary pass.');
    } else {
      for (const secondLane of multiLanes) {
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

          addUsage(`${secondLane.providerId}/${secondLane.model}`, secondaryResult.usage);
          if (secondaryResult.finishReason === 'length') truncated = true;

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
        } catch (e: unknown) {
          onProgress(`Secondary pass skipped: ${formatError(e)}`);
        }
      }
    }
  }

  // Normalize bug IDs sequentially
  allBugs.forEach((bug, index) => {
    bug.id = `BUG-${String(index + 1).padStart(3, '0')}`;
  });

  const totalUsage = laneUsage.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );

  if (truncated) {
    onProgress('Warning: at least one model response was truncated (finishReason: length).');
    combinedSummary = combinedSummary
      ? `${combinedSummary} Warning: at least one model response was truncated.`
      : 'Warning: at least one model response was truncated.';
  }

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
    usage: laneUsage.length > 0
      ? {
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          totalTokens: totalUsage.totalTokens,
          byModel: laneUsage,
        }
      : undefined,
    truncated: truncated || undefined,
  };
}