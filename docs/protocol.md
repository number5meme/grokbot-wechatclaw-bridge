# iLink bot API notes

These are the parts of Tencent's WeChat ClawBot "iLink" bot API that this bridge uses. They are **inferred from
Tencent's official MIT-licensed client** [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)
(protocol version 2.4.10) and community reports. There is no formal public specification, and behavior may change.

Base URL: `https://ilinkai.weixin.qq.com` (after login, use the `baseurl` returned by the server if present).
Everything is client-to-server HTTPS. No inbound connection or webhook is involved.

## Common headers

POST requests:

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot_token>            (omitted before login)
X-WECHAT-UIN: base64(decimal string of a random uint32), new per request
iLink-App-Id: bot
iLink-App-ClientVersion: uint32 0x00MMNNPP of the protocol version (2.4.10 -> 132106)
```

GET requests (`get_qrcode_status`) send only `iLink-App-Id` and `iLink-App-ClientVersion`.
Every POST body includes `"base_info": {"channel_version": "2.4.10", "bot_agent": "<Name/Version>"}`. Community
reports say requests without the full shape can return `200 {}` and deliver nothing.

## Login

1. `POST /ilink/bot/get_bot_qrcode?bot_type=3` with `{"local_token_list": [...]}` (previous bot tokens, or `[]`).
   Response: `{"qrcode": "<poll id>", "qrcode_img_content": "<URL>"}`. `qrcode_img_content` is a **URL to encode as the
   QR payload**, not image data. The same URL works as a fallback link opened inside WeChat.
2. `GET /ilink/bot/get_qrcode_status?qrcode=<id>[&verify_code=<digits>]` (long-poll, about 35 s; treat timeouts as `wait`).

| status | action |
|---|---|
| `wait` | keep polling |
| `scaned` | scanned, waiting for confirmation on the phone |
| `need_verifycode` | user types the digits shown on the phone; poll again with `verify_code` |
| `verify_code_blocked` | too many wrong codes; get a new QR code |
| `scaned_but_redirect` | continue polling on `https://<redirect_host>` (the bridge only follows Tencent hosts: `*.qq.com`, `*.wechat.com`) |
| `expired` | get a new QR code (the official client allows 3 in total, about 5 minutes each) |
| `binded_redirect` | already bound to the supplied token; keep existing credentials |
| `confirmed` | returns `bot_token`, `ilink_bot_id`, optional `baseurl`, and `ilink_user_id` (the account that scanned) |

The bot token is sent to `baseurl` on every call, so the bridge keeps `baseurl` only when it is `https://` on a
`*.qq.com` or `*.wechat.com` host, and otherwise uses the default `https://ilinkai.weixin.qq.com` (also when loading
saved credentials).

## Receiving: `POST /ilink/bot/getupdates`

Body: `{"get_updates_buf": "<cursor or empty>", "base_info": {...}}`. The server holds the request until messages arrive
or about 35 s pass. A client-side timeout is normal. If `longpolling_timeout_ms` is returned, use it for the next poll.
Save `get_updates_buf` whenever it changes and treat it as opaque. The bridge saves it only **after** the batch it came
with was handled (forwarded or saved as undelivered), so a crash or forced stop mid-batch gets the batch again; handled
message ids are kept in `state/seen.json` (last 500) so redelivered messages are not forwarded twice.

Messages: `message_id` (uint64, parse as string), `from_user_id`, `message_type` (1 user, 2 bot), `context_token`,
`item_list` (type 1 text `text_item.text`, 2 image, 3 voice, 4 file, 5 video).
Store the latest `context_token` per user. Replies need it. (The bridge keeps the newest 500 senders, with a count of
messages sent per token for the ~10-reply quota.)

## Replying: `POST /ilink/bot/sendmessage`

```json
{"msg": {"from_user_id": "", "to_user_id": "<user>", "client_id": "<unique>", "message_type": 2, "message_state": 2,
         "item_list": [{"type": 1, "text_item": {"text": "plain text"}}], "context_token": "<latest token>"},
 "base_info": {...}}
```

One item per request. WeChat does not render Markdown, so send plain text.

## Media (CDN)

Media never travels inside the API calls. Items carry a `CDNMedia` reference, and the bytes live on the WeChat CDN
(`https://novac2c.cdn.weixin.qq.com/c2c`), encrypted with **AES-128-ECB, PKCS7 padding**. Sources in the official client:
`src/cdn/aes-ecb.ts`, `cdn-url.ts`, `pic-decrypt.ts`, `cdn-upload.ts`, `upload.ts`, `src/media/media-download.ts`,
`src/media/silk-transcode.ts`, `src/messaging/send.ts`.

`CDNMedia`: `{"encrypt_query_param": "...", "aes_key": "<base64>", "encrypt_type": 0|1, "full_url": "<optional>"}`.

### Inbound

| item | fields used | key |
|---|---|---|
| 2 image | `image_item.media`, `image_item.aeskey` | `aeskey` (32 hex chars) preferred, else `media.aes_key`; no key = not encrypted |
| 3 voice | `voice_item.media`, `voice_item.text` (transcript), `playtime` (ms), `encode_type` (6 = silk) | `media.aes_key` |
| 4 file | `file_item.media`, `file_item.file_name`, `len` | `media.aes_key` |
| 5 video | `video_item.media`, `video_size` | `media.aes_key` |

- Download URL: `full_url` when present, else `{cdn}/download?encrypted_query_param=<urlencoded encrypt_query_param>`. Plain GET.
- `aes_key` has two encodings: base64 of 16 raw bytes (images), or base64 of a 32-char hex string (file, voice, video).
- Voice: when `voice_item.text` is present the official client uses it as the message body and does not download the
  audio. Otherwise the decrypted SILK is decoded with `silk-wasm` at 24000 Hz to mono 16-bit PCM and wrapped as WAV;
  on failure the raw SILK is kept.
- The official client caps media at 100 MB.

### Outbound media

1. Read the file; `rawsize`, `rawfilemd5` (hex MD5), `filesize = ceil((rawsize + 1) / 16) * 16`, a random 16-byte
   `filekey` (hex) and a random 16-byte AES key.
2. `POST /ilink/bot/getuploadurl`:
   `{"filekey", "media_type": 1, "to_user_id", "rawsize", "rawfilemd5", "filesize", "no_need_thumb": true, "aeskey": "<hex key>", "base_info"}`
   (`media_type`: 1 image, 2 video, 3 file, 4 voice). Response: `upload_full_url` and/or `upload_param`.
3. `POST` the AES-128-ECB ciphertext (`Content-Type: application/octet-stream`) to `upload_full_url`, else to
   `{cdn}/upload?encrypted_query_param=<upload_param>&filekey=<filekey>`. 4xx: give up; 5xx / network: retry (3 attempts).
   The response header `x-encrypted-param` is the download parameter.
   The upload URL must be `https://` on an allowed media host (`UPLOAD_URL_REJECTED` otherwise); redirects are not followed.
4. `sendmessage` with one item (a caption, if any, goes first as its own text message). `media` is
   `{"encrypt_query_param": "<x-encrypted-param>", "aes_key": base64(<hex key string>), "encrypt_type": 1}`:
   - image (`media_type` 1): `{"type": 2, "image_item": {"media": {...}, "mid_size": <filesize>}}`
   - video (`media_type` 2, official `sendVideoMessageWeixin`): `{"type": 5, "video_item": {"media": {...}, "video_size": <filesize>}}`
   - file (`media_type` 3, official `sendFileMessageWeixin`): `{"type": 4, "file_item": {"media": {...}, "file_name": "<base name>", "len": "<rawsize as a string>"}}`

   The same `context_token` rules as text apply. The bridge accepts images up to 20 MB and videos and files up to
   100 MB (the official client's media limit); videos are recognized by extension (mp4, mov, webm, mkv, avi).

Voice replies have no implementation in the official client, so this bridge does not offer them.

## Error codes

| code | where | meaning | bridge behavior |
|---|---|---|---|
| `-14` | any call (`ret` or `errcode`, either one) | session expired or stale token | default: status `EXPIRED_-14`, exit 14, no automatic retry; log in again. With `EXPIRED_RETRY_AFTER_MIN=N`: status `PAUSED_-14`, pause N minutes, then poll again (the official plugin pauses for an hour). |
| `-2` | sendmessage | no valid context token: window after the user's last message closed (about 24 h reported), about 10 replies per inbound message used, or text over ~16 KiB (`reply.sh` splits text into 2000-character chunks, so it does not hit this) | reply prints `ERROR -2` and exits 3 (the same meaning as QQ's `ERROR REPLY_WINDOW`); wait for a new user message |
| other non-zero | getupdates | generic error | exponential backoff with jitter (2 s to 60 s) |
| HTTP non-2xx / network | any | transport error | same backoff |

The quotas and windows above come from community observations and maintainers' comments, not from Tencent documentation.
