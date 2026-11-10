# Nova

A voice-first desktop work assistant powered by Claude. Talk to it or type; it
answers out loud, runs your day, researches on the web, and remembers you
between conversations.

## What it does

- **Voice conversation.** Click the orb and speak, or switch on the wake word
  and say "Nova, …". Replies are read aloud as they stream in. Speech
  recognition runs on your computer, so audio never leaves it.
- **Runs your day.** Keeps a task list, pops up reminders at the time you ask
  for, reads your calendar, and gives a daily briefing ("Brief me").
- **Research.** Searches the web and reads pages to answer with current
  information.
- **Remembers you.** Saves durable facts (who you work with, how you like
  things done) and uses them in later conversations. Everything it remembers
  is listed in the side panel, where you can delete any item.
- **Works with your files.** Reads and writes text files in one folder you
  choose. Every write asks for your approval first.

## Getting started

You need [Node.js](https://nodejs.org) 20 or newer and an
[Anthropic API key](https://console.anthropic.com/).

```bash
npm install
```

```bash
npm start
```

On first launch the Settings window opens. Paste your API key there (it is
stored encrypted by your operating system), or set the `ANTHROPIC_API_KEY`
environment variable before starting instead.

The first time you use the microphone, the speech model (about 80 MB) is
downloaded once.

### Connecting your calendar

Nova reads calendars through a private iCal link, which needs no extra
sign-in:

- **Google Calendar:** Settings → pick your calendar → *Secret address in iCal
  format*.
- **Outlook:** Settings → Calendar → Shared calendars → *Publish a calendar* →
  ICS link.

Paste the link into Settings → Calendar links. Access is read-only. Treat the
link like a password: anyone who has it can read that calendar.

## Good to know

- **Not built yet:** sending or reading email, and creating or changing
  calendar events. Nova will draft text and set reminders instead.
- Speech recognition is English-only (Whisper `base.en`).
- The wake word works by transcribing each phrase it hears locally and
  checking whether it starts with the assistant's name, so it uses some CPU
  while switched on. While Nova is thinking or speaking the microphone is
  ignored; click the orb to interrupt.
- Requests use the `claude-opus-5-5` model and are billed to your API key. If a
  request is declined by a safety check, the API is allowed to retry it on
  another Claude model (server-side fallback).
- Your settings, tasks and memories are plain JSON files in the app's data
  folder (`data/` inside Electron's user-data directory for "nova-assistant").

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main/main.js` | App window, permissions, reminders |
| `src/main/agent.js` | Conversation loop with Claude |
| `src/main/tools.js` | Actions the assistant can take |
| `src/main/store.js` | Settings, tasks, memory on disk |
| `src/main/calendar.js` | iCal calendar reader |
| `src/main/stt.js` | Local speech-to-text |
| `src/renderer/` | Interface, microphone capture, spoken replies |
| `test/` | Unit tests (`npm test`) |
