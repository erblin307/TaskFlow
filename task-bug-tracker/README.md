# TaskFlow

TaskFlow is a secure, three-user task and bug tracker with a Vanilla JavaScript frontend and a Node.js/SQLite backend.

## First start

1. Install Node.js 24 or newer.
2. Copy `.env.example` to `.env`.
3. Replace all three placeholder passwords with different passwords of at least 12 characters.
4. Run `npm start`.
5. Open `http://localhost:3000`.

The accounts are `erblin`, `shkumbin`, and `altin`. Password hashes are created in SQLite on the first start; plaintext passwords are never written to the database or sent back to the browser.

## Production deployment

- Set `NODE_ENV=production` and `HOST=0.0.0.0`.
- Terminate TLS at the hosting platform or a trusted reverse proxy. Production cookies require HTTPS.
- Keep `.env` and the `data/` directory private and outside public static hosting.
- Back up `data/taskflow.db` and restrict filesystem permissions to the application user.
- Use unique, randomly generated passwords and rotate them if exposure is suspected.
- Run one application instance unless sessions and rate limits are moved to shared infrastructure.
- Keep Node.js patched and monitor authentication failures and server errors.

## Security model

- Passwords use Node's `scrypt` with a unique random salt.
- Sessions use random tokens stored as SHA-256 hashes in SQLite.
- Authentication cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` in production.
- State-changing requests require a session-bound CSRF token.
- Login and write endpoints are rate limited.
- Authorization is enforced on the server for every record.
- Inputs are length-limited, validated, and written through prepared SQLite statements.
- Screenshots are type-checked, signature-checked, access-controlled, and limited to 5MB.
- CSP and other browser security headers are enabled.

No internet-facing application can honestly be guaranteed “unhackable.” Keep the runtime patched, use HTTPS, protect backups and secrets, and perform periodic security reviews.
