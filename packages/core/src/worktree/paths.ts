import { isAbsolute, resolve, sep } from "node:path";
import { WorktreeError } from "./types";

export function requireAbsolute(value: string, name: string): void {
  if (!isAbsolute(value)) {
    throw new WorktreeError("invalid_input", `${name} must be an absolute path.`);
  }
}

export function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new WorktreeError("invalid_input", "Path escapes its expected project root.");
  }
}
