// The assistant's hands: tools Claude can call on this computer.
// Each tool has a Zod schema (validated before it runs) and a `run` function
// that returns a string for Claude to read.

const fs = require("node:fs/promises");
const path = require("node:path");
const { z } = require("zod");
const calendar = require("./calendar");

const MAX_READ_BYTES = 400_000;

const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time such as 2026-11-12T09:00:00+04:00");

/**
 * Resolve a model-supplied path inside the workspace folder, refusing
 * anything that escapes it (.., absolute paths, symlinks pointing out).
 */
async function resolveInWorkspace(workspaceDir, relPath) {
  if (!workspaceDir) {
    throw new Error("No workspace folder is set. Ask the user to choose one in Settings.");
  }
  const root = await fs.realpath(workspaceDir);
  const target = path.resolve(root, relPath || ".");
  const escapes = (p) => {
    const rel = path.relative(root, p);
    return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  };
  if (escapes(target)) throw new Error("That path is outside the workspace folder.");
  // If it already exists, make sure a symlink does not lead out of the root.
  try {
    if (escapes(await fs.realpath(target))) throw new Error("That path is outside the workspace folder.");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return target;
}

/**
 * @param {object} deps
 * @param {import('./store').Store} deps.store
 * @param {(url: string) => Promise<void>} deps.openExternal
 * @param {(filePath: string) => Promise<string>} deps.openPath
 * @param {(message: string, detail: string) => Promise<boolean>} deps.confirm
 * @param {() => void} [deps.onDataChanged] called after tasks or memory change
 */
function createTools({ store, openExternal, openPath, confirm, onDataChanged = () => {} }) {
  const tools = [
    {
      name: "remember",
      description:
        "Save a durable fact about the user to long-term memory: preferences, people they work with, ongoing projects, how they like things done. Call this whenever you learn something that will still matter in a future conversation. Do not save one-off details of the current request.",
      schema: z.object({ fact: z.string().min(1).describe("One self-contained sentence.") }),
      run: async ({ fact }) => {
        const entry = store.addMemory(fact);
        onDataChanged();
        return `Saved (id ${entry.id}).`;
      },
    },
    {
      name: "forget",
      description: "Delete a long-term memory by its id, when it is wrong, outdated, or the user asks you to forget it.",
      schema: z.object({ id: z.string().min(1) }),
      run: async ({ id }) => {
        const ok = store.deleteMemory(id);
        onDataChanged();
        return ok ? "Deleted." : `No memory with id ${id}.`;
      },
    },
    {
      name: "add_task",
      description:
        "Add a task to the user's to-do list. Set remind_at to make the computer notify them at that moment. Times must be ISO 8601 with the user's UTC offset.",
      schema: z.object({
        title: z.string().min(1),
        due: isoDateTime.optional().describe("When the task is due."),
        remind_at: isoDateTime.optional().describe("When to pop up a reminder."),
        notes: z.string().optional(),
      }),
      run: async ({ title, due, remind_at, notes }) => {
        const task = store.addTask({ title, due: due ?? null, remindAt: remind_at ?? null, notes: notes ?? "" });
        onDataChanged();
        return JSON.stringify(task);
      },
    },
    {
      name: "list_tasks",
      description: "List the user's tasks. Returns open tasks unless include_done is true.",
      schema: z.object({ include_done: z.boolean().optional() }),
      run: async ({ include_done }) => {
        const tasks = store.getTasks().filter((t) => include_done || !t.done);
        return tasks.length ? JSON.stringify(tasks) : "No tasks.";
      },
    },
    {
      name: "update_task",
      description: "Change a task: mark it done, rename it, or move its due date or reminder. Pass only the fields to change.",
      schema: z.object({
        id: z.string().min(1),
        title: z.string().min(1).optional(),
        done: z.boolean().optional(),
        due: isoDateTime.nullable().optional(),
        remind_at: isoDateTime.nullable().optional(),
        notes: z.string().optional(),
      }),
      run: async ({ id, remind_at, ...rest }) => {
        const patch = { ...rest };
        if (remind_at !== undefined) patch.remindAt = remind_at;
        const task = store.updateTask(id, patch);
        onDataChanged();
        return task ? JSON.stringify(task) : `No task with id ${id}.`;
      },
    },
    {
      name: "delete_task",
      description: "Remove a task entirely. Prefer update_task with done=true when the user finished it.",
      schema: z.object({ id: z.string().min(1) }),
      run: async ({ id }) => {
        const ok = store.deleteTask(id);
        onDataChanged();
        return ok ? "Deleted." : `No task with id ${id}.`;
      },
    },
    {
      name: "get_calendar_events",
      description:
        "Read the user's calendar between two moments (read-only). Use it for questions about their schedule and for daily briefings.",
      schema: z.object({ from: isoDateTime, to: isoDateTime }),
      run: async ({ from, to }) => {
        const urls = store.getSettings().calendarUrls;
        if (urls.length === 0) {
          return "No calendar is connected. The user can paste their calendar's private iCal link in Settings.";
        }
        const { events, errors } = await calendar.getEvents(urls, new Date(from), new Date(to));
        return JSON.stringify({ events, errors });
      },
    },
    {
      name: "open_url",
      description: "Open a web page in the user's default browser.",
      schema: z.object({ url: z.string().url() }),
      run: async ({ url }) => {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("Only http and https links can be opened.");
        }
        await openExternal(parsed.toString());
        return "Opened in the browser.";
      },
    },
    {
      name: "list_files",
      description: "List files and folders inside the user's workspace folder. Paths are relative to that folder.",
      schema: z.object({ path: z.string().optional().describe("Sub-folder to list; omit for the top level.") }),
      run: async ({ path: rel }) => {
        const dir = await resolveInWorkspace(store.getSettings().workspaceDir, rel);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        if (entries.length === 0) return "Empty folder.";
        return entries
          .filter((e) => !e.name.startsWith("."))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
      },
    },
    {
      name: "read_file",
      description: "Read a text file (notes, CSV, Markdown, code) from the workspace folder.",
      schema: z.object({ path: z.string().min(1) }),
      run: async ({ path: rel }) => {
        const file = await resolveInWorkspace(store.getSettings().workspaceDir, rel);
        const stat = await fs.stat(file);
        if (stat.size > MAX_READ_BYTES) {
          throw new Error(
            `File is ${stat.size} bytes, over the ${MAX_READ_BYTES}-byte limit. Tell the user it is too large to read in one go.`,
          );
        }
        const buf = await fs.readFile(file);
        if (buf.includes(0)) throw new Error("This looks like a binary file, not text.");
        return buf.toString("utf8");
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a text file in the workspace folder, for example to save a draft, report, or notes. The user is asked to approve each write.",
      schema: z.object({ path: z.string().min(1), content: z.string() }),
      run: async ({ path: rel, content }) => {
        const file = await resolveInWorkspace(store.getSettings().workspaceDir, rel);
        let exists = true;
        try {
          await fs.access(file);
        } catch {
          exists = false;
        }
        const approved = await confirm(
          exists ? `Overwrite ${rel}?` : `Create ${rel}?`,
          `${content.length.toLocaleString()} characters will be written to:\n${file}`,
        );
        if (!approved) return "The user declined this write.";
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, "utf8");
        return `Saved ${rel}.`;
      },
    },
    {
      name: "open_file",
      description: "Open a file or folder from the workspace in its default desktop app.",
      schema: z.object({ path: z.string().min(1) }),
      run: async ({ path: rel }) => {
        const file = await resolveInWorkspace(store.getSettings().workspaceDir, rel);
        await fs.access(file);
        const error = await openPath(file);
        if (error) throw new Error(error);
        return "Opened.";
      },
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  /** Tool definitions in the shape the Claude API expects. */
  const definitions = tools.map((t) => {
    const { $schema, ...input_schema } = z.toJSONSchema(t.schema);
    return { name: t.name, description: t.description, input_schema, eager_input_streaming: true };
  });

  /** Validate and run one tool call. Never throws: failures become error results. */
  async function execute(name, input) {
    const tool = byName.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      return { content: `Invalid input: ${z.prettifyError(parsed.error)}`, isError: true };
    }
    try {
      return { content: await tool.run(parsed.data), isError: false };
    } catch (err) {
      return { content: err.message, isError: true };
    }
  }

  return { definitions, execute };
}

module.exports = { createTools, resolveInWorkspace };
