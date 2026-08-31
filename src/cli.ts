#!/usr/bin/env node

import { Command } from 'commander';
import pc from 'picocolors';
import { PITSTOP_ASCII_LOGO, PITSTOP_BANNER } from './ascii.js';
import { scanDirectory } from './scanner.js';
import { runAuditWithRotation, resolveModelLanes } from './model-rotator.js';
import { saveHandoffReport } from './handoff.js';
import { resolve } from 'node:path';

const program = new Command();

program
  .name('pitstop')
  .description('One job: scan current directory, rotate coding models via ModelHitch, hunt for obvious and uncaught bugs, and generate an agent handoff report.')
  .version('0.1.0')
  .argument('[directory]', 'Target directory to scan', '.')
  .option('-o, --output <path>', 'Custom path to save the agent handoff markdown report')
  .option('-m, --models <models>', 'Comma-separated provider/model targets (e.g. "opencode-zen/big-pickle,deepseek/deepseek-v4-flash")')
  .option('--multi', 'Run multi-model rotation pass (aggregates findings across models)', false)
  .option('--mock', 'Run in deterministic offline mode without API keys', false)
  .option('--json', 'Save a companion pitstop-handoff.json file', false)
  .option('--max-files <number>', 'Maximum files to scan', '60')
  .option('-v, --verbose', 'Show detailed scan and rotation logs', false)
  .action(async (targetDirArg: string, opts: any) => {
    try {
      const targetDir = resolve(targetDirArg);
      const maxFiles = parseInt(opts.maxFiles, 10) || 60;
      const modelsList = opts.models
        ? opts.models.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;

      console.log(pc.cyan(PITSTOP_ASCII_LOGO));
      console.log(pc.bold(pc.white(` ${PITSTOP_BANNER}`)));
      console.log(pc.dim(` Version 0.1.0 | ModelHitch BYOK Model Rotation\n`));

      // 1. Scan codebase
      console.log(pc.bold(pc.blue(`[1/4] 🔍 Scanning codebase...`)));
      console.log(pc.dim(`      Target: ${targetDir}`));

      const codebase = scanDirectory(targetDir, { maxFiles });

      console.log(
        pc.green(
          `      ✓ Scanned ${pc.bold(codebase.totalFiles)} files across ${pc.bold(codebase.totalLines)} lines of code`
        )
      );

      const topLangs = Object.entries(codebase.languages)
        .slice(0, 4)
        .map(([l, count]) => `${l} (${count})`)
        .join(', ');
      if (topLangs) {
        console.log(pc.dim(`      Languages: ${topLangs}`));
      }

      if (opts.verbose) {
        console.log(pc.dim(`\nFiles scanned:\n${codebase.fileTree}\n`));
      }

      // 2. Model Rotation configuration
      console.log(pc.bold(pc.blue(`\n[2/4] 🔄 Preparing ModelHitch coding model rotation...`)));

      if (opts.mock) {
        console.log(pc.yellow(`      ⚡ Mode: Mock Bug Hunter (deterministic offline execution)`));
      } else {
        const lanes = resolveModelLanes({ models: modelsList });
        const primary = lanes[0];
        const fallbacks = lanes.slice(1);

        console.log(pc.cyan(`      Primary model : ${pc.bold(`${primary?.providerId}/${primary?.model}`)}`));
        if (fallbacks.length > 0) {
          console.log(
            pc.dim(
              `      Fallback lanes: ${fallbacks.map((f) => `${f.providerId}/${f.model}`).join(' → ')}`
            )
          );
        }
        if (opts.multi) {
          console.log(pc.magenta(`      Multi-pass rotation: ACTIVE (combining multi-model findings)`));
        }
      }

      // 3. Hunting bugs with ModelHitch
      console.log(pc.bold(pc.blue(`\n[3/4] ⚡ Hunting for obvious & uncaught bugs...`)));

      const auditResult = await runAuditWithRotation(codebase, {
        models: modelsList,
        mock: opts.mock,
        multi: opts.multi,
        verbose: opts.verbose,
        onProgress: (msg: string) => {
          console.log(pc.dim(`      ${msg}`));
        },
        onRotation: (ev) => {
          console.log(
            pc.yellow(
              `      ↻ [Rotation] Switched to ${ev.to.providerId}/${ev.to.model} (Reason: ${ev.reason})`
            )
          );
        },
      });

      console.log(
        pc.green(`      ✓ Audit completed! Discovered ${pc.bold(auditResult.bugs.length)} bug findings.`)
      );

      // 4. Save handoff report
      console.log(pc.bold(pc.blue(`\n[4/4] 📋 Compiling agent handoff report...`)));

      const handoffResult = saveHandoffReport(auditResult, {
        outputPath: opts.output,
        includeJson: opts.json,
      });

      // Display findings breakdown
      console.log('\n' + pc.cyan('═'.repeat(70)));
      console.log(pc.bold(pc.white(` 🏁 PITSTOP AUDIT RESULTS: ${codebase.projectName}`)));
      console.log(pc.cyan('═'.repeat(70)));

      if (auditResult.bugs.length === 0) {
        console.log(pc.green(`\n  ✅ All clean! No obvious or uncaught bugs were found.\n`));
      } else {
        console.log(
          `  Total Bugs: ${pc.bold(auditResult.bugs.length)} | ` +
            pc.red(`CRITICAL: ${handoffResult.criticalCount}`) +
            ' | ' +
            pc.yellow(`HIGH: ${handoffResult.highCount}`) +
            ' | ' +
            pc.cyan(`MEDIUM: ${handoffResult.mediumCount}`) +
            ' | ' +
            pc.dim(`LOW: ${handoffResult.lowCount}`) +
            '\n'
        );

        for (const b of auditResult.bugs) {
          const badge =
            b.severity === 'CRITICAL'
              ? pc.bgRed(pc.white(' CRITICAL '))
              : b.severity === 'HIGH'
              ? pc.bgYellow(pc.black(' HIGH '))
              : b.severity === 'MEDIUM'
              ? pc.bgCyan(pc.black(' MEDIUM '))
              : pc.bgWhite(pc.black(' LOW '));

          const lineRef = b.lineStart ? `:${b.lineStart}` : '';
          console.log(`  ${badge} ${pc.bold(b.id)} ${pc.bold(b.title)}`);
          console.log(pc.dim(`             Location: ${b.file}${lineRef} [${b.category}]`));
          console.log(pc.dim(`             Trigger:  ${b.trigger.slice(0, 90)}...`));
          console.log();
        }
      }

      console.log(pc.cyan('─'.repeat(70)));
      console.log(pc.bold(pc.green(` 💾 HANDOFF REPORT SAVED:`)));
      console.log(`    ${pc.bold(pc.white(handoffResult.savedPath))}`);
      if (handoffResult.archivePath) {
        console.log(pc.dim(`    Archive: ${handoffResult.archivePath}`));
      }
      if (handoffResult.jsonPath) {
        console.log(pc.dim(`    JSON:    ${handoffResult.jsonPath}`));
      }

      console.log(pc.cyan('─'.repeat(70)));
      console.log(pc.bold(pc.magenta(` 🤖 READY FOR NEXT AGENT HANDOFF:`)));
      console.log(
        pc.dim(
          `    Provide this prompt to Claude, Codex, Cursor, or your next agent:\n`
        ) +
          pc.italic(
            `    "Please read ${handoffResult.savedPath} and resolve the ${auditResult.bugs.length} documented bugs starting with ${auditResult.bugs[0]?.id || 'BUG-001'}."`
          )
      );
      console.log(pc.cyan('═'.repeat(70)) + '\n');
    } catch (err: any) {
      console.error(pc.red(`\n❌ Pitstop error: ${err.message}`));
      if (opts.verbose && err.stack) {
        console.error(pc.dim(err.stack));
      }
      process.exit(1);
    }
  });

program.parse(process.argv);
