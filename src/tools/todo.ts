import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Tool } from "../harness";
import { log } from "../logging/host";

interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
}

const TODO_PATH = join(homedir(), ".duckai", "todos.json");

let todoItems: TodoItem[] | null = null;
let todoNextId = 1;

function loadTodos(): TodoItem[] {
  if (todoItems) return todoItems;
  try {
    const parsed = JSON.parse(readFileSync(TODO_PATH, "utf8")) as {
      items?: TodoItem[];
      nextId?: number;
    };
    todoItems = Array.isArray(parsed.items) ? parsed.items : [];
    todoNextId = typeof parsed.nextId === "number" ? parsed.nextId : 1;
  } catch {
    todoItems = [];
    todoNextId = 1;
  }
  return todoItems;
}

function saveTodos(): void {
  try {
    mkdirSync(dirname(TODO_PATH), { recursive: true });
    writeFileSync(
      TODO_PATH,
      JSON.stringify({ items: loadTodos(), nextId: todoNextId }, null, 2),
    );
  } catch (err) {
    log.child("todo").warn("failed to persist", err instanceof Error ? err.message : err);
  }
}

function todoSnapshot(): {
  todos: TodoItem[];
  summary: { total: number; open: number; done: number };
} {
  const items = loadTodos();
  const done = items.filter((t) => t.done).length;
  return { todos: items, summary: { total: items.length, open: items.length - done, done } };
}

export const todoListTool: Tool = {
  name: "todo_list",
  permission: "allow",
  description:
    "Show the user's todo list: every item with its id, text and done status, plus a summary.",
  parameters: { type: "object", properties: {}, required: [] },
  execute: () => todoSnapshot(),
};

export const todoAddTool: Tool = {
  name: "todo_add",
  permission: "ask",
  description: "Add a new item to the user's todo list. Returns the created item and the full list.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "The task text to add." } },
    required: ["text"],
  },
  execute: (args) => {
    const text = String(args.text ?? "").trim();
    if (!text) return { error: "text is required" };
    const item: TodoItem = { id: todoNextId++, text, done: false, createdAt: Date.now() };
    loadTodos().push(item);
    saveTodos();
    return { added: item, ...todoSnapshot() };
  },
};

export const todoCompleteTool: Tool = {
  name: "todo_complete",
  permission: "ask",
  description:
    "Mark an existing todo item as done, or reopen it, by its numeric id. Returns the updated item and full list.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "integer", description: "The id of the todo item." },
      done: { type: "boolean", description: "Set true to complete, false to reopen. Defaults to true." },
    },
    required: ["id"],
  },
  execute: (args) => {
    const id = Number(args.id);
    const item = loadTodos().find((t) => t.id === id);
    if (!item) return { error: `no todo item with id ${id}` };
    item.done = args.done === undefined ? true : Boolean(args.done);
    saveTodos();
    return { updated: item, ...todoSnapshot() };
  },
};

export const todoRemoveTool: Tool = {
  name: "todo_remove",
  permission: "ask",
  description: "Remove a todo item from the list by its numeric id. Returns the removed item and full list.",
  parameters: {
    type: "object",
    properties: { id: { type: "integer", description: "The id of the todo item." } },
    required: ["id"],
  },
  execute: (args) => {
    const id = Number(args.id);
    const items = loadTodos();
    const idx = items.findIndex((t) => t.id === id);
    if (idx === -1) return { error: `no todo item with id ${id}` };
    const [removed] = items.splice(idx, 1);
    saveTodos();
    return { removed, ...todoSnapshot() };
  },
};

export const todoTools: Tool[] = [
  todoListTool,
  todoAddTool,
  todoCompleteTool,
  todoRemoveTool,
];
