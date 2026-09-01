// Wire protocol shared between the browser client and the PTY backend.
//
// Client -> Server messages are JSON text frames (see ClientMessage).
// Server -> Client PTY output is sent as raw text frames (not JSON) for
// throughput; control messages from the server are JSON text frames that
// always begin with the 0x01 SOH byte so they can be told apart from
// ordinary terminal output.

export const SERVER_CONTROL_PREFIX = "\x01";

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerControlMessage =
  | { type: "ready"; shell: string; pid: number }
  | { type: "exit"; code: number; signal?: number };

export function encodeServerControl(msg: ServerControlMessage): string {
  return SERVER_CONTROL_PREFIX + JSON.stringify(msg);
}

export function decodeServerControl(
  frame: string,
): ServerControlMessage | null {
  if (!frame.startsWith(SERVER_CONTROL_PREFIX)) return null;
  try {
    return JSON.parse(frame.slice(SERVER_CONTROL_PREFIX.length));
  } catch {
    return null;
  }
}
