import type { PermissionScope, Tool } from "../harness";
import { resolveUserPath } from "./fs";

const MAX_OUTPUT_BYTES = 32 * 1024; // 32 KB cap for output to keep tokens manageable

function parseCommandBinaries(command: string): string[] {
  // Split on chain/pipeline operators: &&, ||, ;, |, &
  const parts = command.split(/&&|\|\||[;|]/);
  const binaries = new Set<string>();
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/).filter((t) => !t.includes("="));
    if (tokens.length > 0) {
      const bin = tokens[0]!.replace(/^.*[/\\]/, "");
      if (bin) binaries.add(bin);
    }
  }
  return [...binaries];
}

export const runCommandTool: Tool = {
  name: "run_command",
  permission: "ask",
  description:
    "Execute a shell command on the local machine. Runs inside bash with timeout enforcement and captured stdout/stderr.",
  permissionScopes: (args) => {
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (!cmd) {
      return [{ id: "run_command", label: "All shell commands", isDefault: true }];
    }
    const bins = parseCommandBinaries(cmd);
    const shortCmd = cmd.length > 45 ? `${cmd.slice(0, 45)}…` : cmd;
    const scopes: PermissionScope[] = [
      {
        id: `cmd:${cmd}`,
        label: `Exact command: "${shortCmd}"`,
        description: "Only auto-approve this identical command line",
        isDefault: true,
      },
    ];
    if (bins.length === 1) {
      const bin = bins[0]!;
      scopes.push({
        id: `bin:${bin}:*`,
        label: `Any "${bin}" command`,
        description: `Auto-approve any shell command invoking "${bin}"`,
      });
    }
    scopes.push({
      id: "run_command",
      label: "All shell commands",
      description: "Auto-approve every command without prompting",
    });
    return scopes;
  },
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The exact shell command line to execute." },
      cwd: {
        type: "string",
        description: "Working directory in which to run the command (supports ~). Defaults to current directory.",
      },
      timeout_ms: {
        type: "integer",
        description: "Execution timeout in milliseconds. Defaults to 30000 (30 seconds).",
      },
    },
    required: ["command"],
  },
  execute: async (args) => {
    const command = String(args.command ?? "").trim();
    if (!command) return { error: "command is required" };

    const rawCwd = args.cwd ? String(args.cwd).trim() : process.cwd();
    const cwd = resolveUserPath(rawCwd);
    const timeoutMs = Math.min(
      300_000,
      Math.max(1000, typeof args.timeout_ms === "number" ? Math.floor(args.timeout_ms) : 30_000),
    );

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["bash", "-c", command], {
        cwd,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      return { error: `Failed to spawn command: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Drain a readable stream into a string without blocking on stream close.
    // Returns whatever has been collected so far when the signal fires.
    const drainStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
      if (!stream) return "";
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            totalBytes += value.byteLength;
            if (totalBytes >= MAX_OUTPUT_BYTES) break; // stop collecting early — truncation applied below
          }
        }
      } catch {
        // Stream closed/aborted — return what we have
      } finally {
        try { reader.cancel(); } catch { /* ignore */ }
      }
      return new TextDecoder().decode(
        chunks.reduce((acc, chunk) => {
          const merged = new Uint8Array(acc.byteLength + chunk.byteLength);
          merged.set(acc);
          merged.set(chunk, acc.byteLength);
          return merged;
        }, new Uint8Array(0)),
      );
    };

    let timedOut = false;

    // We race the process exit against the timeout. When the timeout fires we
    // kill the process; the kill causes the pipes to close, which unblocks the
    // stream readers — so we do NOT need a separate abort mechanism.
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill(); } catch { /* already exited */ }
        resolve();
      }, timeoutMs);
    });

    // Drain streams and wait for exit, but bail as soon as the timeout resolves.
    // After a kill the pipes close quickly so the drain promises settle shortly
    // after timeoutPromise resolves — we let them race naturally.
    try {
      const [stdoutText, stderrText, exitCode] = await Promise.all([
        drainStream(proc.stdout as ReadableStream<Uint8Array> | null),
        drainStream(proc.stderr as ReadableStream<Uint8Array> | null),
        // exited resolves with the exit code once the process is gone; after
        // kill() this will also resolve quickly.
        Promise.race([proc.exited, timeoutPromise.then(() => proc.exited)]).then(() => proc.exitCode ?? -1),
      ]);

      clearTimeout(timer!);

      const truncate = (s: string) => {
        if (s.length > MAX_OUTPUT_BYTES) {
          return s.slice(0, MAX_OUTPUT_BYTES) + "\n... [Output truncated at 32KB]";
        }
        return s;
      };

      return {
        exit_code: exitCode,
        stdout: truncate(stdoutText),
        stderr: truncate(stderrText),
        timed_out: timedOut,
      };
    } catch (err) {
      return {
        error: `Command execution failed: ${err instanceof Error ? err.message : String(err)}`,
        timed_out: timedOut,
      };
    }
  },
};

export const execTools: Tool[] = [runCommandTool];
