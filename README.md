# Call Center Copilot

> **This is a demo. It contains no confidential data/IP.**

A browser-based tool that provides real-time dual audio transcription and AI-powered assistance during call center interactions.

## Overview

Call Center Copilot captures and transcribes both the agent's microphone and the customer's audio (e.g. via Google Meet speaker output) simultaneously, then uses OpenAI's APIs to deliver live assistance to the agent.

## Features

- **Dual audio capture** — records the agent's microphone and the customer's speaker/tab audio independently
- **Real-time transcription** — powered by the OpenAI Realtime API (`gpt-realtime-mini` by default)
- **AI Q&A** — ask questions grounded in the live conversation transcript
- **Auto summaries** — periodic summaries of the ongoing call
- **Response suggestions** — AI-generated reply suggestions for the agent based on customer speech
- **Multi-language support** — 17 languages including English, Spanish, French, German, Chinese, Arabic, Hindi, and more
- **Dark/Light/Auto theme** — toggle via the navbar

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | HTML5, Bootstrap 5.3 |
| Icons | Bootstrap Icons 1.11 |
| LLM config | `bootstrap-llm-provider` |
| Realtime API | OpenAI Realtime WebSocket API |
| Q&A / Summaries | OpenAI Chat Completions API (`gpt-4o`) |
| Audio | Web Audio API, `getUserMedia`, `getDisplayMedia` |

## Files

| File | Description |
|------|-------------|
| `index.html` | Main application UI — layout, styles, and controls |
| `script.js` | Application logic — audio capture, WebSocket streaming, transcription, and AI integration |

## Getting Started

1. **Open `index.html`** in a modern browser (Chrome recommended for full Web Audio API support).
2. Click **Config OpenAI** (under Advanced Settings) and enter your OpenAI API key.
3. Use **Start Mic** to begin transcribing the agent's microphone, **Start Speaker** for the customer's audio, or **Start Both** for simultaneous capture.
4. The live transcript will appear in real time. Use the Q&A panel to ask questions or enable auto-summaries and suggestions.

## Browser Requirements

| Feature | Requirement |
|---------|-------------|
| Microphone capture | `getUserMedia` support |
| Speaker/tab capture | `getDisplayMedia` support |
| Real-time API | WebSocket support |
| Audio processing | `AudioContext` support |

Chrome (or any Chromium-based browser) is strongly recommended.

## Configuration

Advanced settings are available in the accordion panel on the main page:

- **Realtime Model** — choose between `gpt-realtime-mini`, `gpt-realtime`, `gpt-4o-mini-realtime-preview`, or `gpt-4o-realtime-preview`
- **Q&A Model** — choose between `gpt-4o`, `gpt-4o-mini`, or `gpt-4-turbo`
- **OpenAI Base URL** — defaults to `https://api.openai.com/v1`; supports OpenRouter and other compatible endpoints

## Disclaimer

This is a demo. It contains no confidential data/IP.
