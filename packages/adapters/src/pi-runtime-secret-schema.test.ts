import { describe, expect, it } from "vitest";

import { builtinAgentTools } from "./builtin-tools.js";
import { prepareRequestSecretArguments } from "./pi-runtime.js";

/**
 * `pi-runtime` used to re-declare `request_secret`'s parameters by hand, and the
 * copy omitted `credential`. The model therefore never saw the one argument that
 * makes a credential persist: `request_secret` calls arrived with only
 * `{label, purpose}`, the submitted value had nowhere to be stored, and the tool
 * looked broken from the outside.
 *
 * These assert the canonical schema still carries what the executor requires, so
 * a future hand-rolled override has to fail here rather than silently drop a
 * field again.
 */
function toolNamed(name: string) {
  const tool = builtinAgentTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing builtin tool ${name}`);
  return tool;
}

describe("request_secret parameters", () => {
  it("exposes credential, because the executor only stores a value when it is present", () => {
    const schema = toolNamed("request_secret").inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).toContain("credential");
  });

  it("describes the credential destination fields the executor validates", () => {
    const schema = toolNamed("request_secret").inputSchema as {
      properties?: { credential?: { properties?: Record<string, unknown> } };
    };
    const credential = schema.properties?.credential?.properties ?? {};
    // normalizeSecretDestination rejects the call unless all three resolve.
    expect(Object.keys(credential).sort()).toEqual(["auth", "name", "origin"]);
  });

  it("still offers connectionId, which is the mutually exclusive alternative", () => {
    const schema = toolNamed("request_secret").inputSchema as {
      properties?: Record<string, unknown>;
    };
    // The executor rejects a call that supplies both or neither.
    expect(Object.keys(schema.properties ?? {})).toContain("connectionId");
  });
});

describe("prepareRequestSecretArguments", () => {
  it("keeps credential, which is what makes the value persist", () => {
    const credential = {
      name: "github_pat",
      origin: "https://api.github.com",
      auth: { type: "bearer" },
    };
    expect(
      prepareRequestSecretArguments({ label: "GitHub PAT", purpose: "api_key", credential }),
    ).toEqual({ label: "GitHub PAT", purpose: "api_key", credential });
  });

  it("keeps replace, so an existing credential can be overwritten", () => {
    const credential = { name: "x", origin: "https://api.example.com", auth: { type: "bearer" } };
    const out = prepareRequestSecretArguments({
      label: "x",
      purpose: "api_key",
      credential,
      replace: true,
    });
    expect(out).toMatchObject({ replace: true, credential });
  });

  it("still passes connectionId for the connector-code path", () => {
    const out = prepareRequestSecretArguments({ label: "c", purpose: "otp", connectionId: "abc" });
    expect(out).toEqual({ label: "c", purpose: "otp", connectionId: "abc" });
  });

  it("omits credential and connectionId when absent rather than sending empties", () => {
    // The executor rejects a call that carries both, so neither may be faked in.
    expect(prepareRequestSecretArguments({ label: "c", purpose: "otp" })).toEqual({
      label: "c",
      purpose: "otp",
    });
  });
});
