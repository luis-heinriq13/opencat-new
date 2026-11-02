### Fixed

- An agent on a Gemini model now moves to its backup model when Google reports a spent model quota.
  Before, the turn failed with the usage limit message and the agent stayed on that model.

### Added

- The Antigravity provider now runs through a local gateway in OpenCat, with no other program in
  between. It uses your signed-in Antigravity accounts, moves to the next account at a limit, and
  listens only on this computer. Its saved model ids stay the same. The Gemini provider does not change.

### Added

- An installed app can be pinned to the page rail from its store page. A pinned app that opens a
  panel (WhatsApp, not official) opens it; any other pinned app opens its store page. An app that
  is not installed does not show in the rail. Saved rail layouts keep working.
- The store lists Meta Ads, with its own local server on the Marketing API (Graph v26.0): the owner
  pastes a token once. Reads are always on. Creating a campaign (always paused), pause, resume and
  budget changes stay off until the owner sets a daily budget cap; the server refuses a budget above
  the cap, refuses a resume that would pass it, allows 10 changes per hour, and shows before and after.
  Meta's hosted MCP server refused the OpenCat sign-in, so it is no longer used.
- The store lists Microsoft Teams: list chats and read messages with a work or school account, with
  no Azure registration (public client "Microsoft Graph Command Line Tools", device code at
  https://microsoft.com/devicelogin). Sending (`teams_enviar_mensagem`) is off until the server
  variable `TEAMS_PERMITIR_ENVIO` is `sim`; then it asks for the send scopes, allows 20 messages per
  hour, and shows the recipient and text. Received messages are marked as untrusted data.
- Meta Ads and Teams have their own marks in the store and on the page rail.
- Settings > Providers lists Antigravity as its own provider, with the Google accounts of Gemini,
  its models, and a note that the route uses an unofficial client. It no longer shows in the custom
  providers list. The `antigravity-pro` id, and the agents that use it, stay the same.
