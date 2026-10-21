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
  /** A client secret is stored in this machine's vault (Google needs one). */
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
