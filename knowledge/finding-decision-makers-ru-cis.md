# How to Find Telegram Contacts of Business Owners in Russia/CIS

> 📖 Full article with screenshots: https://crmchat.ai/help-center/finding-decision-makers-ru-cis

### Introduction

Telegram Prospects Research. A systematic walkthrough for building a targeted list of Telegram contacts for business owners and decision-makers in Russia and the CIS — by connecting a business-data provider (DataNewton) and CRMChat to an AI assistant, then converting the results into a ready-to-use CSV for personalized outreach.

## Overview

In Russia and the CIS there is no single professional hub like LinkedIn — data about decision-makers is spread across registries, Telegram, websites, and directories. This workflow stitches those sources together: it pulls companies filtered by industry and revenue from a business-registry provider, finds each company's founder and phone number through CRMChat's contact-lookup tools, and converts those phone numbers into Telegram usernames you can actually message.

The AI assistant (e.g. Claude or ChatGPT) acts as the orchestrator: you connect it to both DataNewton and CRMChat via their API keys, then instruct it to run the lookup sequence and assemble the list.

## The Workflow (six steps)

1. **Access a business data provider.** Use a registry service such as **DataNewton** to filter companies by industry code (OKVED) and revenue. Obtain an API key for AI integration from the provider.

2. **Connect your AI assistant to DataNewton.** Give the AI a prompt containing your DataNewton API key (from DataNewton's API documentation) so it can query companies on your behalf.

3. **Connect your AI assistant to CRMChat.** Use your CRMChat API key, found in **Settings → API Keys**, so the assistant can drive CRMChat's contact-lookup tools.

4. **Instruct the AI to find contacts.** The assistant runs a search sequence through CRMChat's contact-lookup bot to locate the founder/decision-maker for each company returned in step 1.

5. **Retrieve the founder's phone number.** Pull the founder's phone number from the Contact Search Bot's results.

6. **Convert phone numbers to Telegram usernames and normalize.** In the CRMChat dashboard use **Instruments → Phone → Telegram** to convert each phone number into a Telegram username, then normalize the output into a clean CSV (Username, First Name, etc.) ready for a personalized outreach campaign.

The end result is a comprehensive, ready-to-use CSV file for personalized messaging campaigns targeting verified business owners and decision-makers.

## AI prompt template

Paste this into your AI assistant (Claude or ChatGPT), filling in your two API keys and your account handle, to connect both services before running the lookup sequence:

```
## Objective
In this session we will collect phone numbers of businesses that match my target audience and compile them into a single CSV file, ready for a Telegram outreach campaign through CRMChat.

## Setup — connect these two services first

1. Datanewton (company data) — connect via API.
   - API key: {paste Datanewton API key}
   - Docs: https://datanewton.ru/docs/api

2. CRMChat (contact lookup + outreach) — connect to my account (@your_account) via API.
   - API key: {paste CRMChat API key}
   - Docs: https://developers.crmchat.ai/docs
   - Inside CRMChat, find the contact-lookup bot @crmchatcontactbot. We will use it to find the phone numbers of company founders for the businesses we identify in Datanewton.
```

## Related resources

- [OSINT Tools for Telegram Outreach](osint-bots-telegram-outreach.md) — finding Telegram accounts and phone numbers from fragmentary data.
- [Preparing a Telegram Prospect Database](preparing-telegram-prospect-database.md) — parsing Telegram groups and cleaning member lists.
- Phone → Telegram username conversion — see [phone-number-to-tg-username-converter.md](phone-number-to-tg-username-converter.md).

## Summary

By combining a business-data provider (companies filtered by industry and revenue) with CRMChat's contact-search and phone-to-Telegram tools — orchestrated by an AI assistant connected to both via API keys — you can go from an industry/revenue filter to a finished list of founders, their phone numbers, and their Telegram usernames: a ready-to-use CSV for personalized Telegram outreach across Russia and the CIS.
