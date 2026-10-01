/**
 * Pi custom tools for memory and saving a shared user skill.
 * The implementations live in memory.mjs and user-skills.mjs so tests do not load Pi.
 */
import { memoryForget, memorySearch, memoryWrite } from "./memory.mjs";
import { saveUserSkill } from "./user-skills.mjs";
import { MEMORY_SYSTEM_NOTE, SKILL_SYSTEM_NOTE } from "./bot-files.mjs";

function textResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    details: {},
    isError,
  };
}

export async function botCustomTools(mod, opts) {
  let Type = null;
  try {
    Type = (await import("typebox")).Type;
  } catch {
    return [];
  }
  if (!Type || typeof mod?.defineTool !== "function") return [];
  const memoryFile = opts.memoryFile;
  const agentDir = opts.agentDir;
  const define = (tool) => mod.defineTool(tool);

  return [
    define({
      name: "memory_write",
      label: "Memory write",
      description:
        "Remember a fact for this bot. kind profile is a stable fact included in every prompt. kind log is a dated event you can search later.",
      promptSnippet: "Save a profile or dated log fact",
      promptGuidelines: [MEMORY_SYSTEM_NOTE],
      parameters: Type.Object({
        text: Type.String({ description: "The fact to remember" }),
        kind: Type.Optional(
          Type.Union([Type.Literal("profile"), Type.Literal("log")], {
            description: "profile (always in the prompt) or log (dated, searchable). Defaults to profile.",
          }),
        ),
        at: Type.Optional(Type.String({ description: "Date for a log fact, YYYY-MM-DD" })),
      }),
      execute: async (_id, params) => {
        const result = memoryWrite(memoryFile, params || {});
        return textResult(JSON.stringify(result), !result.ok);
      },
    }),
    define({
      name: "memory_forget",
      label: "Memory forget",
      description: "Delete one memory fact by id.",
      promptSnippet: "Forget a memory fact by id",
      promptGuidelines: ["Use memory_forget when the user asks you to forget a specific fact."],
      parameters: Type.Object({
        id: Type.String({ description: "Fact id returned by memory_write or memory_search" }),
      }),
      execute: async (_id, params) => {
        const result = memoryForget(memoryFile, params?.id);
        return textResult(JSON.stringify(result), !result.ok);
      },
    }),
    define({
      name: "memory_search",
      label: "Memory search",
      description: "Search this bot's dated log facts. Profile facts are already in the prompt.",
      promptSnippet: "Search dated memory log",
      promptGuidelines: ["Search the log with memory_search before saying you do not remember a dated event."],
      parameters: Type.Object({
        query: Type.String({ description: "Words to find in dated log facts" }),
      }),
      execute: async (_id, params) => {
        const result = memorySearch(memoryFile, params?.query);
        return textResult(JSON.stringify(result), false);
      },
    }),
    define({
      name: "save_skill",
      label: "Save skill",
      description:
        "Save a reusable multi-step procedure as a user skill (SKILL.md) shared across every bot.",
      promptSnippet: "Save a procedure as a shared skill",
      promptGuidelines: [SKILL_SYSTEM_NOTE],
      parameters: Type.Object({
        name: Type.String({ description: "Hyphenated skill name, such as weekly-review" }),
        description: Type.String({ description: "One line describing when to use the skill" }),
        body: Type.String({ description: "Markdown steps of the procedure" }),
      }),
      execute: async (_id, params) => {
        const result = saveUserSkill({
          agentDir,
          name: params?.name,
          description: params?.description,
          body: params?.body,
        });
        if (result.ok && typeof opts.onSkillSaved === "function") {
          try {
            await opts.onSkillSaved();
          } catch {
            /* catalog refresh is best-effort */
          }
        }
        return textResult(JSON.stringify(result), !result.ok);
      },
    }),
  ];
}
