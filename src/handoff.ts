import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AuditResult, BugFinding, HandoffOptions, HandoffResult } from './types.js';

export function formatHandoffMarkdown(result: AuditResult): string {
  const { scannedAt, targetDir, projectName, modelsUsed, rotationEvents, bugs, codebaseStats, summary } = result;

  const criticalBugs = bugs.filter((b) => b.severity === 'CRITICAL');
  const highBugs = bugs.filter((b) => b.severity === 'HIGH');
  const mediumBugs = bugs.filter((b) => b.severity === 'MEDIUM');
  const lowBugs = bugs.filter((b) => b.severity === 'LOW');

  let healthStatus = '🟢 CLEAN (No obvious bugs found)';
  if (criticalBugs.length > 0) {
    healthStatus = '🔴 CRITICAL ATTENTION REQUIRED';
  } else if (highBugs.length > 0) {
    healthStatus = '🟠 HIGH PRIORITY FIXES NEEDED';
  } else if (mediumBugs.length > 0) {
    healthStatus = '🟡 MODERATE ATTENTION RECOMMENDED';
  } else if (lowBugs.length > 0) {
    healthStatus = '🔵 LOW RISK FINDINGS';
  }

  const lines: string[] = [];

  lines.push('# 🛑 Pitstop Bug Audit & Agent Handoff');
  lines.push('');
  lines.push(`> **Project:** \`${projectName}\` | **Scanned At:** \`${scannedAt}\` | **Status:** **${healthStatus}**`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 📋 Executive Summary');
  lines.push('');
  lines.push(summary);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| **Target Directory** | \`${targetDir}\` |`);
  lines.push(`| **Models Rotated** | ${modelsUsed.map((m) => `\`${m}\``).join(' → ') || 'None'} |`);
  lines.push(`| **Files Scanned** | ${codebaseStats.totalFiles} files (${codebaseStats.totalLines} lines) |`);
  lines.push(`| **Total Bugs Found** | **${bugs.length}** |`);
  lines.push(`| **Critical Severity** | **${criticalBugs.length}** |`);
  lines.push(`| **High Severity** | **${highBugs.length}** |`);
  lines.push(`| **Medium Severity** | **${mediumBugs.length}** |`);
  lines.push(`| **Low Severity** | **${lowBugs.length}** |`);
  lines.push('');

  if (rotationEvents.length > 0) {
    lines.push('### 🔄 Model Rotation History');
    lines.push('');
    for (const ev of rotationEvents) {
      lines.push(`- **Attempt ${ev.attempt}:** Switched from \`${ev.from.providerId}/${ev.from.model}\` to \`${ev.to.providerId}/${ev.to.model}\` — *${ev.reason}* (${ev.at})`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 🤖 Prompt for the Next Agent');
  lines.push('');
  lines.push('Copy and paste this prompt directly to hand off these bug fixes to another coding agent:');
  lines.push('');
  lines.push('```markdown');
  lines.push('You are tasked with resolving all bugs identified by Pitstop.');
  lines.push(`Target repository: ${projectName}`);
  lines.push(`Total bugs to fix: ${bugs.length} (${criticalBugs.length} Critical, ${highBugs.length} High, ${mediumBugs.length} Medium, ${lowBugs.length} Low)`);
  lines.push('');
  lines.push('Please follow these instructions:');
  lines.push('1. Review each bug in the checklist below in order of severity (CRITICAL -> HIGH -> MEDIUM -> LOW).');
  lines.push('2. Open the affected file and inspect the surrounding code context.');
  lines.push('3. Implement the suggested fix or a safer equivalent.');
  lines.push('4. Write or update tests to verify the bug is eliminated without regressions.');
  lines.push('5. Mark off each item in the checklist as you complete it.');
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 🎯 Action Checklist for Next Agent');
  lines.push('');

  if (bugs.length === 0) {
    lines.push('✅ No obvious bugs found in this codebase scan! All clear.');
    lines.push('');
  } else {
    for (const b of bugs) {
      const lineRef = b.lineStart ? `:${b.lineStart}` : '';
      lines.push(`- [ ] **[${b.id}]** \`[${b.severity}]\` **${b.title}** in \`${b.file}${lineRef}\``);
    }
    lines.push('');

    lines.push('---');
    lines.push('');
    lines.push('## 🔍 Detailed Bug Findings');
    lines.push('');

    for (const b of bugs) {
      const lineRef = b.lineStart ? (b.lineEnd ? `lines ${b.lineStart}–${b.lineEnd}` : `line ${b.lineStart}`) : 'entire file';
      const severityIcon = b.severity === 'CRITICAL' ? '🔴' : b.severity === 'HIGH' ? '🟠' : b.severity === 'MEDIUM' ? '🟡' : '🔵';

      lines.push(`### ${severityIcon} [${b.id}] ${b.title}`);
      lines.push('');
      lines.push(`- **Severity:** \`${b.severity}\``);
      lines.push(`- **Category:** \`${b.category}\``);
      lines.push(`- **File:** \`${b.file}\` (${lineRef})`);
      lines.push('');
      lines.push('#### Description');
      lines.push(b.description);
      lines.push('');
      lines.push('#### Trigger Condition');
      lines.push(`> ${b.trigger}`);
      lines.push('');

      if (b.snippet) {
        lines.push('#### Problematic Code');
        lines.push('```');
        lines.push(b.snippet);
        lines.push('```');
        lines.push('');
      }

      lines.push('#### Suggested Fix');
      lines.push('```');
      lines.push(b.suggestedFix);
      lines.push('```');
      lines.push('');

      lines.push('#### Instructions for Next Agent');
      lines.push(b.agentInstructions);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  lines.push('## 📦 Machine-Readable Handoff Data');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(
    {
      pitstopVersion: '0.1.0',
      scannedAt,
      targetDir,
      projectName,
      modelsUsed,
      stats: codebaseStats,
      bugs,
    },
    null,
    2
  ));
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

export function saveHandoffReport(
  result: AuditResult,
  options: HandoffOptions = {}
): HandoffResult {
  const markdown = formatHandoffMarkdown(result);

  const defaultFile = 'pitstop-handoff.md';
  const targetPath = options.outputPath ? resolve(options.outputPath) : resolve(result.targetDir, defaultFile);

  const parentDir = dirname(targetPath);
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(targetPath, markdown, 'utf8');

  let archivePath: string | undefined;
  if (options.createArchiveCopy ?? true) {
    const timeSafe = result.scannedAt.replace(/[:.]/g, '-');
    const archiveDir = resolve(result.targetDir, '.pitstop');
    mkdirSync(archiveDir, { recursive: true });
    archivePath = resolve(archiveDir, `handoff-${timeSafe}.md`);
    try {
      writeFileSync(archivePath, markdown, 'utf8');
    } catch {
      // ignore optional archive write errors
    }
  }

  let jsonPath: string | undefined;
  if (options.includeJson) {
    jsonPath = targetPath.replace(/\.md$/i, '.json');
    const jsonData = {
      pitstopVersion: '0.1.0',
      scannedAt: result.scannedAt,
      targetDir: result.targetDir,
      projectName: result.projectName,
      modelsUsed: result.modelsUsed,
      stats: result.codebaseStats,
      bugs: result.bugs,
    };
    writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
  }

  const criticalCount = result.bugs.filter((b) => b.severity === 'CRITICAL').length;
  const highCount = result.bugs.filter((b) => b.severity === 'HIGH').length;
  const mediumCount = result.bugs.filter((b) => b.severity === 'MEDIUM').length;
  const lowCount = result.bugs.filter((b) => b.severity === 'LOW').length;

  return {
    markdown,
    savedPath: targetPath,
    archivePath,
    jsonPath,
    bugsCount: result.bugs.length,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  };
}
