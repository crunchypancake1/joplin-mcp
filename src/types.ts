export interface Env {
  JOPLIN_MCP: DurableObjectNamespace;
  // VPC Service binding — routes to the Joplin Data API over the Cloudflare Tunnel on the
  // GL.iNet router, no public hostname involved.
  JOPLIN_VPC: Fetcher;
  // Joplin Data API token — Secrets Store binding, read via JOPLIN_API_TOKEN.get()
  JOPLIN_API_TOKEN: SecretsStoreSecret;
}
