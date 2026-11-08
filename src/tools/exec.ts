import type { Tool } from "../harness";
import { resolveUserPath } from "./fs";

const MAX_OUTPUT_BYTES = 32 * 1024; // 32 KB cap for output to keep tokens manageable

export const runCommandTool: Tool = {
  name: "run_command",
  permission: "ask",
  description:
    "Execute a shell command on the local machine. Runs inside bash with timeout enforcement and captured stdout/stderr.",
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

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }, timeoutMs);

    try {
      const [stdoutText, stderrText, exitCode] = await Promise.all([
        proc.stdout ? new Response(proc.stdout as BodyInit).text() : "",
        proc.stderr ? new Response(proc.stderr as BodyInit).text() : "",
        proc.exited,
      ]);

      clearTimeout(timer);

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
      clearTimeout(timer);
      return {
        error: `Command execution failed: ${err instanceof Error ? err.message : String(err)}`,
        timed_out: timedOut,
      };
    }
  },
};

export const execTools: Tool[] = [runCommandTool];
