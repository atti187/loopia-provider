import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Runs against the compiled output (`npm run build` first; `prepublishOnly` does).
// No mocks here: Pulumi must be able to serialize the provider closure for real.
// Nothing calls Loopia: the provider functions are only serialized, never invoked.

const distIndex = join(__dirname, "..", "dist", "index.js");

describe.skipIf(!existsSync(distIndex))("built package (dist)", () => {
  const dist = () => require(distIndex) as typeof import("../src/index");

  it("exports only the public API", () => {
    expect(Object.keys(dist()).sort()).toEqual(["LoopiaDomainNameservers", "LoopiaZoneRecord"]);
  });

  it("registers as a dynamic resource with credentials as secret outputs", async () => {
    const seen: { type: string; inputs: Record<string, unknown> }[] = [];
    await pulumi.runtime.setMocks(
      {
        newResource: (args) => {
          seen.push({ type: args.type, inputs: args.inputs });
          return { id: `${args.name}-id`, state: { ...args.inputs, recordId: 1 } };
        },
        call: (args) => args.inputs,
      },
      "proj",
      "stack",
      false
    );
    const { LoopiaZoneRecord } = dist();
    const rec = new LoopiaZoneRecord("r", {
      domain: "example.com",
      subdomain: "@",
      type: "A",
      ttl: 3600,
      rdata: "192.0.2.1",
      loopiaUser: pulumi.secret("test-user@loopiaapi"),
      loopiaPassword: pulumi.secret("not-a-real-password"),
    });
    await new Promise<void>((resolve) => rec.recordId.apply(() => resolve()));
    expect(seen[0].type).toBe("pulumi-nodejs:dynamic:Resource");
    expect(typeof seen[0].inputs["__provider"]).toBe("string");
    expect(String(seen[0].inputs["__provider"]).length).toBeGreaterThan(0);
  });

  it("registers the nameservers resource as a dynamic resource", async () => {
    const seen: { type: string; inputs: Record<string, unknown> }[] = [];
    await pulumi.runtime.setMocks(
      {
        newResource: (args) => {
          seen.push({ type: args.type, inputs: args.inputs });
          return { id: args.inputs["domain"], state: args.inputs };
        },
        call: (args) => args.inputs,
      },
      "proj",
      "stack",
      false
    );
    const { LoopiaDomainNameservers } = dist();
    const res = new LoopiaDomainNameservers("ns", {
      domain: "example.com",
      nameservers: ["anna.ns.example.net", "bart.ns.example.net"],
      loopiaUser: pulumi.secret("test-user@loopiaapi"),
      loopiaPassword: pulumi.secret("not-a-real-password"),
    });
    await new Promise<void>((resolve) => res.urn.apply(() => resolve()));
    expect(seen[0].type).toBe("pulumi-nodejs:dynamic:Resource");
    expect(String(seen[0].inputs["__provider"]).length).toBeGreaterThan(0);
  });

  it("serializes the nameservers provider, with dns as a built-in require", async () => {
    const { loopiaNameserversProvider } = require(join(__dirname, "..", "dist", "loopia.js"));
    const { text } = await pulumi.runtime.serializeFunction(() => loopiaNameserversProvider);
    expect(text).toContain('require("dns")');
    expect(text).not.toContain("not-a-real-password");
  });

  it("serializes the provider without helper shims or credentials", async () => {
    const { text } = await pulumi.runtime.serializeFunction(() => require(distIndex));
    expect(text).not.toContain("not-a-real-password");
  });
});
