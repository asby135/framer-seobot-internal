# Discovering Prospects and Preparing the Database

> 📖 Full article with screenshots: https://crmchat.ai/help-center/preparing-telegram-prospect-database

### Introduction

Learn how to build high-quality prospect lists for Telegram outreach campaigns.

## How to Find and Prepare a Prospect List for Telegram Outreach

The first step in any successful Telegram outreach campaign is building a high-quality list of prospects. This guide will walk you through finding relevant Telegram groups, extracting member data using the **Telegram Group Parser**, and cleaning that data for personalized messaging.

### Finding Relevant Telegram Groups

Your campaign's success depends on reaching the right audience. You can find potential prospects by identifying Telegram groups where they are most active. There are two primary methods for this.

#### Method 1: Searching by Browsing Telegram

If you already know of relevant communities, conferences, or topics, you can search for them directly within Telegram.

Use the **search bar** in Telegram to find groups by name or keyword (e.g., a specific conference name like Epic Web3).

Once you find a group, click on its name to view the **Group Info**. Verify that the member list is public and visible.

Copy the group's public link. You will need this for the next step.

#### Method 2: Using the Telegram Group Finder

If you don't have specific groups in mind, we can help you find them. Use our free **Telegram Group Finder** tool on the CRMchat website to get a list of relevant groups based on your industry keywords.

Simply fill out the form with **Your Keywords** (e.g., Crypto, Marketing, Investments) and **Your Telegram Username**, then click **Submit**. We will research and send you a list of potential groups to parse.

### Parsing Groups to Extract Members

After you have a link to a target group, you can extract its member list using the built-in **Telegram Group Parser**.

In the CRMchat dashboard, navigate to the **Outreach** tab on the left-hand menu.

Select **Group Parser** from the sub-menu.

Paste the Telegram group link you copied into the input field and submit the request.

The parsing process can take up to 48 hours. Once complete, we will send you a spreadsheet containing the member data, including usernames, user IDs, and full names.

What Telegram groups or chats can be parsed:** **
Groups and chats with public members list

Groups where commenting is enabled - this way, we can parse everyone who left a comment in this group 

### Telegram Outreach by Phone Numbers

CRMChat supports phone number outreach. If you have your prospects' phone numbers from external sources such as Apollo and Clay, for example, you can submit these CSV lists directly to CRMChat and run your outreach campaign.

Read our case study to find out how we ran our own campaign targeting Web3 decision-makers using Clay data.

### Cleaning and Preparing Your Prospect List

The raw data from the parser needs to be cleaned to enable personalization. The primary goal is to extract a valid first name from the full name provided by each user. Not all users have a real first name, so this step is crucial for avoiding awkward or spammy messages.

#### Option 1: Manual Cleaning (for Small Lists)

For lists with fewer than a few hundred contacts, you can clean the data manually using your spreadsheet software's built-in tools, such as Excel's **Text to Columns** feature. This allows you to split the full name into a first name and a last name. Afterward, manually review the first name column and delete any entries that are not real names (e.g., usernames, emojis, or single letters).

#### Option 2: AI-Powered Cleaning & Name Normalization (for Large Lists)

For larger lists, an AI-powered spreadsheet add-in (such as **GPT for Excel** or **Numerous.ai**) can automate the name extraction process. Also, use popular GPTs like Claude (our example Claude chat) or ChatGPT. You can use a prompt to instruct the AI to analyze the full name and return only a valid first name.

**Suggested Prompt:** I want you to act as an experienced assistant tasked with extracting the first name from the field to use it in outreach sequences written in English. Extract the first name from **{{Name}}**. It must be a real English or international name written in English. The result can not be symbols, username, or a single letter (like A,B,C.,D., etc.). Do not interpret the data or create a new name. The name should be explicitly written in the field, which you should extract. If a valid first name cannot be found, return nothing. In case of failure, don't provide reasoning, just leave the result empty.

**Tip:** Tools like Numerous.ai have a 255-character limit on prompt length, so pay attention to this! This limit reduces your prompting flexibility, because you're required to type the prompt within the cell.

### Tips for List Preparation

**When in doubt, leave it out.** It is better to use a generic greeting (e.g., Hello) than to use an incorrect name. Delete any first names you are not confident about.

**Save as CSV.** Once your list is cleaned and you have columns for Username, User ID, and First Name, save the file in CSV format. It is now ready to be imported for your outreach campaign.

By following these steps, you can build a clean, targeted prospect list that is ready for a personalized and effective Telegram outreach campaign.

Next Lesson: Launching a Telegram Outreach Sequence