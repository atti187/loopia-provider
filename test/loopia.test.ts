import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// ── Fake Loopia API ──────────────────────────────────────────────────────────
// `xmlrpc` is mocked, so no test can reach the real API.

interface Rec {
  record_id: number;
  type: string;
  ttl: number;
  priority: number;
  rdata: string;
}

const api = vi.hoisted(() => ({
  zone: [] as Rec[],
  calls: [] as { method: string; params: unknown[] }[],
  failures: [] as string[], // errors to return for the next calls, in order
  nextId: 100,
}));

vi.mock("xmlrpc", () => ({
  createSecureClient: () => ({
    methodCall(method: string, params: unknown[], cb: (err: unknown, value?: unknown) => void) {
      api.calls.push({ method, params });
      const failure = api.failures.shift();
      if (failure) return cb(new Error(failure));
      const [, , ...args] = params as [string, string, ...unknown[]];
      switch (method) {
        case "getZoneRecords":
          return cb(null, api.zone.map((r) => ({ ...r })));
        case "addZoneRecord": {
          const r = args[2] as Omit<Rec, "record_id">;
          // Like the real API: hostname rdata comes back with a trailing dot.
          const rdata = /^(MX|CNAME|NS)$/.test(r.type) ? `${r.rdata}.` : r.rdata;
          api.zone.push({ ...r, rdata, record_id: api.nextId++ });
          return cb(null, "OK");
        }
        case "updateZoneRecord":
        case "removeZoneRecord":
          return cb(null, "OK");
        default:
          return cb(null, "UNKNOWN_METHOD");
      }
    },
  }),
}));

import { LoopiaZoneRecord, loopiaProvider } from "../src/loopia";

const USER = "test-user@loopiaapi";
const PASSWORD = "not-a-real-password";
const creds = { loopiaUser: USER, loopiaPassword: PASSWORD };
const base = {
  domain: "example.com",
  subdomain: "@",
  type: "A",
  ttl: 3600,
  priority: 0,
  rdata: "192.0.2.1",
  ...creds,
};

// The provider sleeps 3 s before every call; run those timers while awaiting.
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

beforeEach(() => {
  api.zone = [];
  api.calls = [];
  api.failures = [];
  api.nextId = 100;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("create", () => {
  it("adds the record and returns the Loopia record_id", async () => {
    const res = await run(loopiaProvider.create!(base));
    expect(res.id).toBe("example.com/@/100");
    expect(res.outs).toMatchObject({ recordId: 100, rdata: "192.0.2.1", priority: 0 });
    expect(api.calls.map((c) => c.method)).toEqual([
      "getZoneRecords",
      "addZoneRecord",
      "getZoneRecords",
    ]);
  });

  it("sends credentials first and the record in the call", async () => {
    await run(loopiaProvider.create!(base));
    const add = api.calls.find((c) => c.method === "addZoneRecord")!;
    expect(add.params.slice(0, 5)).toEqual([USER, PASSWORD, "example.com", "@", expect.any(Object)]);
    expect(add.params[4]).toEqual({ type: "A", ttl: 3600, priority: 0, rdata: "192.0.2.1" });
  });

  it("defaults priority to 0 when it is not given", async () => {
    const { priority: _p, ...noPriority } = base;
    const res = await run(loopiaProvider.create!(noPriority));
    expect(res.outs).toMatchObject({ priority: 0 });
  });

  it("adopts an existing matching record without adding a new one", async () => {
    api.zone.push({ record_id: 7, type: "A", ttl: 3600, priority: 0, rdata: "192.0.2.1" });
    const res = await run(loopiaProvider.create!(base));
    expect(res.id).toBe("example.com/@/7");
    expect(api.calls.map((c) => c.method)).toEqual(["getZoneRecords"]);
  });

  it("adopts hostname records ignoring trailing dot and case", async () => {
    api.zone.push({ record_id: 8, type: "MX", ttl: 3600, priority: 10, rdata: "Mail.Example.COM." });
    const res = await run(
      loopiaProvider.create!({ ...base, type: "MX", priority: 10, rdata: "mail.example.com" })
    );
    expect(res.id).toBe("example.com/@/8");
  });

  it("treats TXT content as case-sensitive", async () => {
    api.zone.push({ record_id: 9, type: "TXT", ttl: 3600, priority: 0, rdata: "AbCd" });
    const res = await run(loopiaProvider.create!({ ...base, type: "TXT", rdata: "abcd" }));
    expect(res.id).not.toBe("example.com/@/9");
    expect(api.calls.some((c) => c.method === "addZoneRecord")).toBe(true);
  });

  it("finds a just-added hostname record despite the trailing dot", async () => {
    const res = await run(
      loopiaProvider.create!({ ...base, type: "CNAME", subdomain: "www", rdata: "example.com" })
    );
    expect(res.id).toBe("example.com/www/100");
  });

  it("fails when the added record cannot be found afterwards", async () => {
    const realPush = api.zone.push.bind(api.zone);
    api.zone.push = () => realPush() as number; // add succeeds but stores nothing
    await expect(run(loopiaProvider.create!(base))).rejects.toThrow(/could not be found/);
  });
});

describe("read", () => {
  const props = { ...base, recordId: 5 };

  it("refreshes ttl, priority and rdata from Loopia", async () => {
    api.zone.push({ record_id: 5, type: "A", ttl: 300, priority: 0, rdata: "192.0.2.9" });
    const res = await run(loopiaProvider.read!("example.com/@/5", props));
    expect(res.id).toBe("example.com/@/5");
    expect(res.props).toMatchObject({ ttl: 300, rdata: "192.0.2.9", recordId: 5 });
  });

  it("signals deletion when the record no longer exists", async () => {
    const res = await run(loopiaProvider.read!("example.com/@/5", props));
    expect(res).toEqual({ id: "", props: {} });
  });
});

describe("diff", () => {
  const old = { ...base, recordId: 5 };

  it("reports no change for identical inputs", async () => {
    expect(await loopiaProvider.diff!("id", old, base)).toEqual({ changes: false, replaces: [] });
  });

  it("ignores trailing dot and case for hostname types", async () => {
    const o = { ...old, type: "MX", rdata: "Mail.Example.com." };
    const n = { ...base, type: "MX", rdata: "mail.example.com" };
    expect((await loopiaProvider.diff!("id", o, n)).changes).toBe(false);
  });

  it("does not ignore case for TXT", async () => {
    const o = { ...old, type: "TXT", rdata: "AbC" };
    const n = { ...base, type: "TXT", rdata: "abc" };
    expect((await loopiaProvider.diff!("id", o, n)).changes).toBe(true);
  });

  it("treats a missing stored priority as 0", async () => {
    const { priority: _p, ...legacy } = old;
    expect((await loopiaProvider.diff!("id", legacy as typeof old, base)).changes).toBe(false);
  });

  it("detects ttl and rdata changes without replacing", async () => {
    expect(await loopiaProvider.diff!("id", old, { ...base, ttl: 60 })).toEqual({
      changes: true,
      replaces: [],
    });
    expect((await loopiaProvider.diff!("id", old, { ...base, rdata: "192.0.2.2" })).changes).toBe(true);
  });

  it("reports a subdomain-only or domain-only change as a replacement and a change", async () => {
    expect(await loopiaProvider.diff!("id", old, { ...base, subdomain: "www" })).toEqual({
      changes: true,
      replaces: ["subdomain"],
    });
    expect(await loopiaProvider.diff!("id", old, { ...base, domain: "example.org" })).toEqual({
      changes: true,
      replaces: ["domain"],
    });
  });

  it("replaces on type, subdomain or domain change", async () => {
    const r = await loopiaProvider.diff!("id", old, {
      ...base,
      type: "AAAA",
      subdomain: "www",
      domain: "example.org",
    });
    expect(r.replaces).toEqual(["type", "subdomain", "domain"]);
  });
});

describe("update and delete", () => {
  it("update sends the stored record_id and new values", async () => {
    const res = await run(loopiaProvider.update!("id", { ...base, recordId: 5 }, { ...base, ttl: 60 }));
    const call = api.calls.find((c) => c.method === "updateZoneRecord")!;
    expect(call.params[4]).toEqual({ record_id: 5, type: "A", ttl: 60, priority: 0, rdata: "192.0.2.1" });
    expect(res.outs).toMatchObject({ recordId: 5, ttl: 60 });
  });

  it("delete removes by record_id", async () => {
    await run(loopiaProvider.delete!("id", { ...base, recordId: 5 }));
    const call = api.calls.find((c) => c.method === "removeZoneRecord")!;
    expect(call.params.slice(2)).toEqual(["example.com", "@", 5]);
  });
});

describe("errors and retries", () => {
  it("retries on rate limiting and then succeeds", async () => {
    api.failures.push("Rate Limit Exceeded");
    const res = await run(loopiaProvider.create!(base));
    expect(res.id).toBe("example.com/@/100");
    expect(api.calls.filter((c) => c.method === "getZoneRecords").length).toBeGreaterThanOrEqual(3);
  });

  it("gives up after repeated rate limiting", async () => {
    api.failures.push(...Array(20).fill("Rate Limit Exceeded"));
    await expect(run(loopiaProvider.create!(base))).rejects.toThrow(/Rate Limit Exceeded/);
  });

  it("does not retry other errors", async () => {
    api.failures.push("Some other failure");
    await expect(run(loopiaProvider.create!(base))).rejects.toThrow(/Some other failure/);
    expect(api.calls).toHaveLength(1);
  });

  it("never leaks credentials in error messages", async () => {
    api.failures.push("AUTH_ERROR");
    const failure = await run(loopiaProvider.delete!("id", { ...base, recordId: 5 })).catch((e) => e);
    expect(String(failure?.message)).toContain("AUTH_ERROR");
    expect(String(failure?.message)).not.toContain(PASSWORD);
    expect(String(failure?.message)).not.toContain(USER);
  });
});
