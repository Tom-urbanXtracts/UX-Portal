# Retired Canix Shop service access request

Historical planning artifact only. The owner decided on 10/15/2026 not to pursue Canix Support. The unsent Gmail draft was moved to Trash and no message was sent. The current interim method is a controlled supervised Shop refresh; unattended refresh remains outside the release plan.

We are connecting the urbanXtracts Canix Shop to our UX OS Portal. Canix remains the inventory and compliance source; this connection must only read approved Shop listings and must not create orders or change inventory.

Shop: `https://app.canix.com/marketplace/urbanXtracts`
Distribution facility ID: `4467`
Distribution license: `OCM-DIST-24-000069`

The Shop displays 120 products in the browser. Our existing ordinary API key has not established product-list access through the Shop endpoint. An unauthenticated identity query returns a Shop object but no product count. We do not want to use a copied browser session token or account password for scheduled integration.

Please confirm:

1. Is there a supported server-to-server, read-only authentication method for the urbanXtracts Shop? Does the standard `X-API-KEY` credential support `https://api.canix.com/shop/graphql`, including `MarketplaceShopIdentity` and `ShopListItemsQuery`? If not, which supported endpoint or scheduled export should we use?
2. Can access be limited to this Shop/facility and listing reads? We need stable Product and Brand IDs, product names, categories, wholesale prices, product-image references and sale-unit information. We do not need inventory, order, customer or accounting writes.
3. How should the credential be issued, stored, renewed, rotated and revoked? Does it expire or depend on an employee's browser session?
4. What pagination, rate limits and recommended refresh cadence apply? Can physical inventory be refreshed within five minutes without exceeding those limits?
5. How should minimum order quantity, sale unit and case quantity be interpreted? We need to avoid treating an imported minimum as a case size or assuming that a displayed unit price is a case price.

Please provide documentation and secure credential-delivery instructions rather than sending a secret in a shared email thread. We will install the approved credential in the isolated staging secret manager, test read-only scope and refresh, and leave production unchanged until acceptance is complete.
