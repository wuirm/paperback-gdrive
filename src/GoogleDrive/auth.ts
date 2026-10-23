/**
 * Two ways to talk to Drive:
 *  - apiKey: the library folder is shared "Anyone with the link"; requests carry X-Goog-Api-Key.
 *  - oauth:  private folder; a long-lived refresh token (from your own OAuth client) is swapped
 *            for short-lived access tokens, which are cached and refreshed on demand.
 */
import { Settings } from "./state";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class AuthError extends Error {}

export class AuthManager {
  private accessToken: string | undefined;
  private expiresAt = 0;
  private inflight: Promise<string> | undefined;

  isConfigured(): boolean {
    if (Settings.authMode === "oauth") {
      return !!(Settings.clientId && Settings.clientSecret && Settings.refreshToken);
    }
    return !!Settings.apiKey;
  }

  /**
   * Forget the cached access token. Pass the Authorization header that was rejected so
   * parallel requests failing with the same stale token only trigger one refresh.
   */
  invalidate(rejectedAuthorization?: string): void {
    if (rejectedAuthorization && rejectedAuthorization !== `Bearer ${this.accessToken}`) return;
    this.accessToken = undefined;
    this.expiresAt = 0;
  }

  async headers(): Promise<Record<string, string>> {
    if (Settings.authMode === "oauth") {
      return { Authorization: `Bearer ${await this.getAccessToken()}` };
    }
    const key = Settings.apiKey;
    if (!key) throw new AuthError("No Google API key set. Open the Google Drive extension settings.");
    return { "X-Goog-Api-Key": key };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    // Many pages load in parallel; make sure only one refresh is in flight.
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = Settings;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new AuthError("OAuth is selected but the client ID, client secret or refresh token is missing.");
    }
    const body =
      `client_id=${encodeURIComponent(clientId)}` +
      `&client_secret=${encodeURIComponent(clientSecret)}` +
      `&refresh_token=${encodeURIComponent(refreshToken)}` +
      `&grant_type=refresh_token`;

    const [response, data] = await Application.scheduleRequest({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
    try {
      json = JSON.parse(Application.arrayBufferToUTF8String(data));
    } catch {
      /* fall through */
    }

    if (response.status !== 200 || !json.access_token) {
      const reason = json.error_description ?? json.error ?? `HTTP ${response.status}`;
      const hint =
        json.error === "invalid_grant"
          ? " The refresh token was revoked or expired. If your OAuth consent screen is in 'Testing', tokens expire after 7 days; publish the app and generate a new token."
          : "";
      throw new AuthError(`Google sign-in failed: ${reason}.${hint}`);
    }

    this.accessToken = json.access_token;
    this.expiresAt = Date.now() + Math.max(60, (json.expires_in ?? 3600) - 120) * 1000;
    return json.access_token;
  }
}
