import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import * as pulumi from "@pulumi/pulumi";

// Fake Loopia API; public DNS lookups are replaced by spies on the resolver. Nothing here
// reaches the network (every read test asserts that the spy was the one used).

const api = vi.hoisted(() => ({
  calls: [] as { method: string; params: unknown[] }[],
  failures: [] as string[],
}));
const dnsFake = vi.hoisted(() => ({ result: [] as string[] | Error }));

vi.mock("xmlrpc", () => ({
  createSecureClient: () => ({
    methodCall(method: string, params: unknown[], cb: (err: unknown, value?: unknown) => void) {
      api.calls.push({ method, params });
      const failure = api.failures.shift();
      if (failure) return cb(new Error(failure));
      return cb(null, "OK");
    },
  }),
}));

import { loopiaNameserversProvider as provider } from "../src/loopia";

const USER = "test-user@loopiaapi";
const PASSWORD = "not-a-real-password";
const base = {
  domain: "example.com",
  nameservers: ["anna.ns.example.net", "bart.ns.example.net"],
  loopiaUser: USER,
  loopiaPassword: PASSWORD,
};

async function run<T>(p: Promise<T>): Promise<T> {
  const settled = p.then(
    (v) => ({ v }),
    (e) => ({ e })
  );
  await vi.runAllTimersAsync();
  const r = await settled;
  if ("e" in r) throw r.e;
  return r.v;
}

let resolveNs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  api.calls = [];
  api.failures = [];
  dnsFake.result = [];
  vi.useFakeTimers();
  vi.spyOn(dns.promises.Resolver.prototype, "setServers").mockImplementation(() => {});
  resolveNs = vi.spyOn(dns.promises.Resolver.prototype, "resolveNs").mockImplementation((async () => {
    if (dnsFake.result instanceof Error) throw dnsFake.result;
    return dnsFake.result;
  }) as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("check", () => {
  it("accepts two or more hostnames", async () => {
    const r = await provider.check!({} as any, base);
    expect(r.failures).toBeUndefined();
  });

  it("rejects fewer than two nameservers", async () => {
    const r = await provider.check!({} as any, { ...base, nameservers: ["anna.ns.example.net"] });
    expect(r.failures?.[0].reason).toMatch(/at least two/);
  });

  it("rejects entries that are not hostnames", async () => {
    const r = await provider.check!({} as any, {
      ...base,
      nameservers: ["anna.ns.example.net", "not a host"],
    });
    expect(r.failures?.[0].reason).toMatch(/not a hostname/);
  });

  it("accepts a trailing dot", async () => {
    const r = await provider.check!({} as any, {
      ...base,
      nameservers: ["anna.ns.example.net.", "bart.ns.example.net."],
    });
    expect(r.failures).toBeUndefined();
  });

  it("rejects a known value that is not a list", async () => {
    const r = await provider.check!({} as any, { ...base, nameservers: "ns1.example.net" as any });
    expect(r.failures?.[0].reason).toMatch(/list of hostnames/);
  });

  it("skips validation while the list is unknown during a preview", async () => {
    const unknown = pulumi.runtime.unknownValue;
    expect((await provider.check!({} as any, { ...base, nameservers: unknown as any })).failures).toBeUndefined();
    expect(
      (await provider.check!({} as any, { ...base, nameservers: [unknown, "bart.ns.example.net"] })).failures
    ).toBeUndefined();
  });
});

describe("create and update", () => {
  it("sets the nameservers with credentials first", async () => {
    const res = await run(provider.create!(base));
    expect(res.id).toBe("example.com");
    expect(res.outs).toMatchObject({ nameservers: base.nameservers });
    expect(api.calls).toEqual([
      {
        method: "updateDNSServers",
        params: [USER, PASSWORD, "example.com", base.nameservers],
      },
    ]);
  });

  it("update sets the new list", async () => {
    const next = { ...base, nameservers: ["c.ns.example.org", "d.ns.example.org"] };
    const res = await run(provider.update!("example.com", base, next));
    expect(api.calls[0].params.slice(2)).toEqual(["example.com", next.nameservers]);
    expect(res.outs).toMatchObject({ nameservers: next.nameservers });
  });

  it("surfaces API errors without leaking credentials", async () => {
    api.failures.push("AUTH_ERROR");
    const err = await run(provider.create!(base)).catch((e) => e);
    expect(String(err.message)).toContain("AUTH_ERROR");
    expect(String(err.message)).not.toContain(PASSWORD);
    expect(String(err.message)).not.toContain(USER);
  });
});

describe("diff", () => {
  it("is unchanged for the same list", async () => {
    expect(await provider.diff!("id", base, base)).toEqual({ changes: false, replaces: [] });
  });

  it("ignores order, case and trailing dots", async () => {
    const reordered = { ...base, nameservers: ["BART.ns.example.net.", "anna.NS.example.net"] };
    expect((await provider.diff!("id", base, reordered)).changes).toBe(false);
  });

  it("detects a different list", async () => {
    const other = { ...base, nameservers: ["c.ns.example.org", "d.ns.example.org"] };
    expect(await provider.diff!("id", base, other)).toEqual({ changes: true, replaces: [] });
  });

  it("replaces when only the domain changes, and reports it as a change", async () => {
    const r = await provider.diff!("id", base, { ...base, domain: "example.org" });
    expect(r).toEqual({ changes: true, replaces: ["domain"] });
  });

  it("treats an unknown list as a change", async () => {
    const r = await provider.diff!("id", base, { ...base, nameservers: "unknown" as any });
    expect(r.changes).toBe(true);
  });
});

describe("read (refresh)", () => {
  it("keeps state when public DNS agrees, in any order or case", async () => {
    dnsFake.result = ["Bart.NS.example.net", "anna.ns.example.net"];
    const res = await provider.read!("example.com", base);
    expect(resolveNs).toHaveBeenCalledWith("example.com");
    expect(res.props).toEqual(base);
    expect(api.calls).toHaveLength(0); // the API is never used to read
  });

  it("tolerates extra nameservers at the zone apex", async () => {
    dnsFake.result = ["anna.ns.example.net", "bart.ns.example.net", "extra.ns.example.net"];
    const res = await provider.read!("example.com", base);
    expect(resolveNs).toHaveBeenCalledWith("example.com");
    expect(res.props).toEqual(base);
  });

  it("reports drift when a configured nameserver is missing from public DNS", async () => {
    dnsFake.result = ["anna.ns.example.net", "other.ns.example.net"];
    const res = await provider.read!("example.com", base);
    expect(resolveNs).toHaveBeenCalledWith("example.com");
    expect(res.props?.nameservers).toEqual(["anna.ns.example.net", "other.ns.example.net"]);
  });

  it("on import, takes the domain from the id and records the observed nameservers", async () => {
    dnsFake.result = ["anna.ns.example.net", "bart.ns.example.net"];
    const res = await provider.read!("example.com", {} as any);
    expect(resolveNs).toHaveBeenCalledWith("example.com");
    expect(res.id).toBe("example.com");
    expect(res.props).toEqual({
      domain: "example.com",
      nameservers: ["anna.ns.example.net", "bart.ns.example.net"],
    });
  });

  it("reports the observed list when public DNS differs", async () => {
    dnsFake.result = ["ns1.loopia.se", "ns2.loopia.se"];
    const res = await provider.read!("example.com", base);
    expect(resolveNs).toHaveBeenCalledWith("example.com");
    expect(res.props?.nameservers).toEqual(["ns1.loopia.se", "ns2.loopia.se"]);
    expect(res.props?.domain).toBe("example.com");
  });

  it("keeps state when the lookup fails", async () => {
    dnsFake.result = new Error("queryNs ETIMEOUT");
    const res = await provider.read!("example.com", base);
    expect(resolveNs).toHaveBeenCalledWith("example.com");
    expect(res.props).toEqual(base);
  });

  it("keeps state when the lookup returns nothing", async () => {
    dnsFake.result = [];
    const res = await provider.read!("example.com", base);
    expect(resolveNs).toHaveBeenCalledWith("example.com");
    expect(res.props).toEqual(base);
  });
});

describe("delete", () => {
  it("does nothing, and makes no API call", async () => {
    await provider.delete!("example.com", base);
    expect(api.calls).toHaveLength(0);
  });
});
