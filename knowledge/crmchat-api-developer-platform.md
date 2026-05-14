# CRMChat API & Developer Platform

> 📖 API Documentation: https://developers.crmchat.ai/docs
> 📖 Developer Landing Page: https://crmchat.ai/developers

### Introduction

The CRMChat API gives developers programmatic access to contacts, organizations, workspaces, custom properties, outreach campaigns, Telegram accounts, and the Telegram Raw API. It follows REST conventions with JSON requests and responses.

The API is designed to connect Telegram workflows to any CRM or data source, power Telegram bots & TMAs (Telegram Mini Apps), and automate anything on Telegram.

## Getting Started

### Base URL

```
https://api.crmchat.ai/v1
```

### Authentication

The API uses Bearer token authentication with API keys prefixed with `sk_`.

- Generate API keys from CRM Settings at `https://app.crmchat.ai/mini-app/settings/api-keys`
- The key is only shown once at creation — store it securely
- Include the key in the Authorization header: `Authorization: Bearer sk_your_api_key`

**Rate Limit:** 100 requests per minute per user. Exceeding this returns `429 Too Many Requests`.

**Error Response (401):**
```json
{
  "defined": true,
  "code": "UNAUTHORIZED",
  "status": 401,
  "message": "Invalid or missing API key"
}
```

**Security Best Practices:**
- Never commit API keys to version control
- Store keys in environment variables
- Rotate keys periodically
- Revoke unused keys promptly

### Quick Start

The simplest call lists organizations:
```
curl -H "Authorization: Bearer sk_your_api_key" \
  https://api.crmchat.ai/v1/organizations
```

## Core API Features

### Pagination

All list endpoints use cursor-based pagination.

- Parameters: `limit` (1-100, default 20), `startingAfter`, `endingBefore`
- Responses include `data`, `hasMore`, and `cursors` (with `next` and `previous`) fields

### Resource Updates

Uses JSON Merge Patch (RFC 7396) via PATCH requests with `Content-Type: application/merge-patch+json`. Arrays must be sent as complete replacements (no partial array merging).

### Webhooks

Webhooks deliver real-time HTTP notifications when events occur in a CRM workspace. Configured via Settings → API Keys.

**Supported Events:**
- `contact.created` — triggered when a new contact is created
- `contact.updated` — triggered when a contact is modified (includes `previousData` snapshot)
- `contact.deleted` — triggered when a contact is removed (includes full pre-deletion snapshot)

**Headers on every delivery:**
- `X-Webhook-Signature` — HMAC-SHA256 hex digest of the request body
- `X-Webhook-Event` — event type identifier
- `X-Webhook-Id` — unique event identifier for idempotency tracking
- `User-Agent` — "CRMChat-Webhooks/1.0"

**Signature Verification:** Every webhook includes an HMAC-SHA256 signature. Verify by computing the digest of the request body using your signing secret and comparing it to the `X-Webhook-Signature` header value.

**Reliability:**
- Up to 10 retry attempts over ~24 hours with exponential backoff
- 30-second delivery timeout
- Auto-disables after 3 days without successful delivery
- Telegram alerts sent when webhooks are disabled
- Can be re-enabled manually in Settings

## API Endpoints

### Organizations
- `GET /organizations` — List all accessible organizations
- `GET /organizations/{organizationId}` — Retrieve a single organization
- `PATCH /organizations/{organizationId}` — Update organization name

### Workspaces
- `GET /workspaces` — List workspaces (requires `organizationId` param)
- `GET /workspaces/{workspaceId}` — Get workspace details
- `PATCH /workspaces/{workspaceId}` — Update workspace name
- `GET /workspaces/{workspaceId}/members` — List members with roles (admin, member, chatter) and Telegram usernames

### Contacts
- `GET /workspaces/{workspaceId}/contacts` — List contacts, filterable by `telegram.username` and `telegram.id`
- `POST /workspaces/{workspaceId}/contacts` — Create contact (required: `ownerId`, `fullName`; optional: email, phone, description, avatarUrl, telegram data, custom properties)
- `GET /workspaces/{workspaceId}/contacts/{contactId}` — Retrieve a single contact
- `PATCH /workspaces/{workspaceId}/contacts/{contactId}` — Update contact fields
- `DELETE /workspaces/{workspaceId}/contacts/{contactId}` — Delete contact and associated activities

Contacts support a `_meta` field for custom property enrichment.

### Custom Properties
- `GET /workspaces/{workspaceId}/properties/{objectType}` — List property definitions (objectType: "contacts")
- `POST /workspaces/{workspaceId}/properties/{objectType}` — Create custom property
- `GET /workspaces/{workspaceId}/properties/{objectType}/{propertyKey}` — Get a specific property
- `PATCH /workspaces/{workspaceId}/properties/{objectType}/{propertyKey}` — Update property metadata/options
- `DELETE /workspaces/{workspaceId}/properties/{objectType}/{propertyKey}` — Delete a custom property

Supported property types: text, textarea, single-select, multi-select, user-select, URL, email, phone, amount. Keys must start with `custom.`

### Telegram Accounts
- `GET /workspaces/{workspaceId}/telegram-accounts` — List connected Telegram accounts
- `GET /workspaces/{workspaceId}/telegram-accounts/{accountId}` — Get account details
- `PATCH /workspaces/{workspaceId}/telegram-accounts/{accountId}` — Update account settings

Account statuses: active, offline, unauthorized, banned, frozen.

### Outreach Campaigns
- `POST /workspaces/{workspaceId}/outreach/lists/upload` — Upload CSV/TSV to create a contact list (params: `usernameColumn`, `phoneColumn`)
- `POST /workspaces/{workspaceId}/outreach/lists` — Create CRM-based list with filters (params: `contactType`, `name`, `dynamic`, `filters`)
- `GET /workspaces/{workspaceId}/outreach/sequences` — List outreach campaigns
- `POST /workspaces/{workspaceId}/outreach/sequences` — Create a new campaign
- `PATCH /workspaces/{workspaceId}/outreach/sequences/{sequenceId}` — Update campaign
- `DELETE /workspaces/{workspaceId}/outreach/sequences/{sequenceId}` — Delete campaign (only draft, paused, or completed)

Campaign statuses: draft, active, paused, completed. Attempting to delete an `active` campaign returns `409 Conflict`.

### Telegram Raw API
Access to 700+ Telegram methods via the connected Telegram accounts. Uses TL (Telegram Layer) object conventions with InputPeer/InputChannel concepts and accessHash requirements.

**Blocked namespaces:** `auth.*`, `updates.*`, `mtcute.*`, `smsjobs.*`

Note: Telegram enforces its own rate limits on raw API methods.

## Telegram MCP & Agentic Access

CRMChat supports MCP (Model Context Protocol) for connecting AI agents. This allows AI clients like Claude, Cursor, ChatGPT, Windsurf, and n8n to automate actions on Telegram accounts connected to CRMChat.

## Machine-Readable Formats

The API documentation is available in machine-readable formats for AI tools and code generators:
- **OpenAPI 3.x spec:** `https://api.crmchat.ai/v1/spec.json`
- **LLM index:** `https://developers.crmchat.ai/llms.txt`
- **Full LLM docs:** `https://developers.crmchat.ai/llms-full.txt`
- **MDX format:** Available for any documentation page

## Key Platform Capabilities

### Outreach Automation
Upload a list of Telegram handles or build dynamic segments from any source. Trigger campaigns via API and send at scale.

### Data Sync Pipelines
Sync contacts bidirectionally with HubSpot, Pipedrive, Salesforce, or your own database. Filter by Telegram username or ID.

### Event-Driven Workflows
Webhooks fire on every contact event — created, updated, deleted. Wire them into n8n, Make, Zapier, or your own backend.

### Telegram Bots & Mini-Apps
Build mini-apps with a built-in contact layer. Loyalty programs, support portals, booking systems — all with Telegram identity.

### Native Telegram Identities
Contacts have `telegram.username` and `telegram.id` as first-class fields, not custom properties.

### Outreach from Any Trigger
A Stripe payment, a form submission, a pipeline stage change — anything can start a Telegram sequence.

### Webhooks That Go Anywhere
HMAC-SHA256 signed, 24-hour retry with exponential backoff, Telegram alerts on failure.

## Use Cases

- Trigger Telegram outreach when a deal changes stage in HubSpot
- Message new customers on Telegram after a successful Stripe payment
- Push Telegram Bot / TMA form submissions into your outreach funnel
- Sync contacts bidirectionally with any workflow in n8n, Make, or Zapier
- Start a Telegram sequence the moment a lead qualifies
- Connect any external CRM (HubSpot, Pipedrive, AmoCRM) to Telegram outreach via the API

## Trust & Social Proof

CRMChat is trusted by 500+ Telegram-first businesses worldwide, including Unlimit, EMCD, fractl, 4dev, INXY, The Open Platform, and Solana Superteam.
