# Robinhood MCP OAuth & Connection Guide

This document is the definitive guide for configuring, connecting, and maintaining Robinhood MCP OAuth connections in **Socratic.Trade**.

---

## 1. Architecture Overview

Robinhood integration uses the official **Robinhood Model Context Protocol (MCP) Trading Server** (`https://agent.robinhood.com/mcp/trading`).

- **OAuth Discovery**: `https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading` and `https://agent.robinhood.com/mcp/trading/.well-known/oauth-authorization-server`
- **Dynamic Client Registration**: RFC 7591 (`https://agent.robinhood.com/oauth/trading/register`)
- **Protocol**: OAuth 2.0 with PKCE (S256), scope `internal` (or `tools:call`), resource `https://agent.robinhood.com/mcp/trading`
- **Token Persistence**: Access & Refresh tokens are encrypted and stored in SQLite `settings` table (`/app/data/app.db`) under key `robinhood_mcp_oauth_token:<userId>`.

---

## 2. Why Connection Attempts Landed on `robinhood.com/oauth/error`

Robinhood's OAuth authorization server (`https://robinhood.com/oauth`) enforces strict redirect security:

1. **Unregistered Dynamic Clients**: When using dynamic registration without a pre-approved partner Client ID, Robinhood's server policy **requires loopback redirect URIs** (`http://localhost:...`, RFC 8252) and **rejects third-party public HTTPS redirect URIs** (`https://socratictrade.com/...`).
2. **Failure Symptom**: The authorization page loads and sends a 2FA push notification to the user's Robinhood iOS/Android app. At the exact moment the user approves the push notification, Robinhood's backend validates the redirect URI, rejects public HTTPS URLs, and redirects the browser to `https://robinhood.com/oauth/error` ("Uh oh! Something's gone wrong").

---

## 3. Standard Production Reconnect Procedure (SSH Tunnel Method)

Because Robinhood requires a loopback redirect URI (`http://localhost:4000/api/auth/robinhood/callback`) for dynamic clients, use this 3-step procedure to connect production:

### Step 1: Configure Production Secrets (Infisical)
In Infisical production secrets for Socratic.Trade (`fedc540e-4641-45a8-8aa2-0e5a5c3dd6c3`):
- `ROBINHOOD_MCP_REDIRECT_URI=http://localhost:4000/api/auth/robinhood/callback`
- `ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT=on`

### Step 2: Ensure Server Port Forwarder & Local SSH Tunnel
On your local Mac terminal:
```bash
ssh -L 4000:localhost:4000 root@135.181.192.190
```
*(On the server host `135.181.192.190`, port 4000 on `127.0.0.1` forwards traffic to the `socratic-trade-prod` container).*

### Step 3: Complete Connection
1. In your browser, navigate to **`https://socratictrade.com/admin/connections`** (or `/api/auth/robinhood/start`).
2. Click **Reconnect Robinhood**.
3. Approve the 2FA push notification on your Robinhood phone app.
4. Robinhood will redirect your browser to `http://localhost:4000/api/auth/robinhood/callback?code=...`.
5. The SSH tunnel forwards the code to `socratic-trade-prod` on port 4000.
6. The server exchanges the code for tokens and saves `robinhood_mcp_oauth_token:local` in SQLite `/app/data/app.db`.

---

## 4. Automatic Background Token Maintenance

Once tokens are stored in SQLite:
- **Server-to-Server Refresh**: The background strategy loop, portfolio engine, and health checks use `refreshMcpAccessToken`.
- **No Browser Needed**: Token refresh makes direct HTTP POST calls to `https://api.robinhood.com/oauth2/token/`. **No browser interaction or redirect URIs are required once connected.**
- **Persistence**: Robinhood remains connected indefinitely unless explicitly deleted.

---

## 5. Registering an Official Static Partner Client ID with Robinhood

To allow end-users to connect directly from `https://socratictrade.com` without needing SSH tunnels or loopback redirects:

1. **Submit Developer Application**: Contact Robinhood API Developer Support (`mcp-support@robinhood.com` or `developer.robinhood.com`).
2. **Provide Application Details**:
   - **Application Name**: `Socratic.Trade`
   - **Redirect URI**: `https://socratictrade.com/api/auth/robinhood/callback`
   - **Requested Scopes**: `internal`, `tools:call`
   - **Resource**: `https://agent.robinhood.com/mcp/trading`
3. **Configure Secrets**:
   Once Robinhood approves the application and issues a Client ID & Secret:
   - Set `ROBINHOOD_MCP_CLIENT_ID=<issued_client_id>`
   - Set `ROBINHOOD_MCP_CLIENT_SECRET=<issued_client_secret>`
   - Set `ROBINHOOD_MCP_REDIRECT_URI=https://socratictrade.com/api/auth/robinhood/callback`
   - Set `ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT=off`
4. **Result**: All users can connect with 1 click directly on `socratictrade.com` with zero SSH or loopback requirements.
