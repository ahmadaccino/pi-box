/**
 * User-written skills shared by every bot. Indexed from PI_CODING_AGENT_DIR/skills.
 */
import fs from "node:fs";
import path from "node:path";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function userSkillsDir(agentDir) {
  return path.join(agentDir, "skills");
}

function yamlScalar(value) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (!text || /[:#]/.test(text) || text.startsWith("'") || text.startsWith('"')) {
    return JSON.stringify(text);
  }
  return text;
}

export function saveUserSkill({ agentDir, name, description, body }) {
  const skillName = String(name || "").trim();
  const skillDescription = String(description || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  const skillBody = String(body || "").trim().slice(0, 20_000);
  if (!NAME.test(skillName) || skillName.length > 64) {
    return { ok: false, error: "name must be lowercase words separated by hyphens" };
  }
  if (!skillDescription) return { ok: false, error: "description required" };
  if (!skillBody) return { ok: false, error: "body required" };
  const dir = path.join(userSkillsDir(agentDir), skillName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, "SKILL.md");
  const text = `---\nname: ${skillName}\ndescription: ${yamlScalar(skillDescription)}\n---\n\n${skillBody}\n`;
  fs.writeFileSync(filePath, text, { mode: 0o600 });
  return { ok: true, name: skillName, description: skillDescription, filePath };
}
