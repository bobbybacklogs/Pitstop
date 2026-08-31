import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { ScanOptions, ScannedCodebase, ScannedFile } from './types.js';

const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  '.github',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.turbo',
  '.pitstop',
  '.idea',
  '.vscode',
  'vendor',
  'bin',
  'obj',
  'target',
  'tmp',
  'temp',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.yarn',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.pyc',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.db', '.sqlite', '.sqlite3',
]);

const LOCK_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',
]);

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript (React)',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript (React)',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.c': 'C',
  '.cpp': 'C++',
  '.h': 'C/C++ Header',
  '.hpp': 'C++ Header',
  '.cs': 'C#',
  '.php': 'PHP',
  '.rb': 'Ruby',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.ps1': 'PowerShell',
  '.md': 'Markdown',
  '.sql': 'SQL',
};

export const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z-_]{30,45}/g,
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /(?:api[_-]?key|secret|password|auth[_-]?token)\s*[:=]\s*["']([^"']{8,})["']/gi,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    const rx = new RegExp(pattern.source, pattern.flags);
    redacted = redacted.replace(rx, (...args) => {
      const match = args[0] as string;
      const captures = args.slice(1, -2);
      if (captures.length > 0 && typeof captures[0] === 'string' && captures[0]) {
        return match.replace(captures[0], '[[REDACTED_SECRET]]');
      }
      return '[[REDACTED_API_KEY]]';
    });
  }
  return redacted;
}

function parseGitignore(targetDir: string): string[] {
  const gitignorePath = join(targetDir, '.gitignore');
  if (!existsSync(gitignorePath)) return [];
  try {
    const content = readFileSync(gitignorePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function isGitignored(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    const cleanPat = pattern.replace(/\/$/, '');
    if (cleanPat.startsWith('*.')) {
      const ext = cleanPat.slice(1);
      if (normalized.endsWith(ext)) return true;
    } else if (cleanPat.startsWith('/')) {
      const rootPat = cleanPat.slice(1);
      if (normalized === rootPat || normalized.startsWith(rootPat + '/')) return true;
    } else {
      if (normalized === cleanPat || normalized.startsWith(cleanPat + '/') || normalized.includes('/' + cleanPat + '/') || normalized.endsWith('/' + cleanPat)) {
        return true;
      }
    }
  }
  return false;
}

function isEntryOrConfigFile(relPath: string): boolean {
  const lower = relPath.toLowerCase().replace(/\\/g, '/');
  const base = basename(lower);
  return (
    base === 'package.json' ||
    base === 'tsconfig.json' ||
    base === 'pyproject.toml' ||
    base === 'cargo.toml' ||
    base.startsWith('index.') ||
    base.startsWith('main.') ||
    base.startsWith('app.') ||
    base.startsWith('cli.') ||
    base.startsWith('server.') ||
    lower.startsWith('src/index.') ||
    lower.startsWith('src/main.') ||
    lower.startsWith('src/cli.')
  );
}

export function scanDirectory(
  targetDir: string,
  options: ScanOptions = {}
): ScannedCodebase {
  const resolvedDir = resolve(targetDir);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Target directory does not exist: ${resolvedDir}`);
  }

  const gitignorePatterns = parseGitignore(resolvedDir);
  const maxFiles = options.maxFiles ?? 60;
  const maxFileSizeKb = options.maxFileSizeKb ?? 250;
  const maxFileSizeBytes = maxFileSizeKb * 1024;
  const projectName = basename(resolvedDir) || 'workspace';

  const collectedFiles: string[] = [];

  function walk(currentDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const relPath = relative(resolvedDir, fullPath);

      if (DEFAULT_IGNORE_DIRS.has(entry)) continue;
      if (LOCK_FILES.has(entry)) continue;
      if (isGitignored(relPath, gitignorePatterns)) continue;
      if (options.ignoredPatterns && isGitignored(relPath, options.ignoredPatterns)) continue;

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        if (options.allowedExtensions && !options.allowedExtensions.includes(ext)) continue;
        if (stat.size > maxFileSizeBytes) continue;

        collectedFiles.push(fullPath);
      }
    }
  }

  walk(resolvedDir);

  // Sort files: entry points and configs first, then main source files, then others
  collectedFiles.sort((a, b) => {
    const relA = relative(resolvedDir, a);
    const relB = relative(resolvedDir, b);
    const isEntryA = isEntryOrConfigFile(relA);
    const isEntryB = isEntryOrConfigFile(relB);

    if (isEntryA && !isEntryB) return -1;
    if (!isEntryA && isEntryB) return 1;

    // Prefer shorter paths (shallower in directory tree)
    const depthA = relA.split(/[\\/]/).length;
    const depthB = relB.split(/[\\/]/).length;
    if (depthA !== depthB) return depthA - depthB;

    return relA.localeCompare(relB);
  });

  const selectedPaths = collectedFiles.slice(0, maxFiles);
  const scannedFiles: ScannedFile[] = [];
  const languages: Record<string, number> = {};
  let totalLines = 0;

  for (const filePath of selectedPaths) {
    const relPath = relative(resolvedDir, filePath).replace(/\\/g, '/');
    let rawContent: string;
    try {
      rawContent = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const ext = extname(filePath).toLowerCase();
    const language = EXTENSION_LANGUAGE_MAP[ext] || 'Text';
    const lines = rawContent.split(/\r?\n/).length;
    const content = redactSecrets(rawContent);

    languages[language] = (languages[language] || 0) + 1;
    totalLines += lines;

    scannedFiles.push({
      path: relPath,
      fullPath: filePath,
      size: Buffer.byteLength(content, 'utf8'),
      lines,
      language,
      content,
      isEntryOrConfig: isEntryOrConfigFile(relPath),
    });
  }

  // Build tree representation
  const treeLines: string[] = [`${projectName}/`];
  for (const file of scannedFiles) {
    treeLines.push(`  ├─ ${file.path} (${file.language}, ${file.lines} lines)`);
  }
  const fileTree = treeLines.join('\n');

  const topLanguages = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${lang} (${count} files)`)
    .join(', ');

  const summary = `${projectName}: ${scannedFiles.length} files scanned (${totalLines} lines). Languages: ${topLanguages || 'None'}.`;

  return {
    targetDir: resolvedDir,
    projectName,
    files: scannedFiles,
    totalFiles: scannedFiles.length,
    totalLines,
    languages,
    fileTree,
    summary,
  };
}
