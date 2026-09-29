# Meta App Review: RB Post

RB Post lets creators and small businesses write, schedule and publish posts to Threads and Instagram, and
optionally send **their own fixed template replies** to new comments, direct messages and Threads replies. Replies
are never AI-generated and the product never starts a conversation with anyone.

> Status of this document: the endpoints and flows below are implemented and covered by automated tests with
> mocked Meta responses. **None of the automation calls have been exercised against live Meta APIs yet**, because
> the app does not yet have the new permissions. The "API test-call checklist" must be completed with a real test
> account before submitting.

## OAuth scopes

Instagram API with Instagram Login (`https://www.instagram.com/oauth/authorize`):

```
instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages
```

Threads API (`https://threads.net/oauth/authorize`):

```
threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies
```

Defined once in `src/lib/automation.ts` (`instagramScopes`, `threadsScopes`) and used by both OAuth flows.

## Why each permission is needed

| Permission                           | What RB Post does with it                                                                                                                                                                                                                                                     | Where the user sees it               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `instagram_business_basic`           | Reads the connected professional account's ID and username to show which account is linked, to address API calls, and to recognise (and never answer) the account's own comments and messages.                                                                                | Connections page, Automations page   |
| `instagram_business_content_publish` | Publishes the image posts the user creates and schedules in RB Post (`POST /{ig-id}/media`, `POST /{ig-id}/media_publish`).                                                                                                                                                   | Create Post → Publish now / Schedule |
| `instagram_business_manage_comments` | Receives `comments` webhooks for the user's media and, only if the user turned it on, posts the user's own public reply template (`POST /{ig-comment-id}/replies`) and at most one private reply per comment within 7 days (`POST /me/messages` with `recipient.comment_id`). | Automations → Instagram              |
| `instagram_business_manage_messages` | Receives `messages` webhooks and, only if the user turned it on, answers a person who messaged the account first with the user's DM template, within 24 hours of that person's message (`POST /me/messages` with `recipient.id`).                                             | Automations → Instagram              |
| `threads_basic`                      | Reads the connected Threads profile (ID, username) and the user's own recent posts.                                                                                                                                                                                           | Connections page                     |
| `threads_content_publish`            | Publishes the user's scheduled and immediate Threads posts.                                                                                                                                                                                                                   | Create Post                          |
| `threads_read_replies`               | Reads direct (top-level) replies to the user's own posts from the last 7 days (`GET /{media-id}/replies`, reverse chronological, stopping at a stored checkpoint) and receives `replies` webhooks.                                                                            | Automations → Threads                |
| `threads_manage_replies`             | Posts the user's public reply template under a new reply (`POST /{user-id}/threads` with `reply_to_id`, then `POST /{user-id}/threads_publish`).                                                                                                                              | Automations → Threads                |

**Threads direct messages are not implemented.** No public Threads messaging API is used or requested; Threads
automation only creates public replies, and the UI says so.

## Safeguards reviewers can verify

- Off by default. Each connected account has a master switch and per-feature switches; a "Pause all" button stops
  every automation immediately, including replies already queued.
- No cold messages: DMs are only sent in reply to a message the person sent, within 24 hours; private replies only
  once per comment, within 7 days. Expired windows are never retried.
- Never replies to the account's own comments, messages (`is_echo`) or replies (`is_reply_owned_by_me`), never to
  replies-of-replies, and never to text identical to one of the user's own templates (loop guard).
- Per-person cooldown (1–1440 minutes, default 60), at most 3 automated replies per person per day, and at most 60
  automated replies per account per hour.
- Each inbound event is recorded once (unique provider ID) and each reply is sent at most once; a reply whose
  outcome is unknown is marked "Unverified" and never resent.
- Message and comment text is used only to apply the user's keyword filters and is never stored. Event metadata is
  deleted after 30 days. Access tokens are stored encrypted (AES-256-GCM).

## Reviewer prerequisites

1. An Instagram **professional** (Business or Creator) account that is **public**, added as an Instagram Tester of
   the app, plus a second Instagram account to comment and send a DM.
2. A Threads account added as a Threads Tester, with at least one public post from the last 7 days, plus a second
   Threads account to reply.
3. An RB Post login with an active plan (provided in the review notes).
4. App settings in place: redirect URIs, webhook callback URLs and subscribed fields (see "Dashboard configuration").

## Reviewer test steps

1. Sign in at `https://<domain>/login` with the provided credentials.
2. Open **Connections** → **Connect Instagram**. The Instagram consent screen lists all four Instagram permissions.
   Approve. You return to Connections showing the account as **Connected**.
3. **Connect Threads** → confirm the active account → approve the four Threads permissions → **Connected**.
4. Open **Automations**. Both accounts show their granted capabilities (Publish posts, Reply to comments, Reply to
   messages / Reply to Threads replies).
5. Instagram card: turn on **Automation for this account**, **Reply publicly to new comments** (template e.g.
   "Thanks! Details sent.") and **Auto-reply to new DMs** (template e.g. "Thanks for your message!"). Optionally turn on
   **Also send a private reply**. Save.
6. From the second Instagram account, comment on the professional account's latest post. Within about a minute the
   template appears as a public reply (and, if enabled, as a private message).
7. From the second Instagram account, send a DM to the professional account. Within about a minute the DM template
   arrives.
8. Threads card: turn on **Automation for this account** and **Reply to new replies on your threads** with a
   template. Save.
9. From the second Threads account, reply to the test account's recent post. Within a few minutes (webhook) or at most
   about five minutes (polling fallback) the template appears as a public reply.
10. Press **Pause all**, comment again: no reply is sent.
11. Publishing: **Create Post** → write a caption, add an image, target **Threads + Instagram** → **Publish now**.

## Screencast checklist

- [ ] Login to RB Post.
- [ ] Instagram OAuth consent screen with all four Instagram permissions visible, then approval.
- [ ] Threads OAuth consent screen with all four Threads permissions visible, then approval.
- [ ] Connections page showing both accounts connected.
- [ ] Automations page: capabilities, the DM-window warning and the "Threads creates public replies" note.
- [ ] Enabling Instagram comment reply and DM reply with visible templates, then Save.
- [ ] A second account commenting; the automated public reply appearing in the Instagram app.
- [ ] The private reply arriving in the commenter's inbox (if shown).
- [ ] A second account sending a DM; the automated DM reply appearing.
- [ ] Enabling Threads reply automation; a second account replying; the automated public Threads reply appearing.
- [ ] "Pause all" stopping replies.
- [ ] Publishing a post to Threads and Instagram from Create Post.

## API test-call checklist (complete with live credentials before submitting)

Record the date and result for each. Leave unchecked until actually performed.

- [ ] `GET graph.instagram.com/v25.0/me?fields=id,username,user_id`
- [ ] `POST graph.instagram.com/v25.0/me/subscribed_apps?subscribed_fields=comments,messages` → `{"success":true}`
- [ ] Webhook verification `GET /api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
- [ ] Signed `comments` webhook received and recorded
- [ ] `POST graph.instagram.com/v25.0/{ig-comment-id}/replies` with `message`
- [ ] `POST graph.instagram.com/v25.0/me/messages` with `{"recipient":{"comment_id":…},"message":{"text":…}}`
- [ ] Signed `messages` webhook received and recorded
- [ ] `POST graph.instagram.com/v25.0/me/messages` with `{"recipient":{"id":<IGSID>},"message":{"text":…}}`
- [ ] Threads webhook verification `GET /api/webhooks/threads?...`
- [ ] Signed Threads `replies` webhook received and recorded
- [ ] `GET graph.threads.net/v1.0/{user-id}/threads?fields=id,timestamp`
- [ ] `GET graph.threads.net/v1.0/{media-id}/replies?fields=id,text,username,timestamp,is_reply_owned_by_me&reverse=true`
- [ ] `POST graph.threads.net/v1.0/{user-id}/threads` with `media_type=TEXT&text=…&reply_to_id=…`
- [ ] `POST graph.threads.net/v1.0/{user-id}/threads_publish` with `creation_id`

## Dashboard configuration (not changed by this code)

- Instagram → Webhooks: callback `https://<domain>/api/webhooks/instagram`, verify token = `META_WEBHOOK_VERIFY_TOKEN`,
  subscribe to `comments` and `messages`.
- Threads → Webhooks ("Get real-time notifications with Threads Webhooks"): callback
  `https://<domain>/api/webhooks/threads`, same verify token, subscribe to `replies`.
- The payload signature (`X-Hub-Signature-256`) is checked against `META_WEBHOOK_APP_SECRET`, `INSTAGRAM_APP_SECRET`
  (Instagram only) and `META_APP_SECRET`, whichever are set. Meta's documentation says "your app's App Secret"
  without naming which of the dashboard secrets signs Instagram Login and Threads deliveries, so confirm with a live
  delivery and set `META_WEBHOOK_APP_SECRET` if neither matches.
- Webhooks are only delivered to a Live app; `comments` needs Advanced Access; the Threads replies webhook needs Live
  mode / Advanced Access and a verified business. Until then Threads replies are still found by polling.

## Limitations

- Threads: only direct replies to the user's own posts from the last 7 days; replies older than the moment Threads
  automation was switched on are never answered. Replies from private profiles have no username, so the per-person
  cooldown cannot apply to them (account-wide limits still do).
- Instagram: comments on Live media, story replies, reactions, postbacks and attachments without text are ignored.
- Replies are plain text templates, with no placeholders and no AI generation.

## Sources

- Instagram webhooks: https://developers.facebook.com/docs/instagram-platform/webhooks
- Webhook payload examples: https://developers.facebook.com/docs/instagram-platform/webhooks/examples
- Comment replies: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/comment-moderation
- Private replies: https://developers.facebook.com/docs/instagram-platform/private-replies
- Messaging API: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
- Business Login token response: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
- Threads replies: https://developers.facebook.com/docs/threads/retrieve-and-manage-replies/replies-and-conversations
- Threads webhooks: https://developers.facebook.com/docs/threads/webhooks
- Threads changelog: https://developers.facebook.com/docs/threads/changelog
