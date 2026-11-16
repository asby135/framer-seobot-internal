# CRMChat for Creator Agencies (OnlyFans / OFM / Model Management) — Verified Facts

> Source: https://crmchat.ai/content-creators (replaces the old crmchat.fan landing, which is being merged into crmchat.ai). Every capability below was checked against the CRMChat product code in November 2026. If an older source (including crmchat.fan) says something that is not here or is listed under "Do not claim", this document wins.

## Positioning

CRMChat is a Telegram CRM for agencies that run several creators (models), a team of chatters and paid content sales in Telegram DMs. One workspace connects every creator's Telegram account, gives chatters one shared inbox, onboards creators to their monetization accounts, stores their media in a vault and takes payments by card, Apple Pay, Google Pay or Telegram Stars.

- Page headline: "Earn more from every fan with a CRM your whole agency can run".
- Page description: "Connect every creator's Telegram account, give chatters one inbox, store content in a vault and get paid by card, Apple Pay, Google Pay or Telegram Stars."
- Terminology: in English say "creator" (or model). In Russian always say «модель» («модели», «моделей»), never «креатор» — that is the word the Russian-speaking OFM market uses. Keep the role name "Chatter" and plan names (Starter, Personal, Team, Agency) in English.

## Multi-account inbox

- Every connected Telegram account (one per creator, or more) feeds one inbox, newest first. DMs and group chats.
- Tabs: All, Unread, Needs reply (the other side wrote last). Filters: pick one or several accounts, hide group chats, hide muted chats.
- Search matches chat names and @usernames, not message text.
- If one fan talks to several of your accounts, they appear as one row with unread counts added up.
- The inbox depends on the plan (not every plan includes it).

## Replies go out from the right account by default

When a chatter opens a fan's chat, CRMChat picks the creator account that already has a chat with that fan. If none does, it falls back to the account last used in that browser, then the first account. The selected account is shown in the chat header and the chatter can switch it before sending. Describe this as "the right account by default", never as "you can never message from the wrong account".

## Chatter role and account access

- Workspace roles: Admin, Member, Chatter.
- Chatters can read and reply in the accounts they can access, including photos, videos, voice notes and other media.
- Chatters cannot delete messages, chat history, chats or channels, and cannot see the subscription/billing or data export.
- Each Telegram account is either Workspace (everyone can use it) or Private (only selected members). Admins decide which accounts each chatter sees.
- Seats are paid per member (see Pricing). Do not promise "unlimited chatters".

## Fan owner and Telegram notifications

- Every contact (fan) has one owner.
- When the fan sends a message, the owner gets a DM from the CRMChat bot naming the fan and the account ("You received a response from …", with Open Chat). Messages arriving within about 20 seconds are grouped into one notification. Users can switch these notifications off.
- Campaigns can assign owners in rotation (round-robin) as new contacts come in. There are also notifications about leads left without a reply.

## Cross-promotion campaigns (outreach sequences)

- Send a multi-step sequence from all accounts or chosen accounts, preferring accounts that already have a dialog with the contact or only accounts that do not.
- Lists come from a CSV file, CRM filters or CRM groups; filter-based lists can be dynamic (new matching contacts join automatically).
- Messages can be text, photos, videos, documents, voice notes or stickers, with delays between steps, a sending schedule and daily limits.
- Campaigns can set the owner and update contact fields by default or on reply.
- Campaign analytics: Sent, Read, Replied, Blocked over time, plus CSV export.
- Agency use: message one creator's fans from another creator's account to cross-promote (send from a chosen account to a CRM list or CSV).

## Fan CRM

- Custom fields: text, single and multi select, user select, long text, URL, email, amount, phone.
- Notes, and tasks with due dates; the CRMChat bot sends reminders (e.g. for a custom request or a follow-up).
- Pipeline stages and a CRM card next to the chat ("Lead in CRM").

## When an account gets banned

Fan data lives in the CRM workspace, not in a Telegram account or on one platform. If a model's Telegram account is banned, the contact, notes, tasks, custom fields, pipeline stage and owner of every fan stay in CRMChat. The agency connects a new Telegram account (its own or one provided by crmchat) and continues from there, reaching fans again, for example by @username. The Telegram message history of the banned account is not kept by the CRM, and re-contacting a fan depends on their username and privacy settings — don't claim otherwise.

## Finding fans and chatters, importing existing ones

- Group parser: a managed service. Order a member list of public Telegram groups ("Parse for 500 credits"); the list arrives by Telegram DM within 24 hours.
- Telegram folder sync: sync a Telegram folder and its chats become CRM contacts.
- CSV upload exists as a campaign list source, not as a general CRM import.

## Creator onboarding (agency and creator verification)

Feature flag `creator-payments` (code complete in November 2026; marketed as available).

- Set up once per organization; all its workspaces share it. Only organization admins can do it.
- Choose Agency or Creator. Create a new creator monetization account, or connect an existing one by pasting an API key generated for CRMChat.
- Identity verification (KYC) runs on the provider's hosted verification page; CRMChat polls the status. Approval needs an active account and approved KYC.
- After the agency is verified, it creates one-time setup links for creators. Each link sets up exactly one creator account, lasts 7 days and can be revoked. CRMChat sends no email — the agency shares the link itself.
- The creator opens the link, creates or connects their account, verifies their identity and explicitly allows the agency to manage the account through CRMChat. The creator needs no CRMChat login and gets no workspace membership.
- Each link is bound to the workspace that created it; revoking a link does not disconnect a creator who already finished setup.

## Vault (media library per creator)

- A shared media library for each creator, opened from "Vault" in the app sidebar.
- Upload photos up to 30 MB and videos up to 500 MB; keep the tab open until uploads finish (videos must restart after a reload).
- Folders (removing a folder keeps its media as Unfiled) and tags (up to 50 tags per item, 64 characters each); bulk move and bulk add/remove tags for up to 50 items at a time.
- Moderation and processing statuses: In review, Approved, Additional review, Rejected; Preparing video, Ready, Processing failed. Pending or flagged items show only a thumbnail.
- "Blur gallery previews" toggle. Removing an item hides it from the vault; stored files are not erased.

## Getting paid

CRMChat itself does not process card payments. Two rails:

### 1. Card checkout on the creator's monetization account

Facts from the provider's public documentation (https://www.dropfans.io/llms.txt, November 2026):

- Creators sell digital files (photos, videos, audio, PDFs) through a shareable link or "drop". The fan sees a blurred preview, taps Pay and unlocks the file instantly.
- Fans pay by card, Apple Pay or Google Pay. No buyer account is needed. Pay-per-view or recurring subscription.
- Fees (confirmed by the crmchat team after DropFans' latest update, November 2026): a flat 20% fee taken from the creator, nothing charged to the buyer. The creator keeps 80% of every sale; the fan pays exactly the listed price.
- No monthly, listing or setup fee. Minimum price $5.
- Earnings are held 14 days (the chargeback window), then released on a daily rolling basis. The creator requests a payout to bank, card or crypto via the payout partner, or to Paxum. Minimum balance for a daily payout batch: $20.
- Processed by a regulated card acquirer.

Naming rule: the provider is DropFans. On crmchat.ai and in published articles do NOT name DropFans — say "the creator's monetization account", "checkout" or "creator monetization platform". This was the user's explicit decision (DropFans is adult-adjacent, and brand use is not yet agreed).

### 2. Telegram Stars via @crmchatppvbot

- The CRMChat PPV Sales Bot (@crmchatppvbot) sells pay-per-view inside Telegram. Content appears in the fan's chat as a blurred preview with a price in Telegram Stars; after paying with Stars it unlocks automatically, without leaving Telegram.
- Type @crmchatppvbot in a customer chat to send PPV there; upload once and sell many times from a library; tag fans (e.g. VIP) and broadcast; sales and earnings stats; withdraw in TON crypto via @wallet. See product-ppv-bot.md.

## Pricing (November 2026)

- Starter: free. Personal and Team: 1-week free trial.
- Team: $49 per seat per month ($41 billed quarterly, $34 billed yearly).
- Telegram account connections: the first is free, then $10 per account per month ($8 quarterly, $7 yearly).
- Agency plan: more than 20 members or 50 outreach accounts — talk to sales.

## Social proof

Pix, Major Creator Agency: "A team of 50 chatters needs one fast dashboard. Switching between accounts in a high-frequency chatting workflow eats up a lot of time, and crmchat's inbox solves that perfectly. Some of the features we asked for were built within two days."

## Do not claim

These appeared on crmchat.fan or in older material, but the product does not support them:

- An AI agent that auto-replies to fans from a knowledge base, "answers only when confident", or has a configurable tone. The only AI offering is a paid done-for-you AI bot setup service. (crmchat.fan's own FAQ advised against AI for fan chats.)
- Chatter performance analytics, response-time tracking, sales per chatter or content-sales conversion analytics. Only campaign analytics exist (Sent/Read/Replied/Blocked).
- Fan purchase history or rebill tracking. The closest thing is a manual custom "amount" field.
- A Zapier integration or "7,000+ apps".
- An inbox filter by owner or assignee, or search inside message text.
- A general CSV import of fans into the CRM.
- "Unlimited chatters", "never message from the wrong account".
- Numbers without a source: "10x faster/response time", "3–5x fan lifetime value", "50% faster replies", "save 30% per transaction", "300+ creator accounts connected", "5K+ messages per day", "50+ teams", "100K+ CRM leads".
- Old pricing ("Team $40/month", "custom Outreach plan").
- "Headhunting chatters from competitor channels" — do not present poaching as a feature.

## Content rules for this niche

- Write about agency operations: inbox, chatters, account safety, onboarding, payments, cross-promotion. Keep it SFW. Flirty example chats are fine; explicit content is not.
- Frame features as answers to real agency pains (many accounts, speed, account safety, payment friction), not as the pain itself. See creator-agency-economics.md for the economic context.
