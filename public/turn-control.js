/** Composer state while a turn is running: steer instead of a new turn, Stop stays available. */

export function composerView(running) {
  const live = Boolean(running);
  return {
    running: live,
    placeholder: live ? "Steer this turn…" : "Message this box…",
    stopHidden: !live,
    sendDisabled: false,
    sendLabel: live ? "Steer" : "Send",
  };
}

export function composerAction(running, message) {
  const text = String(message || "").trim();
  if (!text) return { type: "ignore" };
  if (running) return { type: "steer", message: text };
  return { type: "turn", message: text };
}
