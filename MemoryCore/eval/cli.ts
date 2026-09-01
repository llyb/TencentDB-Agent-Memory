import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTraceFile } from "./shared.js";
import { downloadOfficialData, loadOfficialData, LONGMEMEVAL_SOURCE } from "./longmemeval-data.js";
import { loadLongmemConfig, runLongmem } from "./longmemeval.js";

const help = `Memory Eval (run from MemoryCore)
  npm run eval:memory -- run [--config eval/configs/longmemeval-s.json]
  npm run eval:memory -- validate [--config eval/configs/longmemeval-s.json]
  npm run eval:memory -- validate-traces --file <trace.jsonl>
  npm run eval:memory -- download-longmemeval [--mirror] [--config eval/configs/longmemeval-s.json]
  npm run eval:memory -- longmemeval [--limit <smoke-count>] [--config eval/configs/longmemeval-s.json]
  npm run eval:memory -- system --live [--config eval/configs/system-longmemeval.json] [--resume <run-dir>] [--snapshot-run <run-dir>] [--env-file <.env>]
Normal run is offline, creates a NEW run directory, and never reads/writes production databases.
The default command and 'run' both execute LongMemEval. No remote model is called.
'download-longmemeval' fetches the pinned public dataset and verifies the official SHA-256.
Config paths are relative to the config file; --file paths are relative to the current directory.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: "string" }, file: { type: "string" }, help: { type: "boolean" },
    mirror: { type: "boolean" }, limit: { type: "string" }, live: { type: "boolean" }, resume: { type: "string" }, "snapshot-run": { type: "string" }, "env-file": { type: "string" },
  } });
  const command = positionals[0] ?? "run";
  if (positionals.length > 1) throw new Error("Only one command is accepted");
  if (values.help || command === "help") { console.log(help); }
  else {
    const configFile = values.config ?? resolve(dirname(fileURLToPath(import.meta.url)),
      command === "system" ? "configs/system-longmemeval.json" : "configs/longmemeval-s.json");
    if (command === "system") {
      const { runSystem } = await import("./system-eval.js");
      const result = await runSystem(configFile, { live: values.live, resume: values.resume, snapshotRun: values["snapshot-run"], envFile: values["env-file"], limit: values.limit === undefined ? undefined : Number(values.limit) });
      console.log(JSON.stringify(result, null, 2)); if (result.failed) process.exitCode = 1;
    } else if (command === "download-longmemeval") {
      console.log(await downloadOfficialData(loadLongmemConfig(configFile).dataset_file, values.mirror));
    } else if (command === "longmemeval" || command === "run") {
      const result = await runLongmem(configFile, values.limit === undefined ? undefined : Number(values.limit));
      console.log(JSON.stringify(result, null, 2));
      if (result.failed) process.exitCode = 1;
    } else if (command === "validate") {
      const data = loadOfficialData(loadLongmemConfig(configFile).dataset_file);
      console.log(JSON.stringify({ dataset: LONGMEMEVAL_SOURCE.dataset, sha256: LONGMEMEVAL_SOURCE.sha256,
        questions: data.length, sessions: data.reduce((n, q) => n + q.haystack_sessions.length, 0) }, null, 2));
    } else if (command === "validate-traces") {
      if (!values.file) throw new Error("validate-traces requires --file");
      console.log(JSON.stringify({ valid_traces: validateTraceFile(resolve(values.file)) }));
    } else throw new Error(`Unknown command: ${command}\n${help}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
