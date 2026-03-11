# GenerateUI Backend

Backend source of truth for identity + billing entitlement.

## Core Contract

- Login (`/auth/*`) only authenticates identity and issues JWT with `sub = userId`.
- Plan/feature access is decided only on backend based on Stripe state.
- CLI/frontend sends only `Authorization: Bearer <token>` and consumes `/me`.

## Data Model

- `users`: authenticated users.
- `auth_identities`: provider identity mapping (`github/google` -> `user_id`).
- `subscriptions`: latest Stripe subscription state per subscription id.
- `entitlements`: effective feature flags returned by `/me`.
- `billing_events`: webhook audit/idempotency.

## Billing Endpoints

- `POST /billing/checkout-session`
  - Auth required (`Bearer`).
  - Body: `{ "priceId": "price_xxx", "successUrl": "...", "cancelUrl": "..." }`
  - Creates Stripe checkout session from backend.

- `POST /billing/webhook`
  - Stripe webhook endpoint.
  - Validates `stripe-signature` using `STRIPE_WEBHOOK_SECRET`.
  - Updates `subscriptions` + `entitlements`.

- `POST /billing/subscription/cancel`
  - Auth required (`Bearer`).
  - Body: `{ "immediately": false }` (default `false`, cancels at period end).
  - Uses Stripe API to cancel subscription and updates local state/entitlements.

- `POST /billing/customer-portal-session`
  - Auth required (`Bearer`).
  - Body (optional): `{ "returnUrl": "https://app.exemplo.com/billing" }`
  - Returns Stripe Customer Portal URL so user can cancel in Stripe official UI.

- `GET /billing/dev-plan`
  - Hosted page with plan details and "Gerenciar / Cancelar na Stripe" button.
  - Can receive token in query param `access_token` or read from localStorage.

## Direct Login -> Stripe (optional)

- You can start OAuth and go straight to Stripe checkout:
  - `/auth/github?start_checkout=1&price_id=price_xxx&success_url=https://ext/success&cancel_url=https://ext/cancel`
  - `/auth/google?start_checkout=1&price_id=price_xxx&success_url=https://ext/success&cancel_url=https://ext/cancel`
- Or set defaults in env and just use `/auth/github` or `/auth/google`.
- If user is already `active/trialing`, backend skips Stripe and redirects to success URL with `already_subscribed=1`.

## Production Login Flow (Expected)

Depends on how you configure the login mode in production.

**1) Normal login (no auto-checkout)**  
Used when `LOGIN_AUTO_CHECKOUT` is not `true`.

1. User opens `https://SEU_BACKEND/` or `https://SEU_BACKEND/auth/github` (or `/auth/google`).
2. OAuth (GitHub/Google) authenticates.
3. Backend redirects to `redirect_uri` with `access_token` and `expires_at`.
4. Front uses the token and calls `/me` for features/status.

**2) Login -> Stripe direct (auto-checkout)**  
Used when `LOGIN_AUTO_CHECKOUT=true` and `LOGIN_STRIPE_*` are configured.

1. User opens `https://SEU_BACKEND/auth/github` (or `/auth/google`).
2. OAuth authenticates.
3. Backend creates Stripe Checkout Session and redirects directly to Stripe.
4. Stripe finishes and returns to `LOGIN_STRIPE_SUCCESS_URL` or `LOGIN_STRIPE_CANCEL_URL`.
5. Webhook updates `entitlements`.
6. Front uses `/me` to reflect status.

**Important exception (already implemented):**  
If the user is already `active` or `trialing`, backend does not send them to Stripe and redirects to `LOGIN_STRIPE_SUCCESS_URL?already_subscribed=1`.

**Status meaning:**  
- `active`: paid and active subscription.  
- `trialing`: user is in trial (Stripe subscription with trial).

## `/me` response

`/me` returns effective entitlements only from backend state:

```json
{
  "userId": "uuid",
  "subscription": {
    "status": "active|trialing|past_due|unpaid|canceled|...",
    "isActive": true,
    "reason": "subscription_active"
  },
  "features": {
    "intelligentGeneration": true,
    "safeRegeneration": true,
    "uiOverrides": true,
    "maxGenerations": -1
  }
}
```

## Entitlement Rules

- `active` / `trialing` => dev features ON.
- `past_due` / `unpaid` / `canceled` / `incomplete*` / `paused` => dev features OFF.

## Required Env Vars

- `DATABASE_URL`
- `GENERATEUI_JWT_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PORTAL_RETURN_URL` (recommended when using customer portal)
- Optional direct login->checkout:
  - `LOGIN_AUTO_CHECKOUT=true`
  - `LOGIN_STRIPE_PRICE_ID=price_xxx`
  - `LOGIN_STRIPE_SUCCESS_URL=https://sua-url-externa/sucesso`
  - `LOGIN_STRIPE_CANCEL_URL=https://sua-url-externa/cancelado`
- OAuth: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
