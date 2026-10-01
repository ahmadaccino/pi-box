/**
 * The chat SSE response is the connected user. Approvals and draft cards
 * emitted while a turn is open write onto that stream.
 */
let active = null;
let openCount = 0;
let connected = false;
const listeners = new Set();

function notify() {
  for (const fn of [...listeners]) {
    try {
      fn(connected);
    } catch {
      /* listener errors must not break the turn */
    }
  }
}

export function isUserConnected() {
  return connected;
}

export function subscribeConnection(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function openLiveTurn(sessionId, emit) {
  openCount += 1;
  connected = true;
  const state = { sessionId: String(sessionId), emit, open: true };
  active = state;
  notify();
  const disconnect = () => {
    if (!state.open) return;
    state.open = false;
    openCount = Math.max(0, openCount - 1);
    connected = openCount > 0;
    if (active === state) active = null;
    notify();
  };
  return { disconnect, close: disconnect };
}

export function emitLive(event, data) {
  if (!active?.open || typeof active.emit !== "function") return false;
  try {
    active.emit(event, data);
    return true;
  } catch {
    return false;
  }
}

export function resetLiveTurnForTests() {
  active = null;
  openCount = 0;
  connected = false;
  listeners.clear();
}
