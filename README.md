Hi :)

This is my fork of Pi. I created it because I thought the features I'm thinking of might be too niche and not make it too the official Pi, and also because those features can't be implemented as an extension, and need a source patch.

> Fork based on upstream Pi v0.80.3

## Features I Have Implemented

### 1. A "Worked For" Time Line

This was inspired by Codex. It shows this:

<img width="762" height="369" alt="image" src="https://github.com/user-attachments/assets/06869672-9b48-41dd-aa81-354c25f44a66" />


I mirrored it in Pi, and it now shows like this:

<img width="762" height="497" alt="image" src="https://github.com/user-attachments/assets/f57bea84-686f-4946-b76c-9acddc01fc07" />


See https://github.com/atharva-again/pi/pull/1 for the PR that implemented this.

### 2. Bi-directional Thinking Toggle

This was also inspired by Codex. It was implemented in https://github.com/atharva-again/pi/pull/2

### 3. A Telegram Client(ish)

It has all commands that Pi has, even your extensions. You can start a new session directly from the bot, instead of starting it from the terminal and continuing in telegram. See PR https://github.com/atharva-again/pi/pull/3 to see how it was implemented.

<img width="330" height="806" alt="Screenshot_20260706-013340" src="https://github.com/user-attachments/assets/e31770b9-a9cb-4b37-84ab-2a7f7d844d4a" />

<img width="330" height="806" alt="Screenshot_20260706-013255" src="https://github.com/user-attachments/assets/35096503-3f4e-4720-a543-d09c02840f72" />

<img width="330" height="806" alt="Screenshot_20260706-013330" src="https://github.com/user-attachments/assets/988f7433-1d22-46fb-a732-77ca38bf0a9b" />

### 4. Pinning Sessions in /resume

Some sessions are more important than others and you go back and forth between them. It's nice to be able to pin them. See PR https://github.com/atharva-again/pi/pull/8 for how it was implemented.

<img width="724" height="186" alt="Screenshot_20260716_114538" src="https://github.com/user-attachments/assets/4cab7a94-cc9f-4e21-9538-962ea333905d" />
<img width="724" height="356" alt="Screenshot_20260716_114605" src="https://github.com/user-attachments/assets/1d8c7b59-6558-41a8-ad89-f39150c5aeef" />

### 5. Resume OpenCode Sessions In Pi

Just wanted to be import opencode sessions directly in pi so I can continue there. Implemented via https://github.com/atharva-again/pi/pull/9 and https://github.com/atharva-again/pi/pull/10. Checkout the extension's [README](https://github.com/atharva-again/pi/blob/main/packages/coding-agent/examples/extensions/resume-opencode/README.md). Watch the demo below.

<img width="726" height="404" alt="pi-resume-opencode" src="https://github.com/user-attachments/assets/1a400e1f-4317-4987-902b-c0a131b8efe6" />

### 6. Resume Codex Sessions in Pi

As you can see, the first two features are implemented were inspired by Codex CLI, so it only makes sense to add support for it here. This was implemented via PR https://github.com/atharva-again/pi/pull/12. You can watch the demo below. Detailed README for the extension can be found [here](https://github.com/atharva-again/pi/blob/main/packages/coding-agent/examples/extensions/resume-codex/README.md).

<img width="723" height="455" alt="pi-codex-resume" src="https://github.com/user-attachments/assets/4b4778bc-871c-4a54-b52f-7f5a21ab5d86" />
