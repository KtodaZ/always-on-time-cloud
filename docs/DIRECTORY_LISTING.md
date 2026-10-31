# Directory listings

The connector is listed in Claude's Connectors Directory and the ChatGPT plugin directory. This
page holds the listing text both submissions use, so a resubmission starts from what was sent.
Reviewer credentials are entered only in each portal, never here.

## ChatGPT

The package is [`plugin/`](../plugin/): `plugin.json` (listing, review test cases, release notes),
`mcp.json` (the server, with OAuth through a client metadata document) and `assets/icon.png`.
Zip the folder's contents and upload them at platform.openai.com/plugins under the verified
Zombit Studios identity. The portal's domain challenge is served from
`https://alwaysontime.zombit.io/.well-known/openai-apps-challenge`.
The ChatGPT description leaves out the "free, no Plus needed" line, because OpenAI's checker
flags pricing in descriptions.

## Claude

Submitted at claude.ai/directory/manage as an MCP connector.

| Field | Value |
| --- | --- |
| Server URL | `https://alwaysontime.zombit.io/mcp` |
| Name | Always On Time |
| One-liner | Check and change the meeting alarms Always On Time rings on your Android phone: what rings next, alarms for one meeting or a series, and pausing alarms. |
| Categories | Productivity |
| Documentation | https://zombit.io/always-on-time/assistants/ |
| Privacy policy | https://zombit.io/always-on-time/privacy/ |
| Support | https://zombit.io/support (zombit.studios@gmail.com) |
| Icon | `plugin/assets/icon.png` |
| Company | Zombit Studios, https://zombit.io |
| Authentication | OAuth 2.0, required. Claude registers through its client metadata document; no client ID or secret to enter. |
| Data handling | Our own API. No health data, no sponsored content. |
| Reads or writes | Both |

Description:

> Always On Time is an Android app that turns calendar meetings into full-screen alarms, so the
> next meeting doesn't slip past. Connect it to Claude to ask what will ring and to change your
> alarms in plain language.
>
> Ask which alarms ring tomorrow morning, why a meeting has the alarms it has, or which calendars
> the app watches. Make one meeting ring 15 minutes earlier, give a recurring standup its own
> alarms, turn alarms off for a calendar, or pause every alarm until Monday. Each change reaches
> your phone within moments and can be undone from Claude or from Connected assistants in the app.
>
> Secure and private: you sign in with the Google account you use for Always On Time's Account &
> sync, and you approve the connection on a consent page. Claude sees only meeting titles and times
> from the calendars your phone watches, recent alarm history and the app's alarm settings. Your
> calendar stays as it is: meetings are never created or edited, and locations, links, notes and
> attendees stay on your phone.
>
> What you need: Always On Time on an Android phone, signed in under Settings > Account & sync.
> The connection is free and doesn't need Always On Time Plus.

Use cases:

1. See what rings next: "What alarms ring tomorrow morning?"
2. Adjust one meeting or a series: "Make my 3pm ring 15 minutes earlier", "No alarms for the
   Friday standup."
3. Quiet time: "Pause my alarms until Monday", then "Resume my alarms."
4. Calendar-wide settings: "Ring 30 minutes before everything on my Work calendar."
5. Review and undo: "What did you change today? Undo the last one."

Before connecting, users need Always On Time on an Android phone, signed in under Settings >
Account & sync.

## Reviewer access

Reviewers sign in on the consent page with **Sign in with email**, using the review account
entered in each portal. That account has a stand-in phone with a week of sample meetings
([Review account](ASSISTANT_CONNECTOR.md#review-account)), so every tool works without a real
device, including changes, confirmation and undo.
