import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return { fm, body: m[2].trim() };
}

function requiresFrom(fm) {
  const blob = `${fm.compatibility || ""} ${fm.metadata || ""} ${fm.name || ""} ${fm.description || ""}`.toLowerCase();
  const requires = [];
  if (/\bbrowser\b|playwright|chromium|cdp/.test(blob)) requires.push("browser");
  if (/\bvault\b/.test(blob)) requires.push("vault");
  if (/\bandroid\b|\badb\b|emulator/.test(blob)) requires.push("android");
  if (/\bios\b|simulator|xcode|simctl/.test(blob)) requires.push("ios");
  return [...new Set(requires)];
}

export function parseSkill(text, filePath) {
  const parsed = parseFrontmatter(text);
  if (!parsed?.fm?.name || !parsed?.fm?.description) return null;
  const { fm, body } = parsed;
  return {
    name: fm.name,
    description: fm.description,
    license: fm.license || null,
    compatibility: fm.compatibility || null,
    metadata: fm.metadata || null,
    filePath,
    baseDir: path.dirname(filePath),
    body,
    requires: requiresFrom(fm),
    source: "pi-box",
  };
}

async function walkSkillDirs(dir, acc) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walkSkillDirs(full, acc);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      try {
        const text = await readFile(full, "utf8");
        const skill = parseSkill(text, full);
        if (skill) acc.push(skill);
      } catch {
        /* skip unreadable */
      }
    }
  }
  return acc;
}

async function pluginSkillDirs(pluginsRoot) {
  const dirs = [];
  let entries;
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    dirs.push(path.join(pluginsRoot, entry.name, "skills"));
  }
  return dirs;
}

export function skillRoots() {
  const roots = [
    path.join(here, "skills"),
    process.env.PI_CODING_AGENT_DIR
      ? path.join(process.env.PI_CODING_AGENT_DIR, "skills")
      : null,
    process.env.PI_PLUGINS_DIR || path.join(here, "..", "plugins"),
  ].filter(Boolean);
  return roots;
}

export async function loadSkills() {
  const found = [];
  const seen = new Set();
  const roots = skillRoots();
  for (const root of roots) {
    const info = await stat(root).catch(() => null);
    if (!info) continue;
    const dirs = info.isDirectory() && path.basename(root) !== "skills"
      ? await pluginSkillDirs(root)
      : [root];
    for (const dir of dirs) {
      await walkSkillDirs(dir, found);
    }
  }
  const unique = [];
  for (const skill of found) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    unique.push(skill);
  }
  unique.sort((a, b) => a.name.localeCompare(b.name));
  return unique;
}

export function annotateAvailability(skills, capabilities) {
  return skills.map((skill) => {
    const missing = skill.requires.filter((r) => !capabilities[r]);
    return {
      ...skill,
      available: missing.length === 0,
      missing,
    };
  });
}

export function toPiSkills(skills) {
  return skills
    .filter((s) => s.available)
    .map((s) => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      baseDir: s.baseDir,
      source: "pi-box",
    }));
}

export function publicSkill(skill) {
  return {
    name: skill.name,
    description: skill.description,
    requires: skill.requires,
    available: skill.available,
    missing: skill.missing,
    compatibility: skill.compatibility,
    license: skill.license,
  };
}
