import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = arg("input");
const output = arg("output");
const beforeSequence = Number(arg("before-sequence"));
if (!input || !output || !Number.isInteger(beforeSequence) || beforeSequence < 0) {
  throw new Error("usage: node prepare-frozen-skill-snapshot.mjs --input skills.json --output snapshot.json --before-sequence N");
}

const skills = JSON.parse(await readFile(path.resolve(input), "utf8"));
if (!Array.isArray(skills)) throw new Error("input must be a JSON array");

const frozen = skills
  .filter((skill) => Number.isInteger(skill.sequence_index) && skill.sequence_index < beforeSequence)
  .map(({ embedding: _embedding, ...skill }) => skill)
  .sort((a, b) => a.sequence_index - b.sequence_index || a.id.localeCompare(b.id));

await writeFile(path.resolve(output), `${JSON.stringify(frozen, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ input, output, beforeSequence, skills: frozen.length }, null, 2));
