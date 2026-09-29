interface Env {
	/** Server-only, account-scoped token for WfP dispatch-script uploads and deletes. */
	WFP_API_TOKEN: string;
	/** A random 32+ character Worker secret used to HMAC request IPs in public-demo mode. */
	DEMO_SESSION_KEY: string;
}
