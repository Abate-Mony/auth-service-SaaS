# Task: Implement "Forgot password" / "Reset password" on the frontend

## Context

The backend now supports a full forgot-password → reset-password flow. Two
new public endpoints exist; this task is building the two screens that call
them.

Auth in this app is entirely cookie-based (httpOnly `token`/`refreshToken`
cookies) — but both endpoints below are hit while the user is **logged out**,
so no cookies are relevant here. Still include `credentials: "include"` on
the `fetch` calls for consistency with the rest of the app.

## 1. Screen A — "Forgot password" (email entry)

Reachable from the login screen ("Forgot your password?").

- A single email input + submit button.
- On submit: `POST /api/v1/auth/forgot-password` with `{ email }`.
- Response is **always** `200 { success: true, msg: "If an account exists
  with that email, a reset link has been sent." }` — this is intentional
  (prevents leaking which emails have accounts), so show that exact message
  regardless of whether the email actually exists. Don't build any UI branch
  for "email not found."
- Only real failure case is `400` for a missing/malformed email — show it as
  a normal field validation error.

```js
async function requestPasswordReset(email) {
  const res = await fetch(`${API_BASE_URL}/api/v1/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email }),
  });
  return res.json();
}
```

## 2. The email itself

If the account exists, it receives an email with a button linking to:

```
${CLIENT_URL}/reset-password?token=<opaque-hex-token>
```

`CLIENT_URL` is whatever the backend's `.env` has configured — confirm with
backend which URL that resolves to per environment (dev/staging/prod), since
that's what determines the route path you need to expose (`/reset-password`
in this example, but confirm the exact path backend has configured).

**The link expires in 30 minutes** — noticeably shorter than the email
verification link (24h). Surface that in the email-sent confirmation copy on
Screen A, e.g. "Check your email — the link expires in 30 minutes."

## 3. Screen B — "Reset password" (new password entry)

This is the page at `/reset-password` that the email link lands on.

- Read `token` from the URL query string on mount. If it's missing entirely,
  show an error state immediately ("Invalid reset link") — don't call the
  API with an empty token.
- Two fields: new password + confirm password. Match them client-side before
  submitting (backend doesn't receive or check a confirmation field).
- Enforce **minimum 8 characters** client-side to match backend validation
  (backend rejects shorter passwords with `400`, but catching it earlier is
  better UX).
- On submit: `POST /api/v1/auth/reset-password` with `{ token, password }`.

```js
async function resetPassword(token, password) {
  const res = await fetch(`${API_BASE_URL}/api/v1/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token, password }),
  });
  if (!res.ok) {
    const { message } = await res.json();
    throw new Error(message);
  }
  return res.json();
}
```

### Response contract

- **`200`** — `{ success: true, msg: "Password reset successfully. Please
  log in." }`. The backend also clears the user's existing session
  server-side (any device that was logged in gets logged out on its next
  request) and clears the browser's own `token`/`refreshToken` cookies on
  this response. **Redirect to the login screen** — don't try to auto-log
  the user in on this response, there's no session left to use.
- **`400`** — token missing/invalid/expired, or password too short. The
  error message is user-facing-safe to display as-is (e.g. "This reset link
  is invalid or has expired." / "Password must be at least 8 characters
  long."). For the expired/invalid case, the UI should offer a link back to
  Screen A to request a new one — don't just show a dead end.

## 4. Testing checklist

- Request a reset for a real account, confirm the email arrives with a
  working link.
- Request a reset for a non-existent email — confirm the UI shows the same
  generic "check your email" message (this is correct behavior, not a bug).
- Open the reset link, set a new password, confirm you're redirected to
  login and the **old** password no longer works.
- Log in on a second device/browser before resetting, then reset the
  password — confirm the second device's session is also invalidated (its
  next API call should 401 and force a re-login).
- Let a reset link sit unused for 30+ minutes, then try it — confirm you get
  the expired-link error with a way back to request a new one.
- Try submitting Screen B with no `token` in the URL at all (e.g. someone
  bookmarks `/reset-password` directly) — confirm it shows the invalid-link
  state without ever calling the API.
