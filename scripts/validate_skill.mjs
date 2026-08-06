#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const skillDirectory = process.argv[2];
if (skillDirectory === undefined || process.argv.length !== 3) {
  process.stderr.write("Usage: node scripts/validate_skill.mjs <skill-directory>\n");
  process.exitCode = 1;
} else {
  try {
    const content = await readFile(`${skillDirectory}/SKILL.md`, "utf8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (match === null) {
      throw new Error("No valid YAML frontmatter found");
    }

    /** @type {Record<string, string>} */
    const frontmatter = {};
    for (const line of match[1].split("\n")) {
      const field = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (field !== null) {
        frontmatter[field[1]] = field[2].replace(/^['"]|['"]$/g, "");
      }
    }

    const allowed = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
    for (const key of Object.keys(frontmatter)) {
      if (!allowed.has(key)) {
        throw new Error(`Unexpected frontmatter key: ${key}`);
      }
    }
    const name = frontmatter.name?.trim();
    const description = frontmatter.description?.trim();
    if (name === undefined || name === "") {
      throw new Error("Missing name in frontmatter");
    }
    if (
      !/^[a-z0-9-]+$/.test(name) ||
      name.startsWith("-") ||
      name.endsWith("-") ||
      name.includes("--")
    ) {
      throw new Error("Skill name must be hyphen-case");
    }
    if (name.length > 64) {
      throw new Error("Skill name is too long");
    }
    if (description === undefined || description === "") {
      throw new Error("Missing description in frontmatter");
    }
    if (description.includes("<") || description.includes(">") || description.length > 1024) {
      throw new Error("Skill description is invalid");
    }
    process.stdout.write("Skill is valid!\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Skill validation failed"}\n`);
    process.exitCode = 1;
  }
}
