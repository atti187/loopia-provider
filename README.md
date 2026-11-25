# @technowobble/loopia-provider

A [Pulumi](https://www.pulumi.com/) dynamic provider that manages DNS zone records at
[Loopia](https://www.loopia.com/) through its XML-RPC API (LoopiaAPI).

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

## Not managed

Only zone records are managed. A domain's nameservers and DNSSEC settings are not, because the
Loopia API cannot read them back. Change those in the Loopia Customer Zone.

## Development

```sh
npm install
npm test        # all tests mock the Loopia API; nothing touches the network
npm run build   # emits dist/ with type declarations
```

## License

MIT
