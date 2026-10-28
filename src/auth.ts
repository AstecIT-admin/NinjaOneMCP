import { createServer } from 'http';
import { spawn } from 'child_process';
import { URL } from 'url';
import { randomBytes, createHash } from 'crypto';
import { config } from 'dotenv';
import { UserOAuth } from './oauth-user.js';

config();

const REDIRECT_PORT = 8765;
const REDIRECT_PATH = '/callback';
const REDIRECT_URI = `https://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPES = 'monitoring management control';

const REGION_MAP: Record<string, string> = {
  us: 'https://app.ninjarmm.com',
  us2: 'https://us2.ninjarmm.com',
  eu: 'https://eu.ninjarmm.com',
  ca: 'https://ca.ninjarmm.com',
  oc: 'https://oc.ninjarmm.com',
};

function resolveBaseUrl(): string {
  const envBase = process.env.NINJA_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, '');
  const region = (process.env.NINJA_REGION || '').toLowerCase();
  if (region && REGION_MAP[region]) return REGION_MAP[region];
  throw new Error('Set NINJA_BASE_URL or NINJA_REGION before running auth.');
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const clientId = process.env.NINJA_CLIENT_ID;
  const clientSecret = process.env.NINJA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('NINJA_CLIENT_ID and NINJA_CLIENT_SECRET must be set.');

  const baseUrl = resolveBaseUrl();
    const state = randomBytes(16).toString('hex');

  // PKCE: NinjaOne's authorization server requires S256 code_challenge for this app type.
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const authUrl = new URL(`${baseUrl}/ws/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  const code: string = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== REDIRECT_PATH) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const returnedState = url.searchParams.get('state');
      const returnedCode = url.searchParams.get('code');
      const err = url.searchParams.get('error');

      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authorization failed</h1><p>${err}</p>`);
        server.close();
        reject(new Error(`Authorization returned error: ${err}`));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>State mismatch</h1>');
        server.close();
        reject(new Error('OAuth state mismatch — possible CSRF attempt.'));
        return;
      }
      if (!returnedCode) {
        res.writeHead(400); res.end('Missing code');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>NinjaOne auth complete</h1><p>You can close this tab.</p>');
      server.close();
      resolve(returnedCode);
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Listening on ${REDIRECT_URI}`);
      console.log(`Opening browser to NinjaOne consent screen...`);
      openBrowser(authUrl.toString());
      console.log(`If the browser did not open, visit:\n  ${authUrl.toString()}`);
    });
    server.on('error', reject);
  });

  console.log('Exchanging code for tokens...');
    const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier
  });
  const tokenResp = await fetch(`${baseUrl}/ws/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString()
  });
  if (!tokenResp.ok) {
    throw new Error(`Token exchange failed: ${tokenResp.status} ${await tokenResp.text()}`);
  }
  const tokens: any = await tokenResp.json();
  if (!tokens.refresh_token) {
    throw new Error('No refresh_token in response — check that `offline_access` scope is enabled in your NinjaOne app.');
  }

  await UserOAuth.saveTokens({
    refresh_token: tokens.refresh_token,
    base_url: baseUrl,
    saved_at: Date.now()
  });

  console.log(`Refresh token saved to ${UserOAuth.filePath}`);
  console.log('Done. The MCP server will now use user-context tokens for ticket/script operations.');
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
