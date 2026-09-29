# Emdash to Workers for Platforms: fixed-template delivery

This example shows how an Emdash task can hand a **bounded manifest** to the compatibility control plane. The Worker derives an owner from an anonymous demo session or a stable Cloudflare Access principal and publishes a **platform-owned HTML User Worker** in a dedicated Workers for Platforms (WfP) namespace. The Next.js compatibility ladder does not feed an artifact into this publisher.

## Contract and flow

The manifest has exactly these fields (`examples/emdash-wfp/environment.example.json`):

```json
{
	"slug": "customer-preview",
	"title": "Customer launch room",
	"description": "Validated in an Emdash task, then published as an isolated Workers for Platforms environment."
}
```

`slug` is 2–32 lowercase letters, digits, or single hyphens; `title` is 2–80 characters; `description` is 2–240 characters. The server selects the namespace, script prefix, compatibility date, and bundled source (`USER_WORKER_SOURCE` in `src/wfp-environments.ts`). The caller cannot provide code, bindings, an account ID, or an owner header.

1. An Emdash task validates its output and writes the manifest. Emdash remains a local or SSH-based development cockpit; its Electron application is **not** hosted on WfP.
2. The CLI authenticates to the control plane with an expiring visitor cookie or an Access token.
3. A tenant registry fences the publish/update; the public-demo coordinator first reserves global and visitor capacity. The Worker uploads its fixed module and escaped plain-text metadata using its **server-only** `WFP_API_TOKEN`.
4. The control plane confirms the registry before returning an owner-scoped `/customer-environments/{customerKey}/{slug}/` URL. The dispatcher rechecks ownership and registry state, allows GET/HEAD only, strips incoming headers, and applies **sample-configured** 50 ms CPU and five-subrequest limits.
5. Explicit delete removes the User Worker. In public-demo mode an alarm also deletes it after 30 minutes; uncertain outcomes retain the slot until deletion can be confirmed.

The route is accessible only to the **same session or Access principal** that published it. Do not forward it as a public customer link.

The [first upload is synchronously dispatchable](https://developers.cloudflare.com/changelog/post/2025-02-20-synchronous-uploads/), but an update may continue to serve the previous metadata briefly after its upload API call succeeds. One staging check observed the previous version for roughly 78 seconds. Verify the routed response after an update; `durationMs` is the API upload time, not a measurement of update visibility.

## CLI usage

Set `COMPATIBILITY_CONTROL_PLANE_URL` to your deployed control plane's HTTPS origin. For a public demo, the CLI defaults to `COMPATIBILITY_AUTH=demo` and bootstraps its own visitor session:

```sh
npm run emdash:publish -- examples/emdash-wfp/environment.example.json
npm run emdash:list
npm run emdash:delete -- customer-preview
```

The publish response includes the script name, routed URL, upload duration, and (in public-demo mode) expiry time. Repeating a publish with the **same owner and slug** updates that environment. The CLI caches its demo cookie under `~/.config/nextjs-compatibility-demo/session.json` with owner-only permissions until the two-hour session expires; a new session is a new owner.

For an Access-protected self-hosted app, use `COMPATIBILITY_AUTH=access`. The CLI invokes `cloudflared access token --app` unless you supply a short-lived `COMPATIBILITY_ACCESS_TOKEN` in your shell. `COMPATIBILITY_ACCESS_TOKEN` is an **Access application token** used by the CLI, not the account-scoped `WFP_API_TOKEN` used by the Worker.

The CLI sets the mutation `Origin` header to the configured URL's origin. It requires HTTPS outside localhost and reports `Retry-After` on throttling. The browser UI uses the same API routes; `POST /api/wfp/environments` accepts only the manifest above, `GET /api/wfp/environments` lists the caller's registry, and `DELETE /api/wfp/environments/{slug}` removes one owned environment.

## Platform setup and limits

Use the [root deployment guide](../../README.md#deploy-your-own-control-plane) to check for name collisions, create a **dedicated** dispatch namespace, provision the bound resources, and deploy the control Worker. The default namespace is `nextjs-compatibility-environments`; it appears in `wrangler.jsonc` both as `vars.WFP_DISPATCH_NAMESPACE` and `dispatch_namespaces[0].namespace`, and is hard-allowlisted by `src/wfp-environments.ts`. If you choose another name, update the server-side constant and both fields in your ignored deployment config. Never reassign a namespace already used by a different project.

```sh
npx wrangler dispatch-namespace list
npx wrangler dispatch-namespace create nextjs-compatibility-environments
npx wrangler secret put WFP_API_TOKEN --config wrangler.local.jsonc
```

Create only if the namespace name is unoccupied; set the secret **after** deploying the Worker. The [WfP upload API](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/update/) accepts `Workers Scripts Write`; the account-scoped token must also be able to delete the User Workers it creates. Under [current Workers roles](https://developers.cloudflare.com/workers/authorization/workers/), new Worker creation and deletion require product-level `Admin`. Verify upload and delete with an isolated staging Worker before accepting public requests. Do not put the token in source, a `.dev.vars.example`, CLI environment variables, or browser responses.

| Mode               | Sample limits                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Public demo        | 1 environment/session, 10 globally; 3 publishes/session/minute, 5/IP/hour, 20 globally/hour, 50 globally/day; 30-minute expiry |
| Access self-hosted | 5 environments/principal; 10 mutations/principal/minute                                                                        |
| Dispatch           | 120 requests/principal/minute; public demo also caps all dispatches at 300/minute                                              |
| WfP API            | 1,000 calls/5 minutes budgeted by the sample; public demo reserves 50 of those for cleanup                                     |

These are **application policies**, separate from [Cloudflare WfP platform limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/). Deleted or uncertain environments continue to occupy registry capacity until confirmation. The sample's WfP budget intentionally leaves headroom below the documented account token limit.

## Boundaries

- This is a fixed-template metadata example, not a general code runner or a deployment target for a Vinext/OpenNext build. Arbitrary generated server code would need a separate artifact contract, isolation, and egress/binding policies.
- The tenant ID is derived from the authenticated session or stable Access user/service-token identifier. It does not fall back to an email address, query parameter, or unverified header.
- The namespace binding and API credential belong to the control plane. The User Worker receives only the bounded text values required to render its page.
- The dispatcher never forwards visitor cookies or Access headers to the User Worker. Environments in a non-active registry state cannot be dispatched.

References: [Workers for Platforms overview](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/), [WfP custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/), [WfP API](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/update/), and [Emdash Remote Tasks](https://www.emdash.sh/docs/remote-development/remote-tasks).
