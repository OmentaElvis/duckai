/**
 * Type shim for webview-bun, wired via tsconfig `paths` for the typechecker
 * only. The package ships raw .ts sources referencing `bun:ffi` internals that
 * don't typecheck under our config; Bun resolves the real package at runtime.
 */
export interface Size {
  width: number;
  height: number;
  hint: number;
}

export enum SizeHint {
  NONE = 0,
  MIN = 1,
  MAX = 2,
  FIXED = 3,
}

export type BindCallback = (...args: unknown[]) => unknown;

export class Webview {
  constructor(debug?: boolean, size?: Size, window?: unknown);
  set size(value: Size);
  set title(value: string);
  get unsafeHandle(): unknown;
  get unsafeWindowHandle(): unknown;
  destroy(): void;
  navigate(url: string): void;
  setHTML(html: string): void;
  run(): void;
  bindRaw(
    name: string,
    callback: (seq: string, req: string, arg: unknown) => void,
    arg?: unknown,
  ): void;
  bind(name: string, callback: BindCallback): void;
  unbind(name: string): void;
  return(seq: string, status: number, result: string): void;
  eval(source: string): void;
  init(source: string): void;
}

export function unload(): void;
