export { PITSTOP_ASCII_LOGO, PITSTOP_BANNER } from './ascii.js';
export { scanDirectory } from './scanner.js';
export {
  runAuditWithRotation,
  resolveModelLanes,
  resolveAvailableKeys,
  DEFAULT_CODING_MODELS,
  type AuditRunOptions,
} from './model-rotator.js';
export {
  AUDIT_SYSTEM_PROMPT,
  buildAuditPrompt,
  parseModelBugResponse,
} from './prompt.js';
export { formatHandoffMarkdown, saveHandoffReport } from './handoff.js';
export type {
  BugSeverity,
  BugCategory,
  BugFinding,
  ScannedFile,
  ScannedCodebase,
  ScanOptions,
  ModelLane,
  RotationEvent,
  AuditResult,
  HandoffOptions,
  HandoffResult,
} from './types.js';
