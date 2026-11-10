const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
const { Store } = require("../src/main/store");
const { createTools } = require("../src/main/tools");
const { Agent, buildSystem, MODEL } = require("../src/main/agent");

/**
 * A stand-in for the Anthropic client. `script` is a list of steps; each is
 * either a message object to return, an Error to throw, or a function
 * (params, opts) => message | Promise<message>.
 */
function fakeClient(script) {
  const requests = [];
  const client = {
    beta: {
      messages: {
        stream(params, opts) {
          // Snapshot: the agent mutates its message list after the call.
          requests.push({ ...params, messages: structuredClone(params.messages) });
          const step = script.shift();
          const handlers = {};
          return {
            on(event, fn) {
              handlers[event] = fn;
              return this;
            },
            async finalMessage() {
              if (!step) throw new Error("script exhausted");
              if (step instanceof Error) throw step;
              const message = typeof step === "function" ? await step(params, opts) : step;
              for (const block of message.content) {
                if (block.type === "text") handlers.text?.(block.text);
                if (block.type === "server_tool_use") {
                  handlers.streamEvent?.({ type: "content_block_start", content_block: block });
                }
              }
              return message;
            },
          };
        },
      },
    },
  };
  return { client, requests };
}

const text = (t, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "text", text: t }] });
const toolCall = (id, name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });

function setup(script) {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "nova-agent-")));
  const tools = createTools({ store, openExternal: async () => {}, openPath: async () => "", confirm: async () => true });
  const { client, requests } = fakeClient(script);
  const agent = new Agent({ store, tools, createClient: () => client });
  const events = [];
  const send = (msg, spoken = false) => agent.send(msg, { spoken, onEvent: (e) => events.push(e) });
  return { store, agent, requests, events, send };
}

test("runs tools, feeds results back, and streams text", async () => {
  const { store, agent, requests, events, send } = setup([
    toolCall("tu_1", "add_task", { title: "Send report" }),
    text("Added it."),
  ]);
  assert.deepEqual(await send("add a task to send the report", true), { status: "done" });

  assert.equal(store.getTasks()[0].title, "Send report");
  assert.deepEqual(events, [{ type: "tool", name: "add_task" }, { type: "text", delta: "Added it." }]);

  const [first, second] = requests;
  assert.equal(first.model, MODEL);
  assert.equal(first.fallbacks, "default");
  assert.ok(first.tools.some((t) => t.name === "add_task" && t.eager_input_streaming));
  assert.ok(first.tools.some((t) => t.type === "web_search_20260209"));
  assert.match(first.messages[0].content, /spoken, reply will be read aloud\]\nadd a task/);

  const result = second.messages[2].content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.tool_use_id, "tu_1");
  assert.equal(result.is_error, false);
  assert.equal(agent.messages.length, 4);
});

test("a failing tool is reported to the model as an error result", async () => {
  const { requests, send } = setup([toolCall("tu_1", "read_file", { path: "x.txt" }), text("No workspace yet.")]);
  await send("read x.txt");
  const result = requests[1].messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /No workspace folder/);
});

test("memories and the user's name reach the system prompt", () => {
  const system = buildSystem({ assistantName: "Atlas", userName: "Sam" }, [{ id: "ab12", text: "Works in marketing" }]);
  assert.match(system[0].text, /You are Atlas/);
  assert.match(system[1].text, /Sam/);
  assert.match(system[1].text, /\[ab12\] Works in marketing/);
});

test("falls back to a plain request when the fallback option is rejected", async () => {
  const bad = new Anthropic.BadRequestError(400, {}, "fallbacks: unknown field", new Headers());
  const { agent, requests, send } = setup([bad, text("Hi."), text("Again.")]);
  assert.deepEqual(await send("hello"), { status: "done" });
  assert.equal("fallbacks" in requests[1], false);
  await send("hello again");
  assert.equal("fallbacks" in requests[2], false);
  assert.equal(agent.useFallbacks, false);
});

test("an API failure rolls the turn back and explains itself", async () => {
  const auth = new Anthropic.AuthenticationError(401, {}, "invalid x-api-key", new Headers());
  const { agent, send } = setup([text("First."), toolCall("tu_1", "list_tasks", {}), auth]);
  await send("one");
  const result = await send("two");
  assert.equal(result.status, "error");
  assert.match(result.message, /API key was rejected/);
  assert.equal(agent.messages.length, 2); // only the first, completed exchange
  assert.equal(agent.busy, false);
});

test("a refusal is surfaced and not kept in history", async () => {
  const { agent, send } = setup([{ stop_reason: "refusal", content: [] }]);
  assert.equal((await send("x")).status, "error");
  assert.equal(agent.messages.length, 0);
});

test("paused hosted-tool turns are continued", async () => {
  const paused = { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] };
  const { requests, events, send } = setup([paused, text("Here is what I found.")]);
  assert.equal((await send("research x")).status, "done");
  assert.equal(requests[1].messages.at(-1).role, "assistant");
  assert.deepEqual(events[0], { type: "tool", name: "web_search" });
});

test("a tool call truncated by the length limit is never executed", async () => {
  const cut = { ...toolCall("tu_1", "add_task", { title: "Half" }), stop_reason: "max_tokens" };
  const { store, send } = setup([cut]);
  assert.equal((await send("x")).status, "error");
  assert.deepEqual(store.getTasks(), []);
});

test("a new message interrupts the one in flight without corrupting history", async () => {
  const slow = (_params, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
    });
  const { agent, send } = setup([slow, text("Second answer.")]);
  const first = send("first question");
  await new Promise((r) => setImmediate(r)); // let the first request get under way
  const second = send("second question");
  assert.deepEqual(await first, { status: "cancelled" });
  assert.deepEqual(await second, { status: "done" });
  assert.equal(agent.messages.length, 2);
  assert.match(agent.messages[0].content, /second question/);
});

test("two messages sent back to back: only the second runs", async () => {
  const { agent, requests, send } = setup([text("Only answer.")]);
  const first = send("first");
  const second = send("second");
  assert.deepEqual(await first, { status: "cancelled" });
  assert.deepEqual(await second, { status: "done" });
  assert.equal(requests.length, 1);
  assert.match(agent.messages[0].content, /second/);
});

test("reset during a turn leaves an empty, usable history", async () => {
  const slow = (_params, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
    });
  const { agent, send } = setup([slow, text("Fresh.")]);
  const first = send("first");
  await new Promise((r) => setImmediate(r));
  agent.reset();
  assert.equal((await first).status, "cancelled");
  assert.deepEqual(agent.messages, []);
  assert.equal((await send("again")).status, "done");
  assert.equal(agent.messages.length, 2);
});

test("without an API key the user is pointed to Settings", async () => {
  const { send } = setup([]);
  delete process.env.ANTHROPIC_API_KEY;
  const result = await send("hi");
  assert.match(result.message, /API key in Settings/);
});
