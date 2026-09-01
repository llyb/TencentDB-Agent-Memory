import { z } from "zod";

const id = z.string().trim().min(1);
const ids = z.array(id).refine(xs => new Set(xs).size === xs.length, "duplicate IDs");
const timestamp = z.iso.datetime({ offset: true });
export const scopeSchema = z.object({ teamId: id, userId: id, agentId: id }).strict();
export const recordSchema = z.object({
  id, content: id, type: z.enum(["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"]),
  priority: z.number().int().min(-1).max(100), scene_name: id,
  source_message_ids: ids.min(1), source_session_ids: ids.min(1), evidence_ids: ids,
  timestamps: z.array(timestamp).min(1), createdAt: timestamp, updatedAt: timestamp,
  metadata: z.record(z.string(), z.string()), version: z.number().int().positive(),
  sessionKey: id, sessionId: id, teamId: id, userId: id, agentId: id,
}).strict();
export const vectorsSchema = z.object({
  schema_version: z.literal(1), dataset_hash: id, provider: id, model: id,
  dimensions: z.number().int().positive(), created_at: timestamp,
  provenance: z.literal("remote_api"), endpoint: z.string().url(),
  vectors: z.record(z.string(), z.array(z.number().finite())),
}).strict();

// These envelopes are the only shared contract; scores remain suite-specific.
export const runSchema = z.object({
  schema_version: z.literal(1), run_id: id, config_hash: id,
  model: id.nullable(), repo_commit: id, source_hash: id,
  prompt_version: id, dataset_hash: id, snapshot_hash: id,
  started_at: timestamp, repo_dirty: z.boolean(),
  runtime: z.record(z.string(), z.string()),
}).strict();
const traceBase = {
  run_id: id, config_hash: id, model: id.nullable(), repo_commit: id,
  prompt_version: id, sample_id: id, timestamp,
};
export const traceSchema = z.discriminatedUnion("suite", [
  z.object({ ...traceBase, suite: z.literal("memory_retrieval"), event: z.enum(["retrieval", "skipped", "error"]),
    trace: z.object({ requested_strategy: id, actual_strategy: id, backend: id,
      returned_record_ids: ids, candidate_record_ids: ids, elapsed_ms: z.number().nonnegative(),
      warnings: z.array(z.string()), reason: z.string().nullable() }).strict(),
  }).strict(),
  z.object({ ...traceBase, suite: z.literal("tool_decision"), event: z.literal("decision"),
    trace: z.object({ context_hash: id, assets_hash: id, serialized_prompt_hash: id,
      allowed_asset_tools: ids, called_tools: z.array(id), expected_asset_call: z.boolean(),
      injection_tokens: z.number().int().nonnegative(), fixture_hash: id }).strict(),
  }).strict(),
  z.object({ ...traceBase, suite: z.literal("skill_coding"), event: z.literal("task"),
    trace: z.object({ task_commit: id, skill_snapshot_hash: id,
      status: z.enum(["passed", "failed", "timeout", "environment_error", "model_error"]),
      verifier_command: id, verifier_exit_code: z.number().int().nullable(),
      turns: z.number().int().nonnegative(), loaded_skill_ids: ids,
      costs: z.array(z.object({ stage: z.enum(["extraction", "compression", "task", "other"]),
        input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
        cached_input_tokens: z.number().int().nonnegative(),
      }).strict()).superRefine((costs, ctx) => {
        if (costs.some(c => c.cached_input_tokens > c.input_tokens))
          ctx.addIssue({ code: "custom", message: "cached input is a subset of input, not an additional cost" });
      }),
    }).strict(),
  }).strict(),
]);
export type Query = { query: string; scope: z.infer<typeof scopeSchema> };
export type RecordItem = z.infer<typeof recordSchema>;
export type Run = z.infer<typeof runSchema>;
export type Vectors = z.infer<typeof vectorsSchema>;
export type Strategy = "bm25" | "dense" | "hybrid";
