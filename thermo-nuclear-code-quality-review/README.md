# thermo-nuclear-code-quality-review

`thermo-nuclear-code-quality-review` provides the same review workflow as
[`@earendil-works/pi-review`](https://github.com/earendil-works/pi-review),
but uses [Cursor's Thermo-Nuclear Code Quality Review skill](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md)
as its review prompt.

## Install

```bash
pi install npm:@atharva-again/thermo-nuclear-code-quality-review
```

For a local checkout:

```bash
pi install ./thermo-nuclear-code-quality-review
```

## Usage

```bash
/thermo-nuclear-review
/thermo-nuclear-review uncommitted
/thermo-nuclear-review branch main
/thermo-nuclear-review commit abc123
/thermo-nuclear-review pr 123
/thermo-nuclear-review pr https://github.com/owner/repo/pull/123
/thermo-nuclear-review folder src docs
/thermo-nuclear-review branch main --extra "focus on performance and error handling"
```

Finish a review branch with:

```bash
/thermo-nuclear-end-review
```

The extension supports all review targets, review-session branching, custom
review instructions, project `REVIEW_GUIDELINES.md` files, and review-summary
and fix-follow-up actions from `pi-review`.

## License

MIT. This package includes modified code from `@earendil-works/pi-review`.
See [LICENSE](LICENSE).
