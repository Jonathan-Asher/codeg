# Dictation clean-up and translation

The codeg iOS app transcribes speech on the phone (ivrit.ai Whisper for
Hebrew), then sends the transcript to the codeg server it is connected to. The
server cleans it up and/or translates it with a fast cloud model and returns
the text. The provider keys live in codeg. The phone never sees them.

If the call fails, the client sends the original transcript as is.

Code: `src-tauri/src/dictation_refine/` (logic, prompts, providers),
`src-tauri/src/commands/dictation_refine.rs` (the `_core` functions and the
desktop commands), `src-tauri/src/web/handlers/dictation_refine.rs` (HTTP).
Settings UI: Settings › General › Dictation clean-up and translation.

## Calling it

Every command is `POST /api/<command>` on codeg-server (or the desktop app's
web service), with the same bearer token as every other `/api` route, and a
JSON body. On the desktop the same names are Tauri commands with the same
arguments.

```http
POST /api/refine_dictation
Authorization: Bearer <codeg token>
Content-Type: application/json
```

Errors use codeg's normal error body (see below) with a non-2xx status.

## `refine_dictation`

Request (every field except `text` may be omitted or `null`; `null` falls back
to the server's settings):

```json
{
  "text": "אה… תשמע, בעצם, אני צריך לשלוח את המסמך ללקוח.",
  "translate": null,
  "refine": null,
  "targetLanguage": null,
  "sourceLanguage": "Hebrew"
}
```

| Field | Type | Meaning |
|---|---|---|
| `text` | string | The transcript. Required; blank is an error. |
| `translate` | bool \| null | Translate to the target language. Default: the setting (on). |
| `refine` | bool \| null | Clean up: filler words, false starts, repetitions, punctuation. Default: the setting (on). |
| `targetLanguage` | string \| null | A language name (`"English"`) or code (`"en"`). Default: the setting (`"English"`). |
| `sourceLanguage` | string \| null | The dictation's language, name or code (`"Hebrew"`, `"he"`). Optional; it is named in the prompt, and Google gets it as `source`. |

Response `200`:

```json
{
  "text": "I need to send the document to the client.",
  "provider": "groq",
  "model": "openai/gpt-oss-120b",
  "elapsedMs": 412
}
```

| Field | Type | Meaning |
|---|---|---|
| `text` | string | The result, trimmed. Never empty. |
| `provider` | string | `groq`, `cerebras`, `openai`, `anthropic`, `google`, `custom`, or `none` when both `refine` and `translate` are off (then `text` is the input, trimmed, and nothing is called). |
| `model` | string | The model used. `cloud-translation-v2` for Google, `""` for `none`. |
| `elapsedMs` | number | Time spent on the provider, retry included. |

Behaviour:

- One attempt with a 10 s timeout, then one retry after 300 ms. The worst
  case is about 20.3 s, so give the request a client timeout of at least
  25 s.
- An empty answer counts as a failure, and is retried.
- If clean-up alone (no translation) returns less than half of a dictation
  longer than 200 characters, the call fails rather than lose the message.
- Google only translates: `refine: true` with Google selected is an error.

## Errors

Codeg's `AppCommandError` body:

```json
{
  "code": "authentication_failed",
  "message": "Groq: the API key was rejected — check it in Settings › General › Dictation clean-up and translation"
}
```

`message` is written for the user and can be shown as is. Provider details
that could echo part of a key are not included.

| Situation | `code` | HTTP |
|---|---|---|
| Blank `text` | `invalid_input` | 400 |
| No key for the selected provider; custom provider without endpoint or model | `configuration_missing` | 422 |
| Clean-up asked of Google; the provider says the model does not exist (404) | `configuration_invalid` | 422 |
| The provider rejected the key (401/403) | `authentication_failed` | 422 |
| Offline, timeout, rate limit (429), provider 5xx or other HTTP error | `network_error` | 500 |
| Empty answer twice, unreadable answer, clean-up dropped most of the text | `task_execution_failed` | 500 |
| The server's key store would not open | `io_error` | 500 |

In every case the client keeps the original transcript.

## `get_dictation_refine_settings`

Request body: `{}`. Response:

```json
{
  "provider": "groq",
  "model": "",
  "endpoint": "",
  "targetLanguage": "English",
  "refine": true,
  "translate": true,
  "instructions": "",
  "configured": true,
  "providers": [
    { "id": "groq", "label": "Groq", "hasKey": true, "defaultModel": "openai/gpt-oss-120b" },
    { "id": "cerebras", "label": "Cerebras", "hasKey": false, "defaultModel": "gpt-oss-120b" },
    { "id": "openai", "label": "OpenAI", "hasKey": false, "defaultModel": "gpt-4o-mini" },
    { "id": "anthropic", "label": "Anthropic", "hasKey": false, "defaultModel": "claude-haiku-4-5-20251001" },
    { "id": "google", "label": "Google Cloud Translation", "hasKey": false, "defaultModel": null },
    { "id": "custom", "label": "Custom (OpenAI-compatible)", "hasKey": false, "defaultModel": null }
  ],
  "keyError": null
}
```

| Field | Meaning |
|---|---|
| `provider` | The selected provider id. |
| `model` | Model override; `""` uses the provider's `defaultModel`. |
| `endpoint` | The custom provider's base URL (`/chat/completions` is added when missing). |
| `targetLanguage`, `refine`, `translate` | The defaults `refine_dictation` falls back to. |
| `instructions` | The user's extra instructions, added to the built-in ones. |
| `configured` | The selected provider can be called: it has a key. A custom provider needs its endpoint and model instead (its key is optional). |
| `providers[].hasKey` | A key is stored for that provider. Keys themselves are never returned. |
| `keyError` | The key store would not open; `hasKey` may then read `false` for keys that exist. |

A client can call this to decide whether to offer clean-up at all
(`configured`).

## `update_dictation_refine_settings`

A partial update. Every field is optional; an absent or `null` field keeps
its value. Returns the same view as `get_dictation_refine_settings`.

```json
{
  "provider": "groq",
  "model": "",
  "endpoint": "",
  "targetLanguage": "English",
  "refine": true,
  "translate": true,
  "instructions": "Keep legal terms in Hebrew.",
  "apiKey": "gsk_…",
  "keyProvider": "groq"
}
```

- `apiKey` sets the key of `keyProvider`, or of the selected provider (after
  this update) when `keyProvider` is absent. `""` removes that key.
- `model: ""`, `instructions: ""` and `endpoint: ""` clear the value;
  `targetLanguage: ""` resets it to English.
- Changing `provider` without sending `model` clears the model override:
  model ids rarely carry across providers.
- An unknown provider id or a non-http(s) endpoint is `invalid_input` (400),
  and nothing is stored.

## Providers

| id | API | Default model |
|---|---|---|
| `groq` | `https://api.groq.com/openai/v1/chat/completions` (OpenAI-compatible) | `openai/gpt-oss-120b` |
| `cerebras` | `https://api.cerebras.ai/v1/chat/completions` (OpenAI-compatible) | `gpt-oss-120b` |
| `openai` | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` |
| `anthropic` | `https://api.anthropic.com/v1/messages`, no `temperature` | `claude-haiku-4-5-20251001` |
| `google` | Cloud Translation v2 (`translate/v2`, API key). Translation only. | none |
| `custom` | Any OpenAI-compatible endpoint; endpoint and model required, key optional | none |

OpenAI-compatible requests send `temperature: 0.1`, the system prompt and the
transcript as the user message.

## Keys

Each key is stored in codeg's secret store as
`secret:dictation-refine-<provider>`: the OS keychain for the desktop app, the
0600 `tokens.json` in `CODEG_DATA_DIR` for codeg-server. They are never
logged, never written to the settings row and never returned by any command.
