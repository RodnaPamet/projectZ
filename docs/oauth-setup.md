# Setting up the two sign-in providers

The web login page offers Google and Microsoft and **nothing else** — there is no
password form. Until both apps exist, nobody can sign in, and because no account
can be created, no club and no venue can be created either.

Current state: `curl -s https://playerz.bg/api/ready` reports
`"signIn":{"google":"disabled","microsoft":"disabled"}`. Each flips to
`configured` when its two variables are present. That endpoint is the check —
"it is off" should be an observation, not a discovery.

A provider with no credentials is **not registered at all**, deliberately. A
button that takes you to Google and fails _there_ gives a provider-side error
page nobody can act on.

---

## Google

### 1. Pick a project

<https://console.cloud.google.com/projectcreate>

A separate project from `hazel-design-419410` (which is agrent's) keeps the two
consent screens, quotas and audit trails apart. Name it `playerz` or similar.

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

| Field                         | Value                                         |
| ----------------------------- | --------------------------------------------- |
| Authorised JavaScript origins | `https://playerz.bg`                          |
| Authorised redirect URIs      | `https://playerz.bg/api/auth/callback/google` |

The redirect URI must match **exactly** — scheme, host, path, no trailing
slash. Google compares the string.

Copy the **Client ID** and **Client secret**.

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

---

## Microsoft Entra ID

### 1. Register the app

<https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade>
→ **New registration**

| Field                   | Value                                                     |
| ----------------------- | --------------------------------------------------------- |
| Name                    | playerz.bg                                                |
| Supported account types | see below                                                 |
| Redirect URI            | **Web** → `https://playerz.bg/api/auth/callback/azure-ad` |

**`azure-ad`, not `microsoft-entra-id`.** This is next-auth **v4**, whose
provider id is `azure-ad`, and the callback path is built from that id.
`microsoft-entra-id` is the Auth.js v5 name and appears in comments elsewhere in
this repo that were written against v5. A registration pointed at the v5 path
consents successfully and then fails on the way back.

### Which account types

**Do not include personal Microsoft accounts.** This app requests
`https://graph.microsoft.com/GroupMember.Read.All`, which is a work/school
directory permission — a personal account has no directory and cannot consent to
it, so that path fails after the user has already agreed to sign in.

That leaves two sensible choices:

| Choice                                  | `MICROSOFT_TENANT_ID`              | Who can sign in        |
| --------------------------------------- | ---------------------------------- | ---------------------- |
| **Single tenant** (recommended for now) | your Directory (tenant) ID, a GUID | your organisation only |
| Multitenant (any Entra directory)       | `organizations`                    | any club with Entra    |

Single tenant is the one to start with: admin consent is one click, there is no
cross-tenant consent to negotiate, and no ambiguity about which issuer signs the
token. Moving to multitenant later is two changes — the account-types setting
here, and the variable.

`.env.example` ships `common`, which also accepts personal accounts. Given the
Graph scope above, prefer `organizations` or the GUID.

### 2. Client secret

**Certificates & secrets** → **New client secret**.

Copy the **Value** column, not the Secret ID. It is shown once and is
unrecoverable afterwards; a new secret is the only remedy.

Set an expiry you will actually remember — Entra's maximum is 24 months, and an
expired secret presents as every sign-in failing at once.

### 3. API permissions

**API permissions** → **Add a permission** → **Microsoft Graph** →
**Delegated permissions** → `GroupMember.Read.All` → **Add permissions**.

Then **Grant admin consent for \<your tenant\>**. Without it, sign-in stops at
_"Need admin approval"_.

Keep the default `User.Read`.

What this scope does and does not buy: it lets the app ask Graph for a user's
group list **when Entra omits it from the token for size**. It does _not_ cause
the `groups` claim to be issued. That is the next step.

### 4. Token configuration — the groups claim

**Token configuration** → **Add groups claim** → **Security groups** → tick
**ID** and **Access**.

Without this, a user's group list is empty, no role is assigned, and the result
is indistinguishable from _"in no mapped group"_ — a silent no-op rather than an
error.

Group-to-role mappings are per-club and live in the database, never in
configuration: a group id in source would be one customer's setup baked into a
public repository.

### 5. Collect the values

**Overview** → **Application (client) ID** and **Directory (tenant) ID**.

```
MICROSOFT_CLIENT_ID=<Application (client) ID>
MICROSOFT_CLIENT_SECRET=<the secret VALUE>
MICROSOFT_TENANT_ID=<Directory (tenant) ID>   # or `organizations` if multitenant
```

---

## Handing the values over

Put all five in `~/playerz-oauth.env`, `chmod 600`. **Not into a chat window** —
a transcript persists, and a secret in one is a secret that has to be rotated.

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=
```

They are appended to `/opt/playerz/.env` and the app is recreated. Then:

```bash
curl -s https://playerz.bg/api/ready | jq .features.signIn
# {"google":"configured","microsoft":"configured","credentials":"configured"}
```

and the two buttons appear on `/login`.

## If a callback fails

| Symptom                                                                                | Cause                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch` (Google)                                                       | the registered URI differs by a character — trailing slash, `http`, apex instead of `app.`                                                                                        |
| Back at `/login?error=<provider>` after opening `/api/auth/signin/<provider>` directly | **Normal.** next-auth v4 does not allow GET sign-in for OAuth providers — it needs the CSRF-protected POST the button sends. Not a misconfiguration; use the recipe below instead |
| Back at `/login?error=azure-ad` after clicking the button                              | the exchange failed; check the secret **value** was copied, not the id                                                                                                            |
| _"Need admin approval"_                                                                | `GroupMember.Read.All` has no admin consent                                                                                                                                       |
| Signed in, but no role                                                                 | the `groups` claim is not configured, or the user is in no mapped group — check Token configuration first                                                                         |
| Personal Microsoft account rejected                                                    | expected; the Graph scope is work/school only                                                                                                                                     |

The callback host comes from `NEXTAUTH_URL` in `/opt/playerz/.env`, currently
`https://playerz.bg` (it moved from `https://app.playerz.bg` on 2026-10-07; the old origin and callback stay registered until the app.playerz.bg redirect is made permanent). If it moves again, both registrations move with it.

## Proving a provider works without a browser

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

`curl https://playerz.bg/api/auth/providers` is the cheaper check: a provider
with no credentials is absent from that list entirely.
