# UX Portal document scanner

This private HTTP wrapper runs the open-source ClamAV engine for onboarding
documents, product images, and portal-managed COAs. It never exposes ClamAV's
unauthenticated TCP socket. Callers must send a server-only bearer secret and
may bind the request to an expected SHA-256 digest.

The intended production target is an authenticated Google Cloud Run service
with at least 2 GiB memory. The software is free; Cloud Run usage may still
incur hosting charges outside Google's free allowance. Signature definitions
are baked into each immutable image with `freshclam`, so the image must be
rebuilt regularly. The portal remains fail-closed if the service or its
signatures are unavailable.

Required environment value: `SCANNER_SHARED_SECRET` (32 or more characters).
Only `POST /scan` accepts content; `GET /health` returns readiness without
revealing signatures, filenames, or customer data.
