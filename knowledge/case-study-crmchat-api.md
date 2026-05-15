# How CRMChat Found My 62 Best Prospects in 2,300 Telegram Contacts - CRMChat

> Source: https://crmchat.ai/case-studies/crmchat-api-telegram-outreach

How CRMChat Found My 62 Best Prospects in 2,300 Telegram Contacts - CRMChat

API

How CRMChat Found My 62 Best Prospects in 2,300 Telegram Contacts

Sending personalized DMs to Telegram channel owners using nothing but the CRMChat API, my own contact list, and an AI assistant that gathers context before writing.

Team

2026

Sergei Borisov

Co-founder & CPO @ CRMChat

Hey, it's Serge from CRMChat. We just shipped a new mini-feature for channel authors — Telegram Channel Sync . It lets anyone running a Telegram channel sync their subscribers into CRMChat and automate DMs to them: a welcome flow for new subscribers, a broadcast about a new course or offer, an exit survey when someone unsubscribes — with all replies landing in one shared inbox no matter which Telegram account fired them.

When you launch something like that, the obvious question is: who do I tell about it?

I had two options. Blast it to the world and hope a few channel authors notice — or find the specific people in my own network who actually run channels, who'd actually benefit, and write each one a message that felt like a real DM from a friend, not a campaign.

I picked option two. This is the story of how the CRMChat API together with AI agent made that possible without me spending two weeks scrolling Telegram by hand.

The Realization: I Already Knew the Right People

I've been on Telegram for years. I have 2,300+ people in my contact list — founders, marketers, product folks, friends, ex-colleagues, people I met at conferences in 2019 and never spoke to again, people I had three-message exchanges with last week.

Some of them run their own Telegram channels. Some of those channels are big and active. Some of those owners would genuinely care about a feature that helps them welcome new subscribers and survey churned ones.

But which ones? With 2,300 contacts, I can't manually check every profile, click through to every channel, count subscribers, read recent posts, and remember whether we have a warm relationship or a "we DM'd once in 2022" relationship. That's a week of clicking and I'd give up on day two.

The CRMChat API gave me a different option.

What the API Made Possible

In one afternoon, the API let me look at every Telegram conversation I'd ever had and answer questions like:

Who in my contact list runs a public Telegram channel?

Of those, whose channel actually has 500+ subscribers (and isn't a dormant one-post project)?

For each one, what does our DM history look like — have we exchanged messages this year, did they support my last product launch, or have we never really talked?

What does their channel actually post about? What are the recurring themes — courses, conferences, product launches, articles?

That filtering pass took the 2,300 down to 92 people who genuinely run active channels , and from there I hand-narrowed to 62 candidates I felt good about reaching out to.

The whole thing was the AI agent with API doing the heavy lifting: pulling conversation history from each contact, fetching public channel data, organizing it all in one place. Without that, I would have been clicking through Telegram for a week and would have missed half the right people.

Then Came the Personalization Pass

Here's the part I'm proudest of. For each of the 62 people, the AI did something that a generic outreach tool can't do: it actually read our prior conversation and actually looked at what their channel posts about , then drafted a message in the right tone.

That meant:

For people who'd supported my Product Hunt launch in April, the message opened with a thank-you for that specific support, in the warm peer tone we already use with each other.

For people I'd messaged once a year ago and never followed up with, the message acknowledged the prior exchange briefly without trying to revive a dead thread.

For people I'd never really talked to, the message used a more respectful, formal opener and was upfront about how I found them.

For people who'd ignored a previous ask (which happens, and that's fine), the message was honest about it: "Hey, I poked around with AI to find people in my chats who run channels — here's why I'm writing." Authenticity beats pretending.

And inside the body of every message, the second bullet referenced something specific the person actually publishes — a real recurring theme from their channel. So instead of "send broadcasts about your launches," it was "(e.g., the announcement of your new closed-channel season)" for one person, "(e.g., the next live lecture)" for another, "(e.g., a new GenAI article)" for a third.

That kind of detail is the difference between an outreach DM that gets ignored and an outreach DM that gets a reply. And it's only possible because the AI had real context — both the conversation history and the channel content — fed to it through the CRMChat API before drafting a single word.

A Sample Message

Here's what shipped to one recipient (I'll call out the structure):

Alex, hi! In April you supported my Product Hunt launch — thanks again 🙏

I've noticed you've got quite a lively channel @{channel name} on B2B sales. We just rolled out a small mini-tool for channel authors at crmchat.ai. It lets you sync all your channel subscribers into our CRM and set up automatic DMs, for example:

• Welcome a new subscriber and introduce yourself • Send a broadcast about anything (e.g., the announcement of a new course batch) • Find out unsubscribe reasons and collect data for your content

Set it up once and forget it — all replies land in a single inbox in our CRM, even if you DM from multiple accounts 🙂

Could be relevant?

Three things matter about this message:

The opener is anchored in something real that happened between us. The AI knew that because it read our prior conversation.

The personalized example in the second bullet ("new course batch") was inferred from the recipient's actual recent channel posts.

The hyperlink on "mini-tool for channel authors" goes to the right landing page — the AI placed it correctly inline, the way a normal Telegram DM looks, not like a marketing email.

Multiply this by 62 people, each with their own opener, their own example, their own register — that's the workflow.

Human in the Loop, By Choice — Not by Necessity

Every single one of these messages I read before it went out. I edited a few. I told the AI when I wanted a different tone, a shorter version, a different bullet. The AI captured every edit as a rule for the next message — so by message ten, I was barely editing at all.

But here's the important thing: the human approval step is a choice, not a constraint . The same workflow could run end-to-end automatically. The CRMChat API handles every part of it without supervision: pulling the conversation history, finding the channels, scoring relevance, drafting the message, sending the DM, creating the corresponding contact in the CRM, even logging the result with the right pipeline stage.

I kept myself in the loop because the launch of a personal-feeling feature deserves a personal touch, and because I trust my own taste on tone more than any automation. But for higher-volume use cases — onboarding flows, lead nurturing, event invitations, customer follow-ups, churn surveys — the same exact pattern can run unattended, with confidence.

The only difference is whether you tap "send" or whether the system taps it for you.

What This Means for Your Telegram Workflow

What we built here isn't unique to me launching a feature. It's a general pattern that works for any high-touch Telegram workflow you can imagine:

Customer onboarding — when someone signs up, an automatic personal-feeling DM that references their company name, what they bought, and a relevant tip from your help center.

Lead nurturing — pulling lead context from your CRM, drafting a follow-up that references the specific demo they attended or the specific page they read, and sending it from a real person's account.

Event outreach — finding the right contacts in your network for a specific event, drafting invitations that reference what each invitee actually cares about, sending and tracking RSVPs.

Churn surveys — when someone unsubscribes from your channel or cancels your product, an automatic personal note asking why, with the response captured back in your CRM.

Re-engagement — finding contacts you haven't talked to in 6+ months, reading the prior conversation for context, sending a thoughtful re-open that doesn't feel like a generic "checking in!" template.

The two ingredients are always the same: real context (from prior chats, channel content, your CRM, wherever the relevant signal lives) and a real send pipeline (so the message goes out from an actual Telegram account and the response comes back into a unified inbox, not a black hole).

The CRMChat API gives you both. We use it for ourselves, every day, exactly the way I just used it for this launch.

The Template for Replication

If you want to run something similar, the moving parts are:

A contact list with relationship context — outreach to people whose history you can reference, not strangers.

A way to gather signal at scale — conversation history, channel content, CRM data, whatever's relevant. The CRMChat API does this for Telegram in particular.

A way to draft personally and send personally — from real accounts, not branded broadcast tools, with one-message-per-person customization.

A unified inbox for the responses — so you can actually have the conversation that follows, instead of losing the reply to a notification flood.

Human approval where it matters, automation where it doesn't. Pick per workflow.

If you're trying something similar, ping me at @asby135 on Telegram.
