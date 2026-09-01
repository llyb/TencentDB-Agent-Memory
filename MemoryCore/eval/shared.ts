import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { execFileSync } from "node:child_process";
import type { ZodType } from "zod";
import { traceSchema } from "./schema.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function fileHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}
export function readJsonl<T>(file: string, schema: ZodType<T>): T[] {
  return readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
    .flatMap((line, i) => {
      if (!line.trim()) return [];
      try { return [schema.parse(JSON.parse(line))]; }
      catch (e) { throw new Error(`${file}:${i + 1}: ${String(e)}`); }
    });
}
export function writeJson(file: string, data: unknown): void {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
}
export function writeJsonl(file: string, rows: unknown[]): void {
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { flag: "wx" });
}
export function containedPath(root: string, child: string): string {
  const result = resolve(root, child);
  const rel = relative(resolve(root), result);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Dataset path escapes its directory");
  return result;
}
export function sourceInfo(root: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|json)$/.test(entry.name)) files[rel] = fileHash(join(root, rel));
    }
  };
  walk("src");
  // Data and run artifacts have separate hashes; hash all evaluator implementation files.
  for (const entry of readdirSync(join(root, "eval"))) {
    if (/\.(ts|py)$/.test(entry)) files[`eval/${entry}`] = fileHash(join(root, "eval", entry));
  }
  files["package.json"] = fileHash(join(root, "package.json"));
  return { repo_commit: git("rev-parse", "HEAD"), repo_dirty: git("status", "--porcelain").length > 0,
    source_hash: hash(files), source_files: files };
}
export function validateTraceFile(file: string): number {
  return readJsonl(file, traceSchema).length;
}
