# Changelog

## [Unreleased]

### Changed

- Updated Pi runtime dependencies to 0.80.8 using the refreshed Telegram RPC support fork.

## [0.1.3] - 2026-07-06

### Fixed

- Restored Telegram rich-message rendering for rich Markdown so tables render as native Telegram tables.

## [0.1.1] - 2026-07-06

### Fixed

- Added npm package homepage, repository, and issue tracker metadata for the scoped `@atharva-again/pi-tg` package.

## [0.1.0] - 2026-07-05

### Added

- Added the initial Telegram client package and bot runtime ([827e552](https://github.com/atharva-again/pi/commit/827e552d44903f36d056c2bd46cd3220d42fd855)).
- Added Telegram-native handling for Pi slash commands, inline button flows, session controls, model selection, import/export, tree navigation, resume, reload, trust, login/logout guidance, and stop/quit actions ([827e552](https://github.com/atharva-again/pi/commit/827e552d44903f36d056c2bd46cd3220d42fd855)).
- Added dynamic workspace extension, prompt, and skill command registration for Telegram menus ([4d07af4](https://github.com/atharva-again/pi/commit/4d07af4acf7498e2cfc2ebf9e34543cf72148d37)).
- Renamed the package and binary to `pi-tg` after confirming `pi-telegram` was unavailable on npm ([28db23a](https://github.com/atharva-again/pi/commit/28db23a6ade88baf54c89d1794356950f99343e4)).
- Added interactive `pi-tg setup`, saved config loading, and `pi-tg doctor` for bot token/config validation ([69cefb](https://github.com/atharva-again/pi/commit/69cefbab3390d8b56c91cf52475b8db194c385ab)).
- Added npm-installable packaging by removing the unpublished orchestrator dependency from `pi-tg` ([8bf734](https://github.com/atharva-again/pi/commit/8bf7345f3241ffc5198c6b49c02159af8cd0472d)).
- Hardened Telegram runtime handling by preserving failed updates for retry, persisting resumed workspace bindings, using standard MarkdownV2 rendering, and catching async UI notification failures ([9acf6e](https://github.com/atharva-again/pi/commit/9acf6e8164f7faf0fd1a9a67ea832c0ee8f4f524)).
