/**
 * Pulumi dynamic provider for Loopia DNS (XML-RPC API).
 *
 * Credentials — set once as Pulumi secrets:
 *   pulumi config set --secret loopiaUser    YOUR_API_USER@loopiaapi
 *   pulumi config set --secret loopiaPassword YOUR_API_PASSWORD
 *
 * API reference: https://support.loopia.com/wiki/loopiaapi/
 *
 * Loopia identifies each zone record by a numeric `record_id` assigned at
 * creation. We persist that id in Pulumi state so we can target updates and
 * deletes precisely.
 */

import * as pulumi from "@pulumi/pulumi";
import * as xmlrpc from "xmlrpc";

// ── XML-RPC client ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createClient(user: string, password: string) {
  const client = xmlrpc.createSecureClient({
    host: "api.loopia.se",
    port: 443,
    path: "/RPCSERV",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });

  async function call<T>(method: string, params: unknown[], attempt = 1): Promise<T> {
    // Fixed throttle: always wait before calling to stay within Loopia's rate limit.
    // With --parallel 1, this ensures a minimum 3s gap between consecutive calls.
    await sleep(3000);

    const result = await new Promise<T>((resolve, reject) => {
      client.methodCall(method, [user, password, ...params], (err, value) => {
        if (err) return reject(new Error(`Loopia RPC error (${method}): ${err}`));
        if (typeof value === "string" && value !== "OK") {
          return reject(new Error(`Loopia API error (${method}): ${value}`));
        }
        resolve(value as T);
      });
    }).catch(async (err: Error) => {
      const msg = err.message;
      const isRetryable =
        msg.includes("Rate Limit Exceeded") || msg.includes("Wrong username or password");
      if (isRetryable && attempt <= 8) {
        // Exponential back-off: 5s, 10s, 15s … up to 60s
        const delay = Math.min(5000 * attempt, 60000);
        await sleep(delay);
        return call<T>(method, params, attempt + 1);
      }
      throw err;
    });
    return result;
  }

  return call;
}

// ── Loopia record shape ───────────────────────────────────────────────────────

interface LoopiaRecord {
  record_id: number;
  type: string;
  ttl: number;
  priority: number;
  rdata: string;
}

// ── Provider inputs / outputs ─────────────────────────────────────────────────

export interface LoopiaZoneRecordInputs {
  /** Root domain, e.g. "example.com" */
  domain: pulumi.Input<string>;
  /** Subdomain label. Use "@" for the apex, "www" for www, "_dmarc" etc. */
  subdomain: pulumi.Input<string>;
  /** DNS record type: A, AAAA, CNAME, MX, TXT, … */
  type: pulumi.Input<string>;
  ttl: pulumi.Input<number>;
  /** For MX. Defaults to 0. */
  priority?: pulumi.Input<number>;
  /** Record data, e.g. an IP address or quoted TXT string (without quotes). */
  rdata: pulumi.Input<string>;
}

interface ResolvedInputs {
  domain: string;
  subdomain: string;
  type: string;
  ttl: number;
  priority: number;
  rdata: string;
  loopiaUser: string;
  loopiaPassword: string;
}

// The id stored in state is "<domain>/<subdomain>/<record_id>".
// This lets us reconstruct all the info needed for delete/update without
// having to re-query Loopia.

// ── Dynamic provider implementation ──────────────────────────────────────────

// Loopia appends a trailing dot to hostname rdata and may change its case, so
// hostname-valued records are compared without either. TXT (and other free-form)
// content is case-sensitive — e.g. DKIM base64 keys — so only whitespace is trimmed.
//
// Keep everything this needs inside the function body: Pulumi serialises the
// provider's closures, and captured module-level objects like a Set don't survive.
const normRdata = (type: string, s: string) =>
  /^(MX|CNAME|NS|PTR|SRV)$/i.test(type) ? s.trim().replace(/\.$/, "").toLowerCase() : s.trim();

export const loopiaProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: ResolvedInputs) {
    const call = createClient(inputs.loopiaUser, inputs.loopiaPassword);

    // Check if a matching record already exists (idempotent — handles orphans
    // left by previously failed Pulumi runs where addZoneRecord succeeded but
    // the post-creation lookup errored before state was saved).
    const norm = (s: string) => normRdata(inputs.type, s);
    const existing = await call<LoopiaRecord[]>("getZoneRecords", [
      inputs.domain,
      inputs.subdomain,
    ]);
    const orphan = existing.find(
      (r) =>
        r.type === inputs.type &&
        norm(r.rdata) === norm(inputs.rdata) &&
        r.ttl === inputs.ttl &&
        r.priority === (inputs.priority ?? 0)
    );
    if (orphan) {
      const id = `${inputs.domain}/${inputs.subdomain}/${orphan.record_id}`;
      return {
        id,
        outs: { ...inputs, priority: inputs.priority ?? 0, recordId: orphan.record_id },
      };
    }

    const record = {
      type: inputs.type,
      ttl: inputs.ttl,
      priority: inputs.priority ?? 0,
      rdata: inputs.rdata,
    };

    await call<string>("addZoneRecord", [inputs.domain, inputs.subdomain, record]);

    // Fetch the newly created record to get the Loopia-assigned record_id.
    const records = await call<LoopiaRecord[]>("getZoneRecords", [inputs.domain, inputs.subdomain]);

    // Loopia appends a trailing dot to hostname rdata (e.g. "ns1.loopia.se.");
    // see normRdata() for how comparison is normalised per record type.
    const created = records.find(
      (r) =>
        r.type === inputs.type &&
        norm(r.rdata) === norm(inputs.rdata) &&
        r.ttl === inputs.ttl &&
        r.priority === (inputs.priority ?? 0)
    );

    if (!created) {
      throw new Error(
        `Loopia: record was added but could not be found in getZoneRecords (${inputs.type} ${inputs.rdata})`
      );
    }

    const id = `${inputs.domain}/${inputs.subdomain}/${created.record_id}`;
    return { id, outs: { ...inputs, priority: inputs.priority ?? 0, recordId: created.record_id } };
  },

  async read(id: string, props: ResolvedInputs & { recordId: number }) {
    const call = createClient(props.loopiaUser, props.loopiaPassword);
    const records = await call<LoopiaRecord[]>("getZoneRecords", [props.domain, props.subdomain]);

    const existing = records.find((r) => r.record_id === props.recordId);

    if (!existing) {
      // Record no longer exists — signal Pulumi to recreate it.
      return { id: "", props: {} };
    }

    return {
      id,
      props: {
        ...props,
        ttl: existing.ttl,
        priority: existing.priority,
        rdata: existing.rdata,
      },
    };
  },

  async diff(_id: string, olds: ResolvedInputs & { recordId: number }, news: ResolvedInputs) {
    // State written before create()/update() persisted the resolved priority, and
    // not yet refreshed by read(), can lack a stored priority. Treat a missing one
    // as 0, like the inputs do: comparing `undefined !== 0` made such records show
    // as an update on every preview and run a no-op updateZoneRecord on every
    // deploy.
    const changes =
      normRdata(news.type, olds.rdata) !== normRdata(news.type, news.rdata) ||
      olds.ttl !== news.ttl ||
      (olds.priority ?? 0) !== (news.priority ?? 0) ||
      olds.type !== news.type;

    // Type or subdomain change requires delete + recreate.
    const replaces: string[] = [];
    if (olds.type !== news.type) replaces.push("type");
    if (olds.subdomain !== news.subdomain) replaces.push("subdomain");
    if (olds.domain !== news.domain) replaces.push("domain");

    return { changes, replaces };
  },

  async update(id: string, olds: ResolvedInputs & { recordId: number }, news: ResolvedInputs) {
    const call = createClient(news.loopiaUser, news.loopiaPassword);

    const record = {
      record_id: olds.recordId,
      type: news.type,
      ttl: news.ttl,
      priority: news.priority ?? 0,
      rdata: news.rdata,
    };

    await call<string>("updateZoneRecord", [news.domain, news.subdomain, record]);

    return { outs: { ...news, priority: news.priority ?? 0, recordId: olds.recordId } };
  },

  async delete(id: string, props: ResolvedInputs & { recordId: number }) {
    const call = createClient(props.loopiaUser, props.loopiaPassword);
    await call<string>("removeZoneRecord", [props.domain, props.subdomain, props.recordId]);
  },
};

// ── Resource class ────────────────────────────────────────────────────────────

export class LoopiaZoneRecord extends pulumi.dynamic.Resource {
  /** Loopia's numeric record_id, persisted in state for updates/deletes. */
  public readonly recordId!: pulumi.Output<number>;

  constructor(
    name: string,
    args: LoopiaZoneRecordInputs & {
      loopiaUser: pulumi.Input<string>;
      loopiaPassword: pulumi.Input<string>;
    },
    opts?: pulumi.CustomResourceOptions
  ) {
    // The dynamic provider's create/read/update all return loopiaUser/
    // loopiaPassword as-is in `outs` (needed so read/delete — which only get
    // the persisted state, not fresh args — still have credentials to call
    // Loopia's API). Pulumi's dynamic-provider RPC shim doesn't propagate
    // input secretness to matching output properties on its own, so without
    // this they'd be persisted in plaintext in the state/checkpoint.
    super(
      loopiaProvider,
      name,
      { recordId: undefined, ...args },
      {
        ...opts,
        additionalSecretOutputs: [
          "loopiaUser",
          "loopiaPassword",
          ...(opts?.additionalSecretOutputs ?? []),
        ],
      }
    );
  }
}
