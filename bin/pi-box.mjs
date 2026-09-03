#!/usr/bin/env node
import { parseNodeArgs } from "../container/node-logic.mjs";
import { runNode } from "../container/node.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(`pi-box — personal agent mesh node

Usage:
  pi-box node [--origin URL] [--name NAME] [--password PASS] [--cookie COOKIE] [--token CLERK_JWT]
  pi-box join   (alias for node)

Linux x64 and Linux arm64 (Raspberry Pi) run this command. No GUI.
Electron wraps this sidecar on macOS and Linux x64.
`);
  process.exit(cmd ? 0 : 1);
}

if (cmd === "node" || cmd === "join") {
  const rest = cmd === "node" && argv[1] === "join" ? argv.slice(2) : argv.slice(1);
  const running = await runNode(parseNodeArgs(rest));
  if (!running) process.exit(0);
  await new Promise(() => {});
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
