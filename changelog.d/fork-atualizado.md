### Fixed

- An agent on a Gemini model now moves to its backup model when Google reports a spent model quota.
  Before, the turn failed with the usage limit message and the agent stayed on that model.
