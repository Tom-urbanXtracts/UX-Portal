# Public store kiosk links

The public kiosk is a store-specific, login-free product-education view for a retailer counter tablet or QR code. It is a capability link, not a portal account and not an authorization shortcut.

## What it shows

- Published product identity and education from the approved Monday/Canix content record.
- Published product profile, ingredients, use information, and selling points.
- Sanitized structured COA status, test date, cannabinoids, terpenes, and profile values when present.
- The store and retailer organization named on the kiosk link.

It never returns prices, inventory quantities, package tags, lot selection, orders, payments, account data, economic ownership, administration, or direct COA source URLs.

## Issuing and revoking a link

An internal user with `users.manage` and an AAL2 session opens **Users and access → Public kiosk links**, chooses an active qualified store, labels the device or placement, and creates the link. The full link is shown once. Only its SHA-256 fingerprint and first eight display characters are stored.

Each store may have multiple labeled links so a lost tablet or printed QR code can be revoked without affecting other devices. Revocation is immediate and audited. Deactivating or disqualifying the store also prevents resolution.

Because anyone holding the URL can open it, operators should treat it like a public QR code: do not paste it into tickets or shared logs, label each physical placement clearly, and revoke it when a device is lost, replaced, or retired.

## Newly onboarded stores and users

Completing onboarding creates the qualified portal store before user access is finalized. Store Owners receive all active stores in their retailer organization, Buyers receive only assigned stores, and Budtenders receive exactly one. The kiosk is separate from those user assignments: it can be created only after the store is qualified, and it provides public product education without becoming a user record.
