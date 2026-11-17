# Capgo invoice documents

The billing page generates its own PDF when a customer selects **PDF**. The
layout matches the existing Stripe invoice: US Letter paper, Inter typography,
Capgo logo, compact address blocks, line-item tax column, totals and footer.
The earlier [worker-invoices](https://github.com/Cap-go/worker-invoices/blob/main/src/pdf.ts)
project informed the implementation; the final renderer uses the issued Stripe
PDF as its visual reference and loads locally on demand.
No customer data is sent to a PDF service.

Stripe still owns subscriptions, taxes, payments, and finalized invoice records.
The document uses the finalized Stripe invoice number verbatim, including its
prefix and zero padding. Stripe continues advancing the existing EE or US
sequence. There is no new numbering scheme, counter reset, or duplicate invoice
issuance. Disabling Stripe's subscription invoice creation is not part of this
change: [subscriptions automatically generate invoices](https://docs.stripe.com/invoicing).

The authenticated `private/stripe_billing/invoice-document` endpoint requires
`org.read_invoices`, resolves the customer and Stripe account server-side, then
checks that the requested invoice belongs to that customer. It returns only the
document fields, with `Cache-Control: private, no-store`. It does not return
Stripe payment URLs or private metadata. Drafts cannot be downloaded. Line items
are paginated, with a 1,000-line bound that fails explicitly instead of producing
a partial invoice.

By default, customer identity, address, tax IDs, descriptions, periods, discounts,
credits, taxes, totals, and payment status come from the invoice record. Seller
contact and address come from the issuing Stripe account; seller tax IDs are those
referenced by the invoice. Changing a billing profile leaves the issued invoice
record intact. Customers can explicitly regenerate its PDF using the current saved billing name and
address; see below. Updating the seller's account address can
change its address on a regenerated PDF, so retain previously issued documents
when changing legal details. Existing account routing and invoice-history scope
are unchanged; this does not merge historical invoices between Stripe entities.

The renderer embeds Inter 4.1 (SIL Open Font License; see `public/invoice/INTER-LICENSE.txt`) and supports its Latin, Greek, and Cyrillic glyphs.
Additional script fonts are not bundled. The PDF rendering regression covers
accented names, long descriptions, and automatic multi-page layout.

## Correcting an older invoice address

1. Open Billing, edit the billing details, and save the corrected name and address.
2. **Use current billing name and address** is selected after a successful save.
   It can also be selected later in the Invoices section.
3. Select **Regenerate PDF** on the invoice. Clear the checkbox to download a PDF
   with the originally issued details instead.

The API accepts `billingDetails: 'issued' | 'current'` (default `issued`). Current
mode requires both `org.read_invoices` and `org.read_billing`. It checks invoice
ownership, then reads the authorized customer's saved name and address directly
from the server-selected Stripe account. It never accepts replacement addresses
or customer IDs from the download request. A deleted customer or incomplete
current address fails explicitly instead of silently downloading an old address.

Only the printed customer name and address change. The original invoice number,
dates, billing email, tax IDs, tax treatment, line items, payments and totals stay
as issued. This creates a corrected PDF, without issuing a second invoice or
changing Stripe's finalized record. Tax corrections are a separate billing task.

## Comparison

Both examples use fictional customer details, invoice number, and amounts.
The before image preserves the Stripe layout with identifying content replaced;
it is published as a newly rasterized PDF to remove source metadata, hidden text,
links, and attachments. No original customer PDF is committed. The after PDF is
produced by the same renderer as the billing download.

| Before: Stripe | After: Capgo |
| --- | --- |
| ![Stripe invoice with fictional data](pr-screenshots/owned-invoices/before.png) | ![Capgo invoice with fictional data](pr-screenshots/owned-invoices/after.png) |

[Before PDF](pr-screenshots/owned-invoices/before.pdf) ·
[After PDF](pr-screenshots/owned-invoices/after.pdf)

Regenerate the after PDF with `bun scripts/generate-invoice-example.ts`.

## Legacy billing domain

`pay.capgo.app` was the Estonian Stripe custom domain for checkout, payment links,
and the customer portal. On November 16, 2026 it was removed from that Stripe
account, and Cloudflare was configured as follows:

- Single Redirect: `Legacy Stripe billing to Capgo`.
- Match: `(http.host eq "pay.capgo.app")`.
- Static 301 destination: `https://console.capgo.app/settings/organization/billing`.
- Do not preserve the path or query string: old Stripe session tokens are not
  Capgo credentials and must not be forwarded.
- DNS: `pay` is a proxied A record targeting `192.0.2.1`; the redirect terminates
  the request at Cloudflare without an origin connection.

Mail-related DNS records were left intact. This is a live configuration change,
independent of merging this PR. A request to an old `/p/` path was checked and
returned the exact 301 destination above. Old links cannot identify the Capgo
organization from opaque Stripe tokens: users authenticate and use the console's
organization selector. New PDF payment links include the authorized org ID.

## Rollout

Merge and deploy the API and frontend together. Verify a billing-admin download
and an unauthorized request in the deployed environment. This PR does not
change invoice email delivery settings or send emails. Review any Stripe invoice
email shutdown separately after the replacement is deployed, so customers do
not lose their existing invoice delivery before the new download is available.
