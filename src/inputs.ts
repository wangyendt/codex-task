import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Input } from "@openai/codex-sdk";
import { usageError } from "./errors.js";
import { validateInputImages } from "./images.js";

export interface TaskInputSources {
  prompt?: string | undefined;
  promptFiles?: string[] | undefined;
  stdin?: string | undefined;
  imagePaths?: string[] | undefined;
}

export interface ResolvedTaskInput {
  text: string;
  imagePaths: string[];
}

function promptFilePart(path: string): string {
  const absolute = resolve(path);
  let content: string;
  try {
    content = readFileSync(absolute, "utf8");
  } catch (error) {
    throw usageError(`could not read prompt file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!content.trim()) throw usageError(`prompt file must not be empty: ${path}`);
  return `--- BEGIN PROMPT FILE: ${absolute} ---\n${content.trimEnd()}\n--- END PROMPT FILE ---`;
}

export function resolveTaskInput(sources: TaskInputSources): ResolvedTaskInput {
  const parts: string[] = [];
  if (sources.prompt?.trim()) parts.push(sources.prompt.trim());
  for (const path of sources.promptFiles ?? []) parts.push(promptFilePart(path));
  if (sources.stdin?.trim()) {
    parts.push(`--- BEGIN STDIN ---\n${sources.stdin.trim()}\n--- END STDIN ---`);
  }
  if (parts.length === 0) throw usageError("provide a prompt argument, --prompt-file, or non-empty stdin");
  return {
    text: parts.join("\n\n"),
    imagePaths: validateInputImages(sources.imagePaths),
  };
}

export function toSdkInput(input: ResolvedTaskInput): Input {
  return [
    { type: "text", text: input.text },
    ...input.imagePaths.map((path) => ({ type: "local_image" as const, path })),
  ];
}
