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
- The store lists Meta Ads (the official Meta MCP server, with sign-in in the browser). The listing
  says that the agent can read results and that creating, activating or raising a budget can spend
  real money. OpenCat has no approval per tool for a remote MCP server, so it cannot force one.
- The store lists Microsoft Teams (read only): list chats and read messages with a work or school
  account. It has no send tool. The owner registers an Azure public client app and fills its ID.

