import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool } from "../harness";

interface NtfyConfig {
  topic?: string;
  server?: string;
  username?: string;
  password?: string;
  token?: string;
}

function defaultNtfyConfig(): NtfyConfig {
  const envTopic = process.env.DUCKAI_NTFY_TOPIC || process.env.NTFY_TOPIC;
  const envServer = process.env.DUCKAI_NTFY_SERVER || process.env.NTFY_SERVER;
  const envUser = process.env.DUCKAI_NTFY_USER || process.env.NTFY_USER;
  const envPass = process.env.DUCKAI_NTFY_PASS || process.env.NTFY_PASS;
  const envToken = process.env.DUCKAI_NTFY_TOKEN || process.env.NTFY_TOKEN;

  if (envTopic || envUser || envToken) {
    return {
      topic: envTopic,
      server: envServer || "https://ntfy.sh",
      username: envUser,
      password: envPass,
      token: envToken,
    };
  }
  try {
    const settingsPath = process.env.DUCKAI_SETTINGS_PATH || join(homedir(), ".duckai", "settings.json");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      ntfy?: NtfyConfig;
    };
    if (parsed.ntfy) {
      return {
        topic: parsed.ntfy.topic,
        server: parsed.ntfy.server || "https://ntfy.sh",
        username: parsed.ntfy.username,
        password: parsed.ntfy.password,
        token: parsed.ntfy.token,
      };
    }
  } catch {
    // ignore
  }
  return { server: "https://ntfy.sh" };
}

async function sendDesktopNotification(title: string, message: string): Promise<{ sent: boolean; error?: string }> {
  try {
    // 1. Try notify-send (common on Linux)
    const proc = Bun.spawn(["notify-send", title || "DuckAI", message], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    if (code === 0) return { sent: true };
  } catch {
    // notify-send not found
  }

  try {
    // 2. Try zenity (GTK desktop notification)
    const text = title ? `${title}: ${message}` : message;
    const proc = Bun.spawn(["zenity", "--notification", `--text=${text}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    if (code === 0) return { sent: true };
  } catch {
    // zenity not found
  }

  try {
    // 3. Try osascript (macOS)
    if (process.platform === "darwin") {
      const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${(title || "DuckAI").replace(/"/g, '\\"')}"`;
      const proc = Bun.spawn(["osascript", "-e", script], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      if (code === 0) return { sent: true };
    }
  } catch {
    // osascript not found
  }

  return { sent: false, error: "No supported desktop notification utility (notify-send, zenity, osascript) found." };
}

async function sendNtfyNotification(opts: {
  server: string;
  topic: string;
  message: string;
  title?: string;
  priority?: string | number;
  tags?: string[];
  username?: string;
  password?: string;
  token?: string;
}): Promise<{ sent: boolean; status?: number; error?: string }> {
  const serverUrl = opts.server.replace(/\/+$/, "");
  const targetUrl = `${serverUrl}/${encodeURIComponent(opts.topic)}`;

  const headers: Record<string, string> = {};
  if (opts.title) headers["Title"] = opts.title;
  if (opts.priority !== undefined) headers["Priority"] = String(opts.priority);
  if (opts.tags && opts.tags.length > 0) headers["Tags"] = opts.tags.join(",");

  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  } else if (opts.username && opts.password) {
    const creds = Buffer.from(`${opts.username}:${opts.password}`).toString("base64");
    headers["Authorization"] = `Basic ${creds}`;
  }

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: opts.message,
    });

    if (res.ok) {
      return { sent: true, status: res.status };
    }
    const body = await res.text().catch(() => "");
    return { sent: false, status: res.status, error: `ntfy HTTP ${res.status}: ${body}` };
  } catch (err) {
    return { sent: false, error: `Failed to connect to ntfy server: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const notifyTool: Tool = {
  name: "notify",
  permission: "allow",
  description:
    "Send a notification to the local desktop, via ntfy.sh (phone/web push), or both. Supports authenticated private channels.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "The notification body text." },
      title: { type: "string", description: "Optional notification title/header." },
      channel: {
        type: "string",
        enum: ["desktop", "ntfy", "both"],
        description: "Where to deliver the notification ('desktop', 'ntfy', or 'both'). Defaults to 'both' if ntfy topic is configured, otherwise 'desktop'.",
      },
      topic: {
        type: "string",
        description: "ntfy topic name (overrides DUCKAI_NTFY_TOPIC env/settings).",
      },
      server: {
        type: "string",
        description: "ntfy server URL (defaults to https://ntfy.sh or DUCKAI_NTFY_SERVER).",
      },
      username: {
        type: "string",
        description: "Optional username for authenticated ntfy topic.",
      },
      password: {
        type: "string",
        description: "Optional password for authenticated ntfy topic.",
      },
      token: {
        type: "string",
        description: "Optional access token for ntfy authentication (Bearer token).",
      },
      priority: {
        type: "string",
        description: "Priority level: 1 (min), 2 (low), 3 (default), 4 (high), 5 (urgent).",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of tags or emojis (e.g. ['tada', 'warning']).",
      },
    },
    required: ["message"],
  },
  execute: async (args) => {
    const message = String(args.message ?? "").trim();
    if (!message) return { error: "message is required" };
    const title = args.title ? String(args.title).trim() : undefined;

    const ntfyCfg = defaultNtfyConfig();
    const topic = (typeof args.topic === "string" && args.topic.trim()) || ntfyCfg.topic;
    const server = (typeof args.server === "string" && args.server.trim()) || ntfyCfg.server || "https://ntfy.sh";
    const username = (typeof args.username === "string" && args.username.trim()) || ntfyCfg.username;
    const password = (typeof args.password === "string" && args.password) || ntfyCfg.password;
    const token = (typeof args.token === "string" && args.token.trim()) || ntfyCfg.token;

    const requestedChannel = typeof args.channel === "string" ? args.channel : undefined;
    const channel = requestedChannel || (topic ? "both" : "desktop");

    const result: {
      desktop?: { sent: boolean; error?: string };
      ntfy?: { sent: boolean; status?: number; error?: string };
    } = {};

    if (channel === "desktop" || channel === "both") {
      result.desktop = await sendDesktopNotification(title ?? "DuckAI", message);
    }

    if (channel === "ntfy" || channel === "both") {
      if (!topic) {
        result.ntfy = {
          sent: false,
          error: "ntfy topic not configured. Specify 'topic' or set DUCKAI_NTFY_TOPIC in settings/env.",
        };
      } else {
        const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
        result.ntfy = await sendNtfyNotification({
          server,
          topic,
          message,
          title,
          priority: args.priority as string | number | undefined,
          tags,
          username,
          password,
          token,
        });
      }
    }

    return {
      success: Boolean(result.desktop?.sent || result.ntfy?.sent),
      channel,
      delivery: result,
    };
  },
};

export const getCurrentTimeTool: Tool = {
  name: "get_current_time",
  permission: "allow",
  description: "Return the current date and time on the user's machine.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "Optional IANA timezone, e.g. 'Europe/London'. Defaults to the system zone.",
      },
    },
    required: [],
  },
  execute: (args) => {
    const tz = typeof args.timezone === "string" && args.timezone ? args.timezone : undefined;
    const now = new Date();
    let formatted: string;
    try {
      formatted = new Intl.DateTimeFormat("en-GB", {
        dateStyle: "full",
        timeStyle: "long",
        ...(tz ? { timeZone: tz } : {}),
      }).format(now);
    } catch {
      formatted = now.toString();
    }
    return {
      iso: now.toISOString(),
      formatted,
      timezone: tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },
};

export const systemTools: Tool[] = [notifyTool, getCurrentTimeTool];
