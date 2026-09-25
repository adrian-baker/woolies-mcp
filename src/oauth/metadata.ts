/**
 * The two discovery documents an MCP client fetches before it will authorise.
 *
 * RFC 9728 (protected resource) names the authorisation server; RFC 8414 (authorisation server)
 * names the endpoints. Field names here are fixed by those RFCs and by what clients look for:
 * a renamed key is an undiscoverable server, not a style choice.
 */

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly string[];
}

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint: string;
  readonly revocation_endpoint: string;
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly scopes_supported: readonly string[];
}

/** The one scope. Every tool needs the same signed-in session, so a finer split would be fiction. */
export const SHOP_SCOPE = "shop";

/**
 * The canonical resource identifier, and the audience every token is bound to (RFC 8707).
 * A token issued for a different resource is refused, so one stolen from another deployment of
 * this server cannot be replayed here.
 */
export function resourceIdentifier(publicUrl: URL): string {
  return new URL("/mcp", publicUrl).href;
}

export function protectedResourceMetadata(publicUrl: URL): ProtectedResourceMetadata {
  return {
    resource: resourceIdentifier(publicUrl),
    authorization_servers: [publicUrl.origin],
    scopes_supported: [SHOP_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(publicUrl: URL): AuthorizationServerMetadata {
  const at = (path: string): string => new URL(path, publicUrl).href;
  return {
    issuer: publicUrl.origin,
    authorization_endpoint: at("/authorize"),
    token_endpoint: at("/token"),
    registration_endpoint: at("/register"),
    revocation_endpoint: at("/revoke"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only: "plain" leaves the interception it exists to prevent unprevented.
    code_challenge_methods_supported: ["S256"],
    // Public client: the token endpoint is protected by PKCE, not by a secret a desktop client
    // would have to hold.
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SHOP_SCOPE],
  };
}
