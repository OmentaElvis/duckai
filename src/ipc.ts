/**
 * Cross-thread IPC between the webview worker and the main thread.
 *
 * The webview (and its GTK main loop) runs on a dedicated Worker so the main
 * thread's event loop stays free to run async harness tools. webview-bun's
 * bind callbacks can only return *synchronously* (its `seq` handle is
 * invalidated once the callback returns, and the loop is blocked during
 * `webview.run()`), so the worker performs a blocking `Atomics.wait` handshake
 * over a SharedArrayBuffer while the main thread does the actual (async) work.
 *
 * Shared memory layout:
 *   offset 0                 Int32Array(4): [state, requestLength, responseLength, pad]
 *   offset IPC_DATA_OFFSET   Uint8Array:    request/response payload bytes
 *
 * Only one call is ever in flight (the worker serialises calls by blocking),
 * so request and response can share the same data region.
 */

export const IPC_SAB_SIZE = 8 * 1024 * 1024;
export const IPC_DATA_OFFSET = 16;
export const IPC_WAIT_TIMEOUT_MS = 120_000;

export const IPC_IDLE = 0;
export const IPC_REQUEST = 1;
export const IPC_RESPONSE = 2;

export interface IpcViews {
  control: Int32Array;
  data: Uint8Array;
}

export interface IpcInitMessage {
  type: "init";
  buffer: SharedArrayBuffer;
}

export interface IpcRequestMessage {
  type: "req";
}

export type WorkerMessage = IpcInitMessage | IpcRequestMessage;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createSharedBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(IPC_SAB_SIZE);
}

export function viewsOf(buffer: SharedArrayBuffer): IpcViews {
  return {
    control: new Int32Array(buffer, 0, 4),
    data: new Uint8Array(buffer, IPC_DATA_OFFSET),
  };
}

export function writePayload(data: Uint8Array, value: unknown): number {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > data.length) throw new Error("ipc payload exceeds buffer size");
  data.set(bytes, 0);
  return bytes.length;
}

export function readPayload(data: Uint8Array, length: number): unknown {
  return JSON.parse(decoder.decode(data.subarray(0, length)));
}
