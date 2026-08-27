# Task: Implement Web Push on the frontend (TimeShift worker app)

## Context

The backend (`time_sheet_server`) now supports Web Push notifications for
workers — e.g. "your shift starts in 30 minutes". The backend side is done:
it stores push subscriptions per worker and sends notifications via a cron
job. This task is the frontend half: register a service worker, subscribe
the browser to push, send the subscription to the backend, and handle
incoming push events.

Auth in this app is entirely cookie-based (httpOnly `token`/`refreshToken`
cookies, no bearer tokens) — every `fetch` call to the backend must include
`credentials: "include"`, or authenticated endpoints will 401.

## 1. Environment variable

Add to `.env.development` (there should already be a scaffolded, empty
entry for this):

```
VITE_VAPID_PUBLIC_KEY=BA-dA78vHE1G8aJFSCSLvRJVkS2axy8jTGQYxFE_h7pQN3OQdlsWNVWwG1mBEJc3VP9Y6IXb1951JLvSzIfaWi4
```

This is a public key — safe to ship to the client. (The matching private
key lives only in the backend's `.env`, never exposed here.)

## 2. Service worker

If the app doesn't already register a service worker, add one (e.g.
`public/sw.js`) with a `push` and a `notificationclick` listener:

```js
self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  const { title = "TimeShift", body = "", tag, url = "/worker/clock" } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,          // same tag replaces any existing notification in place
      data: { url },
      icon: "/icon-192.png",   // adjust to whatever the app's PWA icon actually is
      badge: "/badge-72.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/worker/clock";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      const existing = windowClients.find((c) => c.url.includes(url));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
```

Register it during app startup if not already done:

```js
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
```

Check first whether a service worker already exists for this app (PWA
install support, offline caching, etc.) — if so, add these two listeners to
the existing file rather than creating a second worker.

## 3. Subscribe flow

```js
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function subscribeToPush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY),
  });

  await fetch(`${API_BASE_URL}/api/v1/workers/push-subscription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(subscription.toJSON()),
  });
}
```

### Backend contract for this endpoint

- **`POST /api/v1/workers/push-subscription`** — worker role only.
- Body: exactly `PushSubscription.toJSON()`'s shape —
  `{ endpoint, expirationTime, keys: { p256dh, auth } }`.
- Idempotent: re-subscribing the same device (same `endpoint`) is a no-op,
  safe to call every time the app starts if you want to keep it simple.
- Response: `{ success: true }` on `200`. `400` if the payload is malformed
  (missing `endpoint` or `keys`).

## 4. When to trigger `subscribeToPush()`

Don't call it automatically on page load. Browsers are aggressive about
auto-suppressing permission prompts that aren't tied to a deliberate user
gesture, and an unsolicited "Allow notifications?" prompt on first visit
tends to get reflexively denied — permanently, with no easy way for the
user to reconsider short of digging into browser site settings.

Trigger it from an explicit action instead:
- A toggle in worker settings ("Enable shift reminders"), or
- A one-time prompt shown right after a worker accepts their first shift.

## 5. Handle subscription invalidation (nice-to-have)

Push subscriptions can silently expire or rotate browser-side. Not all
browsers fire this reliably, but it's cheap to add:

```js
navigator.serviceWorker.ready.then((registration) => {
  registration.addEventListener?.("pushsubscriptionchange", subscribeToPush);
});
```

The backend also self-heals: if a send hits a `410 Gone` from the push
service, it prunes that subscription from the worker's record automatically.
That's the real safety net — this listener just reduces the gap where a
worker might have a genuinely stale subscription sitting around.

## 6. What notifications actually look like today

Right now the backend sends exactly one kind of push: a "shift starting
soon" reminder, fired ~30 minutes before a worker's accepted (not yet
checked in) shift starts, alongside the existing email reminder. Payload
shape:

```json
{
  "title": "Shift starting soon",
  "body": "<Job Title> starts at <HH:mm> — <Location>",
  "tag": "shift-start-<jobId>"
}
```

No `url` is sent for this one — the service worker's `push` handler default
(`/worker/clock`) is intentional; that's where a "shift starting soon" tap
should land. Future notification types may pass different `tag` values and
an explicit `url` — the service worker code above already handles both via
its defaults, no changes needed there for new notification kinds.

## 7. Testing checklist

- Push API requires a secure context (`https://` or `localhost`). Confirm
  whatever dev URL you're testing against is trusted by the browser, or
  subscription will silently fail with no error surfaced to the UI.
- After subscribing, verify the request actually lands: `POST
  /api/v1/workers/push-subscription` → `{ success: true }`.
- To trigger a real end-to-end test without waiting on a real shift: create
  a job whose scheduled start is ~29 minutes from now, accept it as a
  worker, and wait — the backend cron runs every minute and should push
  within that window.
- Test the cleanup path: revoke notification permission for the site (or
  unsubscribe via browser dev tools) without telling the backend, then
  trigger another send — confirm it doesn't error the whole batch and the
  stale subscription gets pruned server-side.
