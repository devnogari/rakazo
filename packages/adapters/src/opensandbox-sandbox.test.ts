import { describe, expect, it, vi } from "vitest";

import { commandStringFor, OpenSandboxProvider } from "./opensandbox-sandbox.js";

const BASE = "http://opensandbox.test";
const SANDBOX_ID = "sbx-1";

function context() {
  return {
    operationId: "op",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  } as never;
}

function computer() {
  return {
    id: SANDBOX_ID,
    botId: "bot-1",
    kind: "opensandbox" as const,
    providerRef: SANDBOX_ID,
  };
}

/** execd writes bare JSON objects separated by a blank line, with no `data:` prefix. */
function frames(...events: unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n\n`).join("");
}

function endpointResponse() {
  return new Response(
    JSON.stringify({ endpoint: `opensandbox.test/v1/sandboxes/${SANDBOX_ID}/proxy/44772` }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function streamResponse(body: string) {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(iterable: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function provider() {
  return new OpenSandboxProvider({ url: BASE, apiKey: "key" });
}

describe("OpenSandboxProvider.execute", () => {
  it("streams stdout and stderr, and exits 0 on execution_complete", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(endpointResponse())
      .mockResolvedValueOnce(
        streamResponse(
          frames(
            { type: "init", text: "cmd-1" },
            { type: "ping", text: "pong" },
            { type: "stdout", text: "hello" },
            { type: "stderr", text: "warn" },
            { type: "execution_complete", execution_time: 4 },
          ),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(
      provider().execute(computer(), { argv: ["echo", "hello"] }, context()),
    );

    expect(events).toEqual([
      { type: "stdout", data: "hello" },
      { type: "stderr", data: "warn" },
      { type: "exit", code: 0 },
    ]);
    vi.unstubAllGlobals();
  });

  it("asks /command/status for the exit code, because no stream event carries one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(endpointResponse())
      .mockResolvedValueOnce(
        streamResponse(
          frames(
            { type: "init", text: "cmd-7" },
            { type: "stdout", text: "out" },
            { type: "error", error: { ename: "CommandExecError", evalue: "7" } },
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ exit_code: 7, running: false }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(
      provider().execute(computer(), { argv: ["exit", "7"] }, context()),
    );

    expect(events).toContainEqual({ type: "exit", code: 7 });
    const statusUrl = fetchMock.mock.calls[2]?.[0] as string;
    expect(statusUrl).toContain("/command/status/cmd-7");
    vi.unstubAllGlobals();
  });

  it("falls back to the error frame's code when the status lookup fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(endpointResponse())
      .mockResolvedValueOnce(
        streamResponse(
          frames(
            { type: "init", text: "cmd-3" },
            { type: "error", error: { ename: "CommandExecError", evalue: "3" } },
          ),
        ),
      )
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(provider().execute(computer(), { argv: ["x"] }, context()));

    expect(events).toContainEqual({ type: "exit", code: 3 });
    vi.unstubAllGlobals();
  });

  it("treats a spawn failure as exit 1 rather than NaN", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(endpointResponse())
      .mockResolvedValueOnce(
        streamResponse(
          frames({
            type: "error",
            error: { ename: "CommandExecError", evalue: "fork/exec: no such file" },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(provider().execute(computer(), { argv: ["nope"] }, context()));

    expect(events).toContainEqual({ type: "exit", code: 1 });
    vi.unstubAllGlobals();
  });

  it("always terminates with an exit event when the command is rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(endpointResponse())
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(provider().execute(computer(), { argv: ["x"] }, context()));

    expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
    vi.unstubAllGlobals();
  });
});

describe("OpenSandboxProvider.provision", () => {
  it("reuses a Running sandbox instead of creating a second one", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: SANDBOX_ID, status: { state: "Running" } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ref = await provider().provision(
      { botId: "bot-1", homePath: "/home", providerRef: SANDBOX_ID },
      context(),
    );

    expect(ref).toMatchObject({ providerRef: SANDBOX_ID, fresh: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("creates a replacement when the referenced sandbox is not Running", async () => {
    // Paused/Resuming never occur on the Kubernetes runtime, so anything else is gone.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: { state: "Terminated" } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "sbx-2" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const ref = await provider().provision(
      { botId: "bot-1", homePath: "/home", providerRef: SANDBOX_ID },
      context(),
    );

    expect(ref).toMatchObject({ providerRef: "sbx-2", fresh: true });
    vi.unstubAllGlobals();
  });
});

describe("OpenSandboxProvider.destroy", () => {
  it("treats an already-deleted sandbox as success", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().destroy(computer(), context())).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("raises when the delete genuinely fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().destroy(computer(), context())).rejects.toThrow(/500/);
    vi.unstubAllGlobals();
  });
});

describe("OpenSandboxProvider.describe", () => {
  it("does not claim capabilities this deployment cannot honor", () => {
    const capabilities = provider().describe().capabilities;
    expect(capabilities.graphical).toBe(false);
    // Snapshots are 501 on the Kubernetes runtime and the job RBAC is removed.
    expect(capabilities.snapshots).toBe(false);
    expect(capabilities.persistentHome).toBe(true);
  });
});

describe("OpenSandboxProvider base url", () => {
  it("does not double the version segment when the url already ends in /v1", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "sbx-9" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const withVersion = new OpenSandboxProvider({ url: `${BASE}/v1`, apiKey: "key" });
    await withVersion.provision({ botId: "bot-1", homePath: "/home" }, context());

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/v1/sandboxes`);
    vi.unstubAllGlobals();
  });
});

describe("OpenSandboxProvider.provision request body", () => {
  it("always sends resourceLimits, which the server requires without a poolRef", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "sbx-3" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().provision({ botId: "bot-1", homePath: "/home" }, context());

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.resourceLimits).toEqual({ cpu: "1", memory: "1Gi" });
    expect(body.image.uri).toBe("python:3.11-slim");
    vi.unstubAllGlobals();
  });
});

describe("commandStringFor", () => {
  it("keeps the script when argv is a bash -c invocation", () => {
    // Joining with spaces would drop the script and leave `bash -c echo hi`,
    // which the shell reports as `bash: line N: : No such file or directory`.
    expect(commandStringFor(["bash", "-c", "echo hi"])).toBe("echo hi");
  });

  it("preserves positional arguments that follow the script", () => {
    const command = commandStringFor(["bash", "-c", 'echo "$1"', "probe", "value"]);
    expect(command).toBe("set -- 'probe' 'value'\necho \"$1\"");
  });

  it("quotes a plain argv so arguments survive the shell", () => {
    expect(commandStringFor(["ls", "a b"])).toBe("'ls' 'a b'");
  });

  it("escapes single quotes rather than breaking out of the quoting", () => {
    // POSIX has no escape inside single quotes, so the quote is closed,
    // an escaped quote is emitted, and quoting resumes.
    expect(commandStringFor(["echo", "it's"])).toBe("'echo' 'it'\\''s'");
  });
});
