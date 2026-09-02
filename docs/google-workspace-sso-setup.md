# Google Workspace SSO setup

This portal uses Supabase Auth as the broker and Google Workspace as the workforce identity provider. Authentication and portal authorization remain separate. The deployed provisioning trigger creates an active internal Viewer profile for a first-time `@urbanxtracts.com` user; access above Viewer still requires an administrator role assignment.

## Google Cloud

1. Use an urbanXtracts-owned Google Cloud project.
2. Configure the Google Auth Platform audience as internal to the urbanXtracts Workspace organization when that option is available.
3. Create an OAuth client for a Web application.
4. Add this authorized redirect URI exactly:

   `https://cbhsavfbtcpdyxcvguay.supabase.co/auth/v1/callback`

5. Record the generated client ID and client secret in the approved password or secrets manager. Do not put either value in this repository or the portal HTML.

## Supabase Auth

1. Open Authentication → Sign In / Providers → Google.
2. Enter the Google client ID and secret, then enable the provider.
3. Keep email/password enabled as the recovery and external-user sign-in path.
4. Add the current portal URL to the redirect allow-list:

   `https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site/`

5. Keep `https://portal.urbanxtracts.com/` in the redirect allow-list and use it as the Site URL. Keep the old URL during the cutover verification window.

## Portal authorization

1. Apply `supabase/migrations/20260901090000_portal_staff_access.sql`, the later access migrations, and `supabase/migrations/20260901260000_deterministic_sso_provisioning.sql` in timestamp order. Existing internal profiles are initialized as `viewer`; assign the first `administrator` explicitly during the controlled deployment.
2. First-time `@urbanxtracts.com` users are provisioned automatically as active internal Viewers. An administrator may then assign one staff preset:
   - `administrator`
   - `operations`
   - `sales`
   - `quality`
   - `viewer`
3. Deploy the updated `canix-inventory` Edge Function after the migration.
4. Set the hosting environment values:
   - `UX_SSO_PROVIDER=google`
   - `UX_SSO_DOMAIN=urbanxtracts.com`

## Acceptance checks

- An active internal urbanXtracts user reaches only the routes granted by their staff preset.
- A first-time urbanXtracts Google account receives an active internal Viewer profile and only Viewer permissions.
- A non-urbanXtracts Google account is refused.
- A deactivated profile is refused even when Google authentication succeeds.
- `inventory.read` is required for inventory responses.
- `inventory.sync` is required for a manual Canix sync; the scheduled sync continues to use its server-side secret.
- Signing out revokes the Supabase session and returns to the regular sign-in screen.

## Current live status — 2 September 2026

- Email/password is enabled and remains the working recovery and retailer sign-in path.
- A dedicated **UX Portal Supabase** Google Web OAuth client is enabled in the urbanXtracts-owned Google Cloud project. Its audience is internal to the urbanXtracts Workspace organization and its only authorized callback is the Supabase Auth callback above.
- Supabase reports both email and Google providers enabled. The production root, the prior Sites paths, and the two exact `127.0.0.1:4173` development paths are in the Auth redirect allow-list; `https://portal.urbanxtracts.com/` is the Site URL.
- The complete Google consent flow was tested with Tom's `@urbanxtracts.com` Workspace account. It returned to the local portal and preserved Tom's existing Administrator preset. The database trigger continues to provision only first-time workforce users as Viewers.
- The OAuth client secret was transferred directly into Supabase, was not written to this repository, and the one-time Google secret dialog was closed after configuration.
- The Sites release supplies `UX_SSO_PROVIDER=google` and `UX_SSO_DOMAIN=urbanxtracts.com`; the deployed response contains that exact non-secret configuration. The outer Sites/ChatGPT viewer gate is removed so visitors reach the portal's own sign-in screen, while protected data still requires a valid Supabase session and server-authorized role.
