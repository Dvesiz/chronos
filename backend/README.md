# Chronos API

Cloudflare Worker API for Chronos accounts, local-first sync, feedback, and release checks.

## Local setup

1. Install Node.js 20+ and Wrangler 4+.
2. From this directory run `npm install`.
3. Run local D1 migrations:

```powershell
npm run db:migrate:local
```

4. Add local secrets in `backend/.dev.vars` (this file is ignored):

```text
JWT_SECRET=replace-with-a-long-random-secret
RESEND_API_KEY=replace-with-a-new-resend-key
```

5. Start the Worker:

```powershell
npm run dev
```

The local API is normally at `http://localhost:8787`.

## Production deployment

Do not reuse the credentials from `相关配置.txt`. They were exposed and must be revoked/rotated first, including the Resend key, MySQL password, Redis password, S3 access/secret key, and Turnstile secret.

1. Authenticate Wrangler with the Cloudflare account that owns the Worker and D1 database.
2. Create the database:

```powershell
npx wrangler d1 create chronos-db --location apac --update-config
```

3. Confirm the generated `database_id` in `wrangler.jsonc`.
4. Apply the production migration:

```powershell
npm run db:migrate:remote
```

5. Set secrets without putting values in Git. Use newly rotated values only:

```powershell
npx wrangler secret put JWT_SECRET
npx wrangler secret put RESEND_API_KEY
```

`RESEND_FROM_EMAIL=system@mail.donghangyu.dpdns.org` is configured as a non-secret Worker variable; the domain must be verified in Resend.

6. Deploy:

```powershell
npm run deploy
```

7. Set `window.CHRONOS_API_BASE` in the release-specific `cloud-config.js` to the deployed Worker URL before building the APK or publishing the browser demo.

## API overview

- `POST /v1/auth/send-code`: send a one-time email code.
- `POST /v1/auth/verify`: create a user/session or sign in.
- `POST /v1/auth/refresh`: rotate a refresh session.
- `POST /v1/auth/logout`: revoke the current session.
- `GET /v1/sync/snapshot`: fetch the current cloud state.
- `POST /v1/sync/events`: append idempotent state operations.
- `GET /v1/sync/head`: read the latest server sequence.
- `GET /v1/sync/events?after=<seq>`: read later events.
- `PATCH /v1/account/profile`: update nickname/avatar.
- `DELETE /v1/account/delete`: permanently delete account and cloud data.
- `POST /v1/feedback`: submit feedback.
- `GET /v1/app/latest`: read the latest release record.

The client remains local-first. If the API base is empty or the network is unavailable, the existing local data and JSON import/export continue to work.
