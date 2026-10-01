#!/usr/bin/env node
/**
 * Attachment limits, multipart parsing, workspace writes, and publish cards.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_VIDEO_BYTES,
  bindAttachments,
  parseChatBody,
  uploadRel,
  validateAttachments,
} from "../container/chat-body.mjs";
import {
  prepareAttachments,
  publishWorkspaceFile,
  resetPublishedFilesForTests,
  resolveUploadPath,
} from "../container/attachments.mjs";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

function multipart(parts) {
  const boundary = "----pi-box";
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type || "application/octet-stream"}\r\n\r\n`,
        ),
      );
      chunks.push(Buffer.from(part.body));
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.body}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    type: `multipart/form-data; boundary=${boundary}`,
  };
}

assert.equal(validateAttachments([{ name: "a.txt", mime: "text/plain", size: MAX_FILE_BYTES }]).ok, true);
assert.equal(
  validateAttachments([{ name: "a.txt", mime: "text/plain", size: MAX_FILE_BYTES + 1 }]).ok,
  false,
);
assert.match(
  validateAttachments([{ name: "big.txt", mime: "text/plain", size: MAX_FILE_BYTES + 1 }]).error,
  /exceeds/,
);
assert.equal(validateAttachments([{ name: "clip.mp4", mime: "video/mp4", size: MAX_VIDEO_BYTES }]).ok, true);
assert.equal(
  validateAttachments([{ name: "clip.mp4", mime: "video/mp4", size: MAX_VIDEO_BYTES + 1 }]).ok,
  false,
);
const tooMany = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
  name: `f${i}.txt`,
  mime: "text/plain",
  size: 4,
}));
assert.match(validateAttachments(tooMany).error, /too many attachments/);

const seven = multipart([
  { name: "message", body: "notes" },
  ...Array.from({ length: 7 }, (_, i) => ({
    name: "file",
    filename: `n${i}.txt`,
    type: "text/plain",
    body: Buffer.from("x"),
  })),
]);
const rejected = parseChatBody(seven.body, seven.type);
assert.equal(rejected.ok, false);
assert.equal(rejected.status, 413);
assert.match(rejected.error, /too many/);

const form = multipart([
  { name: "message", body: "look at these" },
  { name: "file", filename: "../secret.png", type: "image/png", body: Buffer.from(png) },
  { name: "file", filename: "notes.pdf", type: "application/pdf", body: Buffer.from("%PDF-1.4 hi") },
]);
const parsed = parseChatBody(form.body, form.type, { sessionId: "chat 1" });
assert.equal(parsed.ok, true);
assert.equal(parsed.message, "look at these");
assert.equal(parsed.attachments.length, 2);
assert.equal(parsed.attachments[0].bytes.length, png.length);
assert.equal(parsed.attachments[0].bytes[0], 0x89);
assert.equal(parsed.attachments[0].bytes[4], 0x00);
assert.equal(parsed.attachments[1].mime, "application/pdf");

const bound = bindAttachments(parsed.attachments, "chat 1");
assert.equal(bound[0].name, "secret.png");
assert.ok(bound[0].rel.startsWith("uploads/chat1/"));
assert.ok(!bound[0].rel.includes(".."));
assert.equal(uploadRel("../etc", "id", "name"), "uploads/etc/id-name");

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-box-attach-"));
try {
  const prepared = await prepareAttachments({
    attachments: bound,
    cwd: tmp,
    agentDir: path.join(tmp, "agent"),
    sessionId: "chat 1",
  });
  assert.equal(prepared.images.length, 1);
  assert.equal(prepared.images[0].mimeType, "image/png");
  assert.equal(prepared.saved.length, 1);
  assert.match(prepared.note, /notes\.pdf/);
  const saved = await stat(prepared.saved[0].path);
  assert.ok(saved.size > 0);
  const index = JSON.parse(await readFile(path.join(tmp, "agent", "uploads", "index.json"), "utf8"));
  assert.equal(index.files.length, 1);
  assert.equal(index.files[0].name, "notes.pdf");
  assert.throws(() => resolveUploadPath(tmp, "uploads/../../etc/passwd"), /escapes/);

  const published = await publishWorkspaceFile({
    cwd: tmp,
    sourcePath: prepared.saved[0].path,
    name: "notes.pdf",
  });
  assert.equal(published.card.kind, "artifact");
  assert.equal(published.card.image, false);
  assert.match(published.card.url, /^\/api\/files\//);
  const bytes = await readFile(published.record.path);
  assert.match(bytes.toString(), /PDF/);

  const image = await publishWorkspaceFile({
    cwd: tmp,
    bytes: Buffer.from(png),
    name: "shot.png",
    mime: "image/png",
  });
  assert.equal(image.card.image, true);
  assert.match(image.card.src, /^data:image\/png;base64,/);

  const empty = parseChatBody(JSON.stringify({ message: "" }), "application/json");
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "message required");
  const jsonFiles = parseChatBody(
    JSON.stringify({
      message: "json path",
      attachments: [{ name: "a.txt", type: "text/plain", data: Buffer.from("hello").toString("base64") }],
    }),
    "application/json",
  );
  assert.equal(jsonFiles.ok, true);
  assert.equal(new TextDecoder().decode(jsonFiles.attachments[0].bytes), "hello");
  console.log("ok test-attachments");
} finally {
  resetPublishedFilesForTests();
  await rm(tmp, { recursive: true, force: true });
}
