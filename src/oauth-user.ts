import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface StoredTokens {
  refresh_token: string;
  base_url: string;
  saved_at: number;
}

export class UserOAuth {
  private static tokenDir = process.env.WEBSITE_INSTANCE_ID
    ? '/home/data/.ninjaone-mcp'
    : join(homedir(), '.ninjaone-mcp');
  private static tokenFile = join(UserOAuth.tokenDir, 'tokens.json');

  private cachedAccessToken: string | null = null;
  private cachedExpiry: number | null = null;
  private stored: StoredTokens | null = null;
  private clientId: string;
  private clientSecret: string;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  static get filePath(): string {
    return UserOAuth.tokenFile;
  }

  static async saveTokens(tokens: StoredTokens): Promise<void> {
    await fs.mkdir(UserOAuth.tokenDir, { recursive: true });
    await fs.writeFile(UserOAuth.tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  static async loadTokens(): Promise<StoredTokens | null> {
    try {
      const raw = await fs.readFile(UserOAuth.tokenFile, 'utf8');
      return JSON.parse(raw) as StoredTokens;
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.stored) this.stored = await UserOAuth.loadTokens();
    return !!this.stored?.refresh_token;
  }

  /**
   * Returns a valid user-context access token, refreshing via the stored refresh_token when needed.
   * Throws if no refresh token is stored — caller should fall back to client_credentials or instruct the user to run the auth CLI.
   */
  async getAccessToken(): Promise<string> {
    if (this.cachedAccessToken && this.cachedExpiry && Date.now() < (this.cachedExpiry - 300_000)) {
      return this.cachedAccessToken;
    }

    if (!this.stored) this.stored = await UserOAuth.loadTokens();
    if (!this.stored?.refresh_token) {
      throw new Error('No stored NinjaOne user-context token. Run `npm run auth` (or `node dist/auth.js`) once to consent in a browser.');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.stored.refresh_token,
      client_id: this.clientId,
      client_secret: this.clientSecret
    });

    const response = await fetch(`${this.stored.base_url}/ws/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Refresh token exchange failed: ${response.status} ${response.statusText} - ${text}. Re-run the auth CLI to re-consent.`);
    }

    const json: any = await response.json();
    this.cachedAccessToken = json.access_token;
    this.cachedExpiry = Date.now() + (json.expires_in * 1000);

    // NinjaOne rotates refresh tokens — persist the new one if provided.
    if (json.refresh_token && json.refresh_token !== this.stored.refresh_token) {
      this.stored = { ...this.stored, refresh_token: json.refresh_token, saved_at: Date.now() };
      await UserOAuth.saveTokens(this.stored);
    }

    return this.cachedAccessToken!;
  }
}
