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

export function composerAction(running, message, extra) {
  const text = String(message || "").trim();
  const attachments = Number(extra?.attachments || 0);
  if (!text && attachments <= 0) return { type: "ignore" };
  const body = text || "See the attached files.";
  if (running) return { type: "steer", message: body };
  return { type: "turn", message: body };
}
