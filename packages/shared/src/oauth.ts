/** The services an OAuth account can belong to. */
export type OAuthService = 'google' | 'microsoft';

/** One connected account, as the accounts screen shows it. The client secret never leaves the machine. */
export interface OAuthAccountView {
  id: string;
  service: OAuthService;
  /** What the user calls the account, e.g. "งาน" or "ส่วนตัว". */
  name: string;
  /** OAuth client id (a Google "Desktop app" client, or an Azure app registration). */
  clientId: string;
  /** Microsoft only: `common`, or a tenant id to restrict sign-in to one organization. */
  tenant?: string;
  /** A token is stored and the client is complete. */
  connected: boolean;
  /** A client secret is stored in this machine's vault (Google needs one; Microsoft only for a "Web" app). */
  hasSecret: boolean;
  /** The account used when a tool or workflow does not name one. */
  default: boolean;
  createdAt: string;
}

/** What the accounts screen sends when adding or editing an account. */
export interface OAuthAccountInput {
  service: OAuthService;
  name: string;
  clientId: string;
  /** Omit to keep the stored secret; an empty string never clears it. Google requires one. */
  clientSecret?: string;
  tenant?: string;
}

/** A credential for one native connector (API key, bot token, PAT or OAuth2 token). */
export interface ConnectorConnectionView {
  id: string;
  /** `ConnectorSpec.key`, e.g. "notion". */
  connector: string;
  name: string;
  authKind: 'oauth2' | 'oauth1' | 'apiKey' | 'basic' | 'bearer' | 'none';
  /** Every required credential is stored. */
  connected: boolean;
  /** At least one secret is stored in this machine's vault. */
  hasSecret: boolean;
  /** The connection used when a tool or workflow does not name one. */
  default: boolean;
  /** OAuth2 only: endpoints and scopes this connection uses instead of the connector's own. */
  oauth?: ConnectorOAuthOverrides;
  createdAt: string;
}

/** Per-connection OAuth2 settings (like n8n's credential form); a missing value keeps the connector default. */
export interface ConnectorOAuthOverrides {
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

/** What the connector connection screen sends. Empty fields keep the stored value. */
export interface ConnectorConnectionInput {
  connector: string;
  name: string;
  /** Credential field key -> value; values never travel back to clients. */
  fields?: Record<string, string>;
  default?: boolean;
  /** OAuth2 only. An empty string or list goes back to the connector default. */
  oauth?: ConnectorOAuthOverrides;
}
