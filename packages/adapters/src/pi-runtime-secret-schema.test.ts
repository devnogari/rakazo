import { describe, expect, it } from "vitest";

import { builtinAgentTools } from "./builtin-tools.js";

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
