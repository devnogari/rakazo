import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  SnapshotRef,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";

import {
  applyPlaceholderAction,
  boundedComputerActions,
  placeholderObservation,
} from "./computer-support.js";

/**
 * OpenSandbox (opensandbox-group/OpenSandbox) lifecycle API.
 *
 * Each computer is its own Kubernetes pod, so unlike the desktop provider the
 * agent's commands do not share a process tree — or an environment — with the
 * Rakazo worker.
 *
 * Two things about this API are not guessable from its OpenAPI document and are
 * load-bearing here:
 *
 *  - The command stream is `text/event-stream` by content type only. Frames are
 *    bare JSON objects separated by a blank line, with no `data:` prefix, so a
 *    standard SSE parser reads nothing.
 *  - No stream event carries an exit code. Success ends with
 *    `execution_complete`; failure ends with an `error` frame whose
 *    `error.evalue` holds the code as a string — but only when the process
 *    actually ran, since a spawn failure puts a message there instead. The
 *    authoritative value is `GET /command/status/{id}`, keyed by the id that
 *    arrives in the opening `init` frame.
 */
const WORKSPACE_ROOT = "/workspace";
const DEFAULT_IMAGE = "python:3.11-slim";
/** Kept below the sandbox's own idle expiry so a live computer is renewed, not recreated. */
const SANDBOX_TTL_SECONDS = 3600;
const EXPORT_BATCH_BYTES = 4 * 1024 * 1024;

interface OpenSandboxOptions {
  url: string;
  apiKey: string;
  image?: string;
  cpu?: string;
  memory?: string;
}

/** The server rejects a create without limits when no pool is referenced. */
const DEFAULT_CPU = "1";
const DEFAULT_MEMORY = "1Gi";

interface CommandOutcome {
  commandId?: string;
  failureCode?: number;
  completed: boolean;
}

/** execd reports mode as octal digits rendered in decimal: 755, not 0o755. */
function isExecutableMode(mode: number | undefined): boolean {
  if (typeof mode !== "number") return false;
  return Math.floor(mode / 100) % 10 >= 5 && mode % 2 !== 0
    ? true
    : Math.floor(mode / 100) % 2 === 1;
}

/**
 * execd takes one string and runs it through a shell, but callers pass real
 * argv. Joining with spaces is wrong for the shape Rakazo actually sends —
 * `["bash", "-c", script, argv0, arg1]` — because the trailing words become
 * `$0`/`$1` of the joined string rather than staying arguments, and the script
 * itself is lost. That surfaces as `bash: line N: : No such file or directory`.
 */
export function commandStringFor(argv: readonly string[]): string {
  const shellIndex = argv.findIndex((entry) => entry === "-c");
  if (shellIndex > 0 && argv[shellIndex + 1] !== undefined) {
    const script = argv[shellIndex + 1] as string;
    // `bash -c script name arg1` assigns the first trailing word to $0 and the
    // rest to $1.., but `set --` starts at $1. Dropping that first word keeps
    // the numbering the script expects; otherwise every positional shifts by
    // one and $1 lands on the argv0 label.
    const positional = argv.slice(shellIndex + 3);
    if (positional.length === 0) return script;
    return `set -- ${positional.map(shellQuote).join(" ")}\n${script}`;
  }
  return argv.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function joinWorkspace(target: string): string {
  if (!target) return WORKSPACE_ROOT;
  if (target.startsWith("/")) return target;
  return `${WORKSPACE_ROOT}/${target}`;
}

export class OpenSandboxProvider implements SandboxProvider {
  private readonly base: string;
  private readonly image: string;
  /** Sandbox id -> resolved execd proxy base, so each command does not re-resolve. */
  private readonly execdBases = new Map<string, string>();

  constructor(private readonly opts: OpenSandboxOptions) {
    // Accept the base with or without the version segment. Operators reasonably
    // configure the URL they see in the spec (".../v1"), and silently doubling
    // it produces a 404 that reads like the server is missing, not a config
    // typo.
    this.base = opts.url.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.image = opts.image?.trim() || DEFAULT_IMAGE;
  }

  describe() {
    return {
      id: "opensandbox",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: false,
        // execd exposes a /pty websocket, but it is undocumented in the pinned
        // spec, so it is not claimed here.
        pty: false,
        // The Kubernetes runtime answers 501 for snapshots and this deployment
        // removed the snapshot job RBAC entirely.
        snapshots: false,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      },
    };
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { "OPEN-SANDBOX-API-KEY": this.opts.apiKey, ...extra };
  }

  private async lifecycle(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    return fetch(`${this.base}/v1${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
      signal,
    });
  }

  private async execdBase(computer: ComputerRef, signal: AbortSignal | undefined): Promise<string> {
    const cached = this.execdBases.get(computer.providerRef);
    if (cached) return cached;
    const response = await this.lifecycle(
      `/sandboxes/${computer.providerRef}/endpoints/44772?use_server_proxy=true`,
      { method: "GET" },
      signal,
    );
    if (!response.ok) {
      throw new Error(`OpenSandbox endpoint lookup failed (${response.status})`);
    }
    const body = (await response.json()) as { endpoint?: string };
    if (!body.endpoint) throw new Error("OpenSandbox returned no execd endpoint");
    // The server reports a host-relative endpoint without a scheme.
    const resolved = body.endpoint.startsWith("http")
      ? body.endpoint
      : `${new URL(this.base).protocol}//${body.endpoint}`;
    this.execdBases.set(computer.providerRef, resolved);
    return resolved;
  }

  private async execd(
    computer: ComputerRef,
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const base = await this.execdBase(computer, signal);
    return fetch(`${base}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
      signal,
    });
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef) {
      const existing = await this.lifecycle(
        `/sandboxes/${request.providerRef}`,
        { method: "GET" },
        context.signal,
      );
      if (existing.ok) {
        const body = (await existing.json()) as { status?: { state?: string } };
        // Paused/Resuming are unreachable on the Kubernetes runtime, so anything
        // that is not Running is gone rather than recoverable.
        if (body.status?.state === "Running") {
          return {
            id: request.providerRef,
            botId: request.botId,
            kind: "opensandbox",
            providerRef: request.providerRef,
            fresh: false,
          };
        }
      }
      this.execdBases.delete(request.providerRef);
    }

    const created = await this.lifecycle(
      "/sandboxes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image: { uri: this.image },
          entrypoint: ["tail", "-f", "/dev/null"],
          timeout: SANDBOX_TTL_SECONDS,
          // Required by the server unless a poolRef is given; omitting it is a
          // 422, not a default.
          resourceLimits: {
            cpu: this.opts.cpu?.trim() || DEFAULT_CPU,
            memory: this.opts.memory?.trim() || DEFAULT_MEMORY,
          },
          metadata: { botId: request.botId, managedBy: "rakazo" },
        }),
      },
      context.signal,
    );
    if (!created.ok) {
      throw new Error(
        `OpenSandbox create failed (${created.status}): ${(await created.text()).slice(0, 200)}`,
      );
    }
    const body = (await created.json()) as { id: string };
    return {
      id: body.id,
      botId: request.botId,
      kind: "opensandbox",
      providerRef: body.id,
      fresh: true,
    };
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const response = await this.execd(
      computer,
      "/directories",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [WORKSPACE_ROOT]: { mode: 755 } }),
      },
      context.signal,
    );
    if (!response.ok) {
      throw new Error(`OpenSandbox prepare failed (${response.status})`);
    }
  }

  /**
   * Parses the frame stream and yields output as it arrives.
   *
   * Returns what the caller needs to settle the exit code: the command id from
   * the `init` frame, and whether the stream ended in success or with a parsed
   * failure code.
   */
  private async *readCommandStream(
    response: Response,
    outcome: CommandOutcome,
  ): AsyncIterable<ProcessEvent> {
    const body = response.body;
    if (!body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        if (!frame) continue;
        let event: {
          type?: string;
          text?: string;
          error?: { evalue?: string };
        };
        try {
          event = JSON.parse(frame);
        } catch {
          continue;
        }
        switch (event.type) {
          case "init":
            outcome.commandId = event.text;
            break;
          case "stdout":
            if (event.text) yield { type: "stdout", data: event.text };
            break;
          case "stderr":
            if (event.text) yield { type: "stderr", data: event.text };
            break;
          case "error": {
            const parsed = Number(event.error?.evalue);
            // A spawn failure puts a message here instead of a number.
            outcome.failureCode = Number.isInteger(parsed) ? parsed : 1;
            break;
          }
          case "execution_complete":
            outcome.completed = true;
            break;
          default:
            break;
        }
      }
    }
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const response = await this.execd(
      computer,
      "/command",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: commandStringFor(request.argv),
          cwd: joinWorkspace(request.cwd ?? ""),
          ...(request.env ? { envs: request.env } : {}),
          timeout: timeoutMs,
        }),
      },
      context.signal,
    );
    if (!response.ok) {
      yield { type: "stderr", data: `command rejected (${response.status})` };
      yield { type: "exit", code: 1 };
      return;
    }

    const outcome: CommandOutcome = { completed: false };
    yield* this.readCommandStream(response, outcome);

    if (outcome.completed) {
      yield { type: "exit", code: 0 };
      return;
    }
    // Ask for the authoritative code; fall back to what the stream implied when
    // the lookup itself fails.
    if (outcome.commandId) {
      try {
        const status = await this.execd(
          computer,
          `/command/status/${outcome.commandId}`,
          { method: "GET" },
          context.signal,
        );
        if (status.ok) {
          const body = (await status.json()) as { exit_code?: number | null };
          if (typeof body.exit_code === "number") {
            yield { type: "exit", code: body.exit_code };
            return;
          }
        }
      } catch {
        // fall through to the stream-derived code
      }
    }
    yield { type: "exit", code: outcome.failureCode ?? 1 };
  }

  async inspectBackgroundWork(
    computer: ComputerRef,
    markerId: string,
    context: AdapterContext,
  ): Promise<"active" | "idle" | "unknown"> {
    const response = await this.execd(
      computer,
      `/command/status/${markerId}`,
      { method: "GET" },
      context.signal,
    );
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { running?: boolean };
    if (typeof body.running !== "boolean") return "unknown";
    return body.running ? "active" : "idle";
  }

  async listFiles(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const target = joinWorkspace(path);
    const response = await this.execd(
      computer,
      `/directories/list?path=${encodeURIComponent(target)}&depth=1`,
      { method: "GET" },
      context.signal,
    );
    if (!response.ok) return [];
    const entries = (await response.json()) as Array<{
      path: string;
      type: string;
      size: number;
      mode?: number;
    }>;
    return entries.map((entry) => ({
      path: entry.path,
      kind: entry.type === "directory" ? ("dir" as const) : ("file" as const),
      size: entry.size,
      executable: isExecutableMode(entry.mode),
    }));
  }

  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const target = joinWorkspace(path);
    if (options?.maxBytes !== undefined) {
      const info = await this.execd(
        computer,
        `/files/info?path=${encodeURIComponent(target)}`,
        { method: "GET" },
        context.signal,
      );
      if (info.ok) {
        const body = (await info.json()) as Record<string, { size?: number }>;
        const size = Object.values(body)[0]?.size;
        if (typeof size === "number" && size > options.maxBytes) {
          throw new Error(`File exceeds ${options.maxBytes} bytes`);
        }
      }
    }
    const response = await this.execd(
      computer,
      `/files/download?path=${encodeURIComponent(target)}`,
      { method: "GET" },
      context.signal,
    );
    if (!response.ok) throw new Error(`File not found: ${path}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    const target = joinWorkspace(file.path);
    const form = new FormData();
    // Both parts must be sent as files; a plain field is rejected with
    // "metadata file is missing".
    form.append(
      "metadata",
      new Blob([JSON.stringify({ path: target, mode: file.executable ? 755 : 644 })], {
        type: "application/json",
      }),
      "metadata.json",
    );
    form.append("file", new Blob([file.content as BlobPart]), "upload.bin");
    const response = await this.execd(
      computer,
      "/files/upload",
      { method: "POST", body: form },
      context.signal,
    );
    if (!response.ok) {
      throw new Error(`Upload failed (${response.status}) for ${file.path}`);
    }
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    // The pattern matches basenames only, but the walk is always recursive, so
    // "*" yields every file beneath the root.
    const response = await this.execd(
      computer,
      `/files/search?path=${encodeURIComponent(WORKSPACE_ROOT)}&pattern=*`,
      { method: "GET" },
      context.signal,
    );
    if (!response.ok) return;
    const entries = (await response.json()) as Array<{
      path: string;
      size: number;
      mode?: number;
    }>;
    let budget = 0;
    for (const entry of entries) {
      if (context.signal.aborted) return;
      if (budget > EXPORT_BATCH_BYTES) return;
      budget += entry.size;
      try {
        const content = await this.readFile(computer, entry.path, context);
        yield {
          path: entry.path.startsWith(`${WORKSPACE_ROOT}/`)
            ? entry.path.slice(WORKSPACE_ROOT.length + 1)
            : entry.path,
          content,
          executable: isExecutableMode(entry.mode),
        };
      } catch {
        // A file that vanished mid-export must not abort the whole checkpoint.
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    for await (const file of files) {
      if (context.signal.aborted) return;
      await this.writeFile(computer, file, context);
    }
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    await this.lifecycle(
      `/sandboxes/${computer.providerRef}/renew-expiration`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeout: SANDBOX_TTL_SECONDS }),
      },
      undefined,
    ).catch(() => undefined);
  }

  /**
   * Pause is 501 on the Kubernetes runtime, so a stop has to be a delete. The
   * lifecycle checkpoints the workspace before calling this, so the work is
   * preserved; the cost is a cold create on the next run rather than a resume.
   */
  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.destroy(computer, context);
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    this.execdBases.delete(computer.providerRef);
    const response = await this.lifecycle(
      `/sandboxes/${computer.providerRef}`,
      { method: "DELETE" },
      context.signal,
    );
    // Already gone is the desired state, not a failure.
    if (!response.ok && response.status !== 404) {
      throw new Error(`OpenSandbox delete failed (${response.status})`);
    }
  }

  // --- Non-graphical surface -------------------------------------------------
  // These sandboxes have no display: the pods drop every capability and carry no
  // X server, so the same placeholder treatment the desktop provider uses is the
  // honest answer here.

  async connectScreen(
    _computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    return {
      url: null,
      mimeType: "text/plain",
      close: async () => undefined,
    };
  }

  async sendInput(
    _computer: ComputerRef,
    _input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    // No display to deliver input to.
  }

  async observe(_computer: ComputerRef, _context?: AdapterContext) {
    return placeholderObservation("headless");
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, _context: AdapterContext) {
    const actions = boundedComputerActions(request.actions);
    const box = { screen: "headless" };
    for (const action of actions) applyPlaceholderAction(box, action);
    return {
      completed: actions.length,
      ...(request.observe === false ? {} : { observation: await this.observe(computer) }),
    };
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext): Promise<SnapshotRef> {
    // Declared unsupported in describe(); this exists only to satisfy the
    // interface and is not reachable through a capability-gated caller.
    return { id: `opensandbox-snap-${computer.id}`, createdAt: new Date().toISOString() };
  }
}
