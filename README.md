# @technowobble/loopia-provider

A [Pulumi](https://www.pulumi.com/) dynamic provider that manages DNS zone records, and a domain's
nameservers, at [Loopia](https://www.loopia.com/) through its XML-RPC API (LoopiaAPI).

> **Unofficial.** This project is not affiliated with, endorsed by or supported by Loopia.

## Install

```sh
npm install @technowobble/loopia-provider
```

`@pulumi/pulumi` (v3) is a peer dependency and must be installed in your project.

## Credentials

Create an API user in the Loopia Customer Zone (Account Settings → LoopiaAPI), then store the
credentials as Pulumi **secrets**:

```sh
pulumi config set --secret loopiaUser     <api-user>@loopiaapi
pulumi config set --secret loopiaPassword <api-password>
```

Read them with `getSecret` and pass them to each resource. The resource also marks both values as
secret outputs, so they are encrypted in the stack state. The package never logs credentials.

## Resources

### `LoopiaZoneRecord`

| Input | Type | Notes |
| --- | --- | --- |
| `domain` | `string` | Root domain, e.g. `example.com` (ACE/punycode for IDN domains) |
| `subdomain` | `string` | Label within the zone: `@` for the apex, `www`, `_dmarc`, … |
| `type` | `string` | `A`, `AAAA`, `CNAME`, `MX`, `TXT`, … Changing it replaces the record |
| `ttl` | `number` | Seconds |
| `priority` | `number?` | For MX. Defaults to `0` |
| `rdata` | `string` | Record data, e.g. an IP address or TXT content |
| `loopiaUser` | `string` | API user (secret) |
| `loopiaPassword` | `string` | API password (secret) |

Output: `recordId`, Loopia's numeric record id, kept in state for updates and deletes.

Behaviour worth knowing:

- **Idempotent create.** If a record with the same type, data, TTL and priority already exists, it
  is adopted instead of duplicated, so existing zones can be brought under Pulumi safely.
- **Hostname comparison.** Loopia adds a trailing dot to hostname data and may change its case. For
  `MX`, `CNAME`, `NS`, `PTR` and `SRV` those differences are ignored. `TXT` is compared exactly.
- **Rate limiting.** LoopiaAPI allows 60 calls per minute. The provider waits 3 seconds before every
  call and retries rate-limit errors with back-off. Run with `pulumi up --parallel 1`.

## Example

```ts
import * as pulumi from "@pulumi/pulumi";
import { LoopiaZoneRecord } from "@technowobble/loopia-provider";

const cfg = new pulumi.Config();
const loopiaUser = cfg.requireSecret("loopiaUser");
const loopiaPassword = cfg.requireSecret("loopiaPassword");
const creds = { loopiaUser, loopiaPassword };

const domain = "example.com";

new LoopiaZoneRecord("apex-a", {
  domain, subdomain: "@", type: "A", ttl: 3600, rdata: "192.0.2.10", ...creds,
});

new LoopiaZoneRecord("www", {
  domain, subdomain: "www", type: "CNAME", ttl: 3600, rdata: "example.com", ...creds,
});

new LoopiaZoneRecord("mx", {
  domain, subdomain: "@", type: "MX", ttl: 3600, priority: 10, rdata: "mail.example.com", ...creds,
});
```

### `LoopiaDomainNameservers`

Sets the nameservers a domain is delegated to (Loopia's `updateDNSServers`).

| Input | Type | Notes |
| --- | --- | --- |
| `domain` | `string` | Registered domain. Changing it replaces the resource |
| `nameservers` | `string[]` | At least two hostnames, in any order |
| `loopiaUser` / `loopiaPassword` | `string` | API credentials (secret) |

```ts
import { LoopiaDomainNameservers } from "@technowobble/loopia-provider";

// e.g. a Cloud DNS managed zone (or any zone resource that exports its nameservers)
const zone = new gcp.dns.ManagedZone("zone", { dnsName: "example.com.", name: "example-com" });

new LoopiaDomainNameservers("example-com-ns", {
  domain: "example.com",
  nameservers: zone.nameServers,
  loopiaUser,
  loopiaPassword,
});
```

Things to know before using it:

- **Loopia cannot tell Pulumi what the nameservers are.** The API can set them but has no method
  that reads them, so this resource is "set and trust": the state holds what Pulumi last wrote.
- **Drift hint on refresh.** `pulumi refresh` compares the stored list with the NS records seen in
  public DNS (1.1.1.1 and 8.8.8.8). A difference is recorded as drift, and the next `pulumi up`
  writes your list again. Previews and updates never do the lookup. After a change it can take a
  while for public DNS to follow, and a failed lookup is ignored.
- **Delete does nothing.** Removing the resource from your program leaves the domain where it is,
  so a code change can never take a site offline by itself. To go back to Loopia's own DNS, set the
  nameservers you want in code.
- **A wrong list is an outage.** Preview before you apply, and consider `protect: true`.
- **DNSSEC.** The API has no DNSSEC methods. If the domain has a DS record at the registry, remove
  or update it *before* switching delegation, otherwise validating resolvers will fail to resolve
  the domain.

## Not managed

DNSSEC settings and DS records. The Loopia API has no methods for them, so handle them in the
Loopia Customer Zone.

## Development

```sh
npm install
npm test        # all tests mock the Loopia API; nothing touches the network
npm run build   # emits dist/ with type declarations
```

## License

MIT
