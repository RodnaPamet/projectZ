# Setting up the two sign-in providers

Everyone — players, coaches, club staff, admins — signs in with **Google or
Facebook**, and nothing else (#361, owner decisions Q15/Q21). There is no
password form, and no password sign-in in any deployment: email and password
exist for the test suites only (`TEST_PASSWORD_SIGN_IN=1` with
`DEPLOY_ENV=test`), and a deployment whose environment carries that flag refuses
to start. Microsoft Entra sign-in was removed with its club group sync (#114).

`curl -s https://playerz.bg/api/ready | jq .features.signIn` reports
`{"google":…,"facebook":…,"credentials":"disabled"}`. Each provider flips to
`configured` when its two variables are present. That endpoint is the check —
"it is off" should be an observation, not a discovery.

A provider with no credentials is **not registered at all**, deliberately. A
button that takes you to Google and fails _there_ gives a provider-side error
page nobody can act on.

## Current state (2026-10-07)

|                | Production                                                 | Staging                                                                          |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Origin         | `https://playerz.bg` — `app.playerz.bg` and `www` 302 here | `https://staging.playerz.bg` — the old `staging.35-187-80-26.sslip.io` 302s here |
| `NEXTAUTH_URL` | `https://playerz.bg`                                       | `https://staging.playerz.bg`                                                     |
| Variables      | `GOOGLE_*`, `FACEBOOK_*` in `/opt/playerz/.env`            | `GOOGLE_*`, `FACEBOOK_*` in `/opt/playerz/.env.staging`                          |

**Google**: Cloud project `playerzbg`, OAuth client `32614007699-v720…`. Its
authorised redirect URIs are the `/api/auth/callback/google` path on
`app.playerz.bg`, `playerz.bg` and `staging.playerz.bg`. Each was verified
positively — Google's sign-in page for the registered URI, and an error for a
bogus-URI control. The sslip staging URI was removed.

**Facebook**: the Meta app **"playerz.bg"**, App ID `28557453233922839`, in
**Development** mode, with the owner as its only admin. Its Valid OAuth Redirect
URIs, as entered, are the `/api/auth/callback/facebook` path on
`app.playerz.bg`, `playerz.bg` and `staging.playerz.bg` (possibly the sslip
staging one too); App domains is `playerz.bg`. Meta exposes neither setting
through the Graph API, so both stay **unverified until a real sign-in** — see
"Proving it" below.

Secrets never go in this file, an issue or a chat: they live in the two `.env`
files on the box and in the providers' consoles.

---

## Google

### 1. Pick a project

<https://console.cloud.google.com/projectcreate>

A separate project from `hazel-design-419410` (which is agrent's) keeps the two
consent screens, quotas and audit trails apart. playerz's is `playerzbg`.

### 2. Configure the consent screen

<https://console.cloud.google.com/auth/branding>

| Field                | Value        |
| -------------------- | ------------ |
| User type / Audience | **External** |
| App name             | playerz.bg   |
| User support email   | your address |
| Authorised domain    | `playerz.bg` |
| Developer contact    | your address |

Scopes: leave the defaults. This app asks for `openid`, `email` and `profile`
and nothing more — all **non-sensitive**, which is what makes the next point
true.

### 3. Publish it

<https://console.cloud.google.com/auth/audience>

While the app is in **Testing**, only accounts you list as test users can sign
in at all, and their refresh tokens expire after seven days. Press **Publish
app** to move it to Production.

Because the scopes are non-sensitive, publishing does **not** require Google's
verification review. Verification is for sensitive and restricted scopes.

### 4. Create the client

<https://console.cloud.google.com/auth/clients> → **Create client** →
**Web application**

| Field                    | Value                                                 |
| ------------------------ | ----------------------------------------------------- |
| Authorised redirect URIs | `https://playerz.bg/api/auth/callback/google`         |
|                          | `https://app.playerz.bg/api/auth/callback/google`     |
|                          | `https://staging.playerz.bg/api/auth/callback/google` |

The redirect URI must match **exactly** — scheme, host, path, no trailing
slash. Google compares the string.

Copy the **Client ID** and **Client secret**.

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

---

## Facebook

### 1. Create the app

<https://developers.facebook.com/apps> → **Create app**. Use case: **Authenticate
and request data from users with Facebook Login**. Name it `playerz.bg`.

App settings → **Basic** → **App domains**: `playerz.bg`.

### 2. Facebook Login settings

Use cases → **Authentication and account creation** → **Customize** →
**Settings**:

| Setting                           | Value                    |
| --------------------------------- | ------------------------ |
| Client OAuth login                | Yes                      |
| Web OAuth login                   | Yes                      |
| Enforce HTTPS                     | Yes                      |
| Use Strict Mode for redirect URIs | Yes                      |
| Login with the JavaScript SDK     | No — the app never loads |
| Valid OAuth Redirect URIs         | the three below          |

```
https://playerz.bg/api/auth/callback/facebook
https://app.playerz.bg/api/auth/callback/facebook
https://staging.playerz.bg/api/auth/callback/facebook
```

**Strict mode compares the whole string.** The path is built from next-auth's
provider id, `facebook`, and the host from `NEXTAUTH_URL` — so `NEXTAUTH_URL`
decides which of the three is sent, and a host that is not on the list fails at
Facebook with _"URL blocked"_, after the person has already agreed. The
`app.playerz.bg` entry stays until its redirect to `playerz.bg` is made
permanent; an sslip staging entry, if one was entered, is no longer sent by
anything and can go.

### 3. Permissions

The app asks for `email` and `public_profile` — both granted to every app for
Facebook Login without App Review. Add `email` under the use case's
**Permissions** if it is not listed.

`email` is what the account is found by. Facebook leaves it out when the person
unticks it on the consent screen, or when the account has no address (some are
phone-only). The app then refuses the sign-in and says why, with a button that
asks Facebook for the permission again (`auth_type=rerequest`) and the Google
button beside it; it never creates an account without an email.

### 4. Collect the values

App settings → **Basic** → **App ID** and **App secret** (**Show**).

```
FACEBOOK_CLIENT_ID=<App ID>
FACEBOOK_CLIENT_SECRET=<App secret>
```

Exactly these two names: `src/auth.ts` registers the provider only when both
are set.

### 5. Going Live

In **Development** mode only people with a role on the app (App roles →
Roles: admins, developers, testers) can sign in with it; everyone else gets
_"This app isn't available"_. Switching it to **Live** needs, in App settings →
Basic, a **Privacy Policy URL** (the owner's text, #370) and **User data
deletion** — an instructions URL or a callback (#445: there is no self-service
account deletion yet). Until both exist, add the pilot's people as testers.

### The Graph API version

next-auth 4.24's provider still sends people to Graph **v11.0**, retired in 2023,
so `src/lib/auth/facebook.ts` pins all three endpoints to **v26.0** (introduced
2026-07-29; Meta keeps a version at least two years). Bump
`FACEBOOK_GRAPH_VERSION` there when a newer one ships —
<https://developers.facebook.com/docs/graph-api/changelog/>.

### The profile picture

Facebook's picture URL is signed and expires. It is re-read at every Facebook
sign-in, replacing only an earlier Facebook picture or none; in between, an
expired one fails to load and the initials show instead.

---

## Handing the values over

Put all four in `~/playerz-oauth.env`, `chmod 600`. **Not into a chat window** —
a transcript persists, and a secret in one is a secret that has to be rotated.

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FACEBOOK_CLIENT_ID=
FACEBOOK_CLIENT_SECRET=
```

They go into `/opt/playerz/.env` (production) and `/opt/playerz/.env.staging`,
and the app is recreated. A deployment still carrying `MICROSOFT_*` variables is
harmless — nothing reads them since #361 — but they can go. Then:

```bash
curl -s https://playerz.bg/api/ready | jq .features.signIn
# {"google":"configured","facebook":"configured","credentials":"disabled"}
```

and the two buttons appear on `/login`.

## If a callback fails

| Symptom                                                                                      | Cause                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch` (Google)                                                             | the registered URI differs by a character — trailing slash, `http`, a host that is not registered                                                                                 |
| _"URL blocked: This redirect failed because the redirect URI is not whitelisted"_ (Facebook) | strict mode: `NEXTAUTH_URL`'s host is not one of the Valid OAuth Redirect URIs, or differs by a character                                                                         |
| _"This app isn't available"_ (Facebook)                                                      | the app is in Development mode and this person has no role on it — see "Going Live"                                                                                               |
| Back at `/login` with _"Facebook не сподели имейла ви"_                                      | the person declined the `email` permission, or their Facebook account has no address. Expected; the page offers to ask again, and Google                                          |
| Back at `/login?error=<provider>` after opening `/api/auth/signin/<provider>` directly       | **Normal.** next-auth v4 does not allow GET sign-in for OAuth providers — it needs the CSRF-protected POST the button sends. Not a misconfiguration; use the recipe below instead |
| Back at `/login?error=OAuthCallback` after clicking the button                               | the code exchange failed; check the secret was copied whole (Facebook: App secret, not the App ID)                                                                                |

The callback host comes from `NEXTAUTH_URL`: `https://playerz.bg` in
production (it moved from `https://app.playerz.bg` on 2026-10-07; the old
origin's callbacks stay registered until that redirect is made permanent) and
`https://staging.playerz.bg` on staging. If either moves again, both providers'
registrations move with it.

## Proving it

`/api/ready` says whether the credentials are _present_. This says whether the
handshake is actually built:

```bash
J=$(mktemp)
CSRF=$(curl -s -c "$J" https://playerz.bg/api/auth/csrf | jq -r .csrfToken)
curl -s -b "$J" -X POST -d "csrfToken=$CSRF&json=true" \
  https://playerz.bg/api/auth/signin/google | jq -r .url
rm -f "$J"
```

A correct setup answers with the provider's authorize URL. The two fields worth
reading are `redirect_uri` — which must equal what you registered, exactly — and
`code_challenge_method=S256`.

For Facebook, ask `/api/auth/signin/facebook` the same way. The answer starts
`https://www.facebook.com/v26.0/dialog/oauth`, its `scope` includes `email`, and
its `redirect_uri` is `https://playerz.bg/api/auth/callback/facebook`. (Facebook
gets no `code_challenge`: next-auth's provider checks `state` only.) The E2E spec
`tests/e2e/facebook-sign-in.spec.ts` asserts the same from a real click.

That proves what the app **sends**, not what the provider **accepts**. For that,
open the authorize URL in a browser signed in as a person with a role on the
app, and check it **positively**: the registered URI must show the provider's
own sign-in or consent screen, and a control with a bogus `redirect_uri` (the
same URL with one path segment changed) must be refused — _"URL blocked"_ at
Facebook, `redirect_uri_mismatch` at Google. The absence of an error string is
not a pass; the control is what shows the check can fail.

`curl https://playerz.bg/api/auth/providers` is the cheaper check: a provider
with no credentials is absent from that list entirely.
