export type BugSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type BugCategory =
  | 'logic'
  | 'runtime'
  | 'concurrency'
  | 'security'
  | 'contract'
  | 'error-handling'
  | 'syntax';

export interface BugFinding {
  id: string;
  title: string;
  severity: BugSeverity;
  category: BugCategory;
  file: string;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  description: string;
  trigger: string;
  suggestedFix: string;
  agentInstructions: string;
}

export interface ScannedFile {
  path: string;
  fullPath: string;
  size: number;
  lines: number;
  language: string;
  content: string;
  isEntryOrConfig: boolean;
}

export interface ScannedCodebase {
  targetDir: string;
  projectName: string;
  files: ScannedFile[];
  totalFiles: number;
  totalLines: number;
  languages: Record<string, number>;
  fileTree: string;
  summary: string;
}

export interface ScanOptions {
  maxFiles?: number;
  maxFileSizeKb?: number;
  includeTests?: boolean;
  ignoredPatterns?: string[];
  allowedExtensions?: string[];
}

export interface ModelLane {
  providerId: string;
  model: string;
}

export interface RotationEvent {
  at: string;
  from: ModelLane;
  to: ModelLane;
  reason: string;
  attempt: number;
}

export interface AuditResult {
  scannedAt: string;
  targetDir: string;
  projectName: string;
  modelsUsed: string[];
  rotationEvents: RotationEvent[];
  bugs: BugFinding[];
  codebaseStats: {
    totalFiles: number;
    totalLines: number;
    languages: Record<string, number>;
  };
  summary: string;
  rawModelResponse?: string;
}

export interface HandoffOptions {
  outputPath?: string;
  includeJson?: boolean;
  createArchiveCopy?: boolean;
}

export interface HandoffResult {
  markdown: string;
  savedPath: string;
  archivePath?: string;
  jsonPath?: string;
  bugsCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}
