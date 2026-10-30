#!/usr/bin/env node
// @ts-check
/**
 * Build — package the app into the next Export/VersionN (export-static.py). No upload.
 * See deploy.md and AgentController docs/RepositoryCommands.md.
 */
import { latestExportDir, root, runExport } from "./lib/export.mjs";

process.chdir(root);
runExport();
console.log("");
console.log(`Build done: ${latestExportDir()}`);
console.log("Nothing was uploaded. Deploy Local serves it; Deploy Prod publishes it.");
