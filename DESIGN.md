# Woolies MCP — Design

MCP server giving an MCP client the Woolworths NZ catalogue and cart. No ordering: no tool reaches
checkout, payment or delivery slots, and the order-placing endpoints (`orders/my/active/place`,
`payments/*`, `wpay/*`) are deliberately unbound.

Unofficial and unaffiliated: not endorsed by or connected to Woolworths New Zealand or Woolworths
Group, whose trademarks are their own. It automates one person's own account for their own
household shopping, at a shopper's volume — a single shared session, ~1 req/s, no bulk crawling,
no redistribution of catalogue or price data, no telemetry. It drives the site's internal API,
which carries no compatibility promise. Users are responsible for complying with Woolworths' Terms
of Service. See the README for the full statement.

## Principles

- **Fail loud.** Required data is required in the schemas. A response that does not parse throws,
  naming the endpoint, the field path, the keys that arrived, and tracing the whole payload to the
  log. `nullish` appears only where the site has been observed to send null and that null means
  something definite, documented at each site. Nothing coerces missing data into an empty or zero.
- **Partial results are labelled.** Every list tool reports what it returned, what matched,
  and whether more exists, with a coverage sentence instructing the caller not to answer
  cheapest/only/none from a partial set.
- **Availability is reported, not filtered.** No stock filter is sent to GraphQL: every item
  carries `availability`, and a product the store does not range carries `rangedAtStore: false`
  with no price rather than a price of zero.
- **One shopper.** A single upstream session shared by all callers, ~1 req/s, retry with backoff,
  re-bootstrap on 400/403.
- **No preferences in the server.** It supplies facts (brand, size, unit price, claims,
  ingredients); the caller chooses.

## Architecture

Functional core, imperative shell.

- Pure: `schemas.ts` (parse), `mappers.ts` (raw JSON to the shapes a client sees). No IO, no
  clock, no mutation of anything they did not create.
- Shell: `session.ts`, `client.ts`, `http.ts`, `index.ts`, `session-store.ts`, `scripts/`.
- `api.ts` straddles: it calls the shell and delegates every shape decision to the core.

Parsing and mapping stay pure, so upstream shapes are exercised without a network. ESLint enforces
this: the core is linted for immutability and `no-let`, and every declared type is readonly.

## One API

The site is migrating from an AngularJS SPA on `/api/v1` to Next.js pages on `/api/graphql`. This
server has followed it: **every call it makes is GraphQL**. Nothing here touches `/api/v1`.

The cart moved first and forced the issue — the two APIs no longer share a session, so a write to
the REST trolley landed somewhere the new frontend could not see. The rest followed because the
same split applies everywhere: `/shell` reports the legacy session, which the migration leaves
permanently anonymous, and it was observed naming a different serving store from the one the cart
was actually served by. Reading prices for the wrong store is silent and wrong.

**Signed out is not a supported mode.** `My.products`, `My.categories` and
`products(keys:, storeKey:)` do answer a guest — the site issues a `__guest__token` on the first
request — but whatever store a guest is served is the store those prices are for, which is not
the shopper's. Answering "is this sold in New Zealand" from a store nobody shops at is not the
job. Anonymous operation was how the build was split, not a capability: no tool advertises it, and
the catalogue gate runs signed in and asserts the store it asked.

An expired session is worse than none: a clean guest is answered, while the expired cookies this
server holds are refused, so when the session dies every tool stops. The answer is the same
either way — log in again.

`api.ts` is still the boundary: tools deal in domain shapes and never see a document.

## Operations

`POST /api/graphql?op-name=<Operation>`, content-type `application/json`, body
`{operationName, variables, query}`. The browser also sends `wnzx-operation-name`, mirrored here.

| What | Operation | Selector |
| ---- | --------- | -------- |
| search | `My.products` | `byKeyword` |
| browse | `My.products` | `byCategoryKey` (a **key**, not a slug) |
| specials | `My.products` | `byProductPromotionSpecials` + `staticFilters` |
| "Buy it again" | `My.products` | `byBuyAgain`, `sortBy: FREQUENCY` |
| an order's contents | `My.products` | `byPastShop` + `skus` |
| categories | `My.categories` | one node, with `children` |
| product detail | `products` | `keys` + `storeKey` |
| pick-up locations | `locations` | `geolocation` — a name alone returns nothing |
| cart read | `customerCart` | selected with `me` |
| cart write | `setCartLineItemQuantity` | `cartLineItemQuantityUpdates` |
| move the cart | `setCartShoppingMode` | a saved `deliveryAddressId` |
| delivery windows | `propositions` | coordinates or `locationId` — read only |
| orders | `orders` | `inclusiveFilter: PAST` / `ACTIVE` |
| saved addresses | `me.addresses` | — |

**`op-name` is not an identity.** Six different operations arrive under the name `ProductSearch`;
the input selector is what distinguishes them. Reading the name as the operation is how the
order-contents query was missed entirely on a first pass through the captures.

### Response quirks

- **`results` mixes types.** `ProductSummary` alongside advertising (`SponsoredProduct`,
  `GamResultItem`, `ContentInGridResultItem`) and `RedirectResultItem`, all with different shapes.
  One page returned 36 products and 2 tiles. Only the product member is selected; the rest are
  counted and reported as `advertisingExcluded`, never merged in.
- **`pageSize` echoes what came back, not what was asked for.** A request for 20 orders that
  returned 7 reported `pageSize: 7`. It never describes the page and is not used.
- **`currentPage` reads -1 on an empty result.** A sentinel, not a page number. The requested page
  is carried through instead.
- **`totalCount` is the site's own count and has been observed off by one**, so a completeness
  claim is only made from a coherent count. Page until a page comes back short.
- **A category is a key, not a slug.** `byCategoryKey` takes `9-BDB6545B`; `displaySlug`
  (`fruit-veg`) is what the website shows. `My.categories` returns one node with `children`, not a
  list, and the whole tree is four levels and 773 nodes — about 150 KB, more than a tool result
  can carry — so `list_categories` bounds it by depth and a node whose children were cut reports
  how many it has rather than appearing childless.
- **Pricing units are spelled `EACH` and `KG`.** That is what `purchasingUnit` reports, so it is
  what the cart tools accept: the REST-era `Each`/`Kg` meant the documented "pass it through
  verbatim" workflow failed validation on every product.
- **Product attributes live on the concrete variant type, and the types differ.** The union has
  five members and they do not share a field set. Established by sending the full selection at
  each and removing what the router named: `GroceryVariant` and `RegulatedVariant` (liquor) carry
  `ingredients`, `allergenContained`, `servingSize`, `servingsPerPack` and
  `nutritionalInformation`; `GeneralMerchandiseVariant` carries `allergenContained` and `barcode`
  but no ingredients or nutrition; `NonMerchandiseVariant` carries `barcode` only;
  `MonetaryVariant` carries neither. `ageRestriction` is a number (18 on wine), not a string.
  Selecting `GroceryVariant` alone left every liquor product undescribable.
- **`nutritionalInformation` is a list, one entry per basis** — "Per 100g" and "Per Serve".
  Flattening it would mix the two silently.
- **`allergenContained` is null on most products, meaning "not stated".** Never "contains none":
  the distinction is modelled as stated / notStated and absence is never rendered as an assurance.
- **`averageWeightPerUnit` does not exist here.** The quantity a weight-priced product is sold in
  is `purchasingUnits.incrementQty` — bananas 0.25 kg, limes 0.1 kg — which is why 0.3 kg of
  bananas becomes 0.5 and 0.3 kg of limes passes unchanged. The site's own rule, not an inference
  from an average.
- **`locations` searched by name alone returned nothing.** The call that worked carried
  `geolocation`; a name filters what proximity already found. No result of it is ever complete,
  so `find_stores` reports `complete: false` always.
- **`propositions` answers with both fulfilment methods.** A delivery address came back with 306
  windows, 288 of them pick-up at a nearby store; the result is narrowed by method and capped,
  and the coverage sentence states what each filter removed.
- **Delivery fees are banded, not an amount.** `fees[].amountInCents` was null on all 415 windows;
  `rateCard` holds the thresholds ($14.00 under $200, $9.00 above). A null there means "see the
  bands", never "free".
- **`orders` results do not carry line items by default.** The site's own document never selects
  them, so no capture shows them; `Order.lineItems { productKey quantity product { name } }` does
  exist, and `productKey` is the sku.
- **The "Buy it again" list is not the purchase history.** `byBuyAgain` is the retailer's own
  frequency-ordered selection, so reaching its last page proves the list is exhausted and nothing
  more. Its coverage refuses the completeness claim explicitly.

### Session and guards

- **The sign-in cookies are not enough.** The Next.js pages exchange them for `__session__0` and
  `__session__1`, and `/api/graphql` authenticates on those. Loading any Next.js page mints them;
  the server uses `/cart`. They are short-lived, roll on every response, and are re-minted both
  when the jar has none and when the site answers HTTP 401 `session_expired` — minting only on
  absence left the server dead until a restart. A second `session_expired` after re-minting means
  the sign-in itself is gone, and is raised as the `npm run login` handover rather than a
  transport error.
- **A guest is served, not refused.** `customerCart` answers HTTP 200 with an empty
  *guest* cart under a different key, sets `__guest__token`, and reports no error. Verified live:
  the same stored session read the shopper's cart before the `/cart` exchange only as a guest, and
  the real cart with 1 line and a $17.50 total after it. This is the silent-wrong-answer path the
  whole design guards, because "your cart is empty" is a plausible answer.
- **`me` is the guard.** Every read selects `me { id }` alongside `customerCart`. It is banned for
  guests and comes back as
  `{"code":"BANNED_OPERATION","message":"Field 'me' is not allowed for guest users."}`, raised as
  the same `npm run login` handover the REST 401 path produces. A mutation cannot select `me` — it
  is a Query field — so writes are guarded by the cart key instead: the key a write returns must
  match the key from a read that proved `me`, within the same one-minute window `requireSignedIn`
  uses. A mismatch fails loudly and is never reported as a write.
- **Failure arrives as HTTP 200 with an `errors` array.** Status codes classify nothing here.
  `graphql-request` is used precisely because it throws on an `errors` array by default, so the
  conversion is the client's behaviour rather than a convention each call site has to remember —
  the one hand-rolled reader this repo had was where the check got dropped. Everything that talks
  to `/api/graphql` goes through that client: the server over the shared cookie jar,
  `npm run login` over the browser's own request context, and the offline checks over a canned
  `fetch`, so all three classify identically. An error naming a guest-banned field is re-raised as
  the `npm run login` handover; everything else as a `GraphQlError` carrying the site's codes.
- **The documents are typed, but not generated.** The site answers introspection with
  `INTROSPECTION_DISABLED`, so there is no schema to generate against. Each document is a
  `TypedDocumentNode` whose result type is the zod schema's inferred type: the parse is what holds
  at runtime, and the type says what the parse expects. A hand-written SDL would only re-state the
  same observations while claiming the authority of a real schema.
- **Writes address a `variantKey`, not a sku.** `SetCartLineItemQuantity` takes
  `{input: {cartLineItemQuantityUpdates: [{variantKey, quantity}]}}`. The key is `<sku>-EA` or
  `<sku>-KG`; all 171 variants across the six captured `ProductSearch` responses use that
  encoding, and `productVariantSku` on every cart line does too. Quantity is absolute and 0
  removes the line, as on REST.
- **A product sold both ways has one line per pricing.** Setting a quantity in one unit therefore
  zeroes the other in the same mutation, which is what the site's own frontend does. Without it,
  "2 Each" of something the cart holds by weight adds a second line rather than changing the one
  that is there.
- **The list is the batch.** `set_cart_quantities` sends every line as one mutation. The site
  applies or rejects the whole list, so a rejection is reported against every requested sku,
  worded as a rejection of the batch rather than a fact about each product — one unknown sku
  otherwise reports every other item as "no longer available at this store". Only a rejection is
  reported that way: an error after the mutation (dead session, wrong cart key, unreadable
  response) is raised, because the write may already have landed and "nothing was changed" would
  invite the caller to send it again.
- **An unknown variant key is ignored at quantity 0 and rejected above it.** Writing
  `{33021-EA: 1, 33021-KG: 0}` succeeds for an Each-only product while
  `{33021-EA: 0, 33021-KG: 1}` is refused with `ProductStoreRangingAvailability`. So zeroing the
  other pricing is safe, but a key built from a sku is not "either right or loud" in general.
- **The site ignores `pageIndex` on `orders`.** Pages 2 and 3 of a seven-order history return the
  same seven orders, so no page argument is offered and no page is claimed.
- **`SPECIALS` is a promotion type, not every special.** Asking for it alone reported 5132 against
  the 6644 the full six-filter set reports, so the default sends every type.
- **Money is in cents** (`beforeDiscountAsCents`, `amountToPayAsCents`), not REST's formatted
  strings. A fee the site has not determined — no delivery window chosen — is absent from `fees`
  entirely, and stays absent rather than becoming $0.00. A discount the site states as 0 is
  rendered $0.00, because on this API the site can state either.
- **`totalItemQuantity` is the site's item count, not a sum of quantities.** A 0.2 kg line counts
  as 1. `totalUniqueProductSku` counts distinct variants.
- **A line's name comes from its own variant.** `LineItem.product` carries no product name: the
  name is on the variant whose `key` matches `productVariantSku` ("Woolworths Fresh Limes Min
  Order 100g"). A line naming a variant its product does not list is refused rather than renamed.
- **The cart says why it cannot be checked out.** `validationResult.failedValidations` carries the
  site's own wording — `ValidateMinimumDeliveryValue` / "Delivery has a $50 minimum spend",
  `ValidateHasFulfilmentProposition` / "Please select a time slot to continue" — surfaced as
  `checkoutBlocked` and `blockers`. `resolution` and `title` are each null on one of those two.
- **The GraphQL cart does not carry pack size or availability.** Neither is in `LineItem`; the
  variant name is the closest thing to a size. `search_products` and `get_product` remain the
  source for both.
- **Where the session is shopping comes from the cart, not `/shell`.** `customerCart.shoppingMode`
  carries the delivery address, suburb and pick-up location, and `fulfilment.fulfilmentProposition`
  the serving store once a window is chosen. `/shell` describes the legacy session, which the
  migration leaves anonymous: it was observed reporting store 9171 (Glenfield) while the cart was
  served from 9583. Every price answer is location-dependent, so the wrong location misprices
  everything silently. Before a window is chosen there is no serving store, and `get_location`
  names it in `notReported` rather than reporting one.
- **`auth_status` and the start-up log report demonstrated access**, not `/shell`'s claim. The
  shell now reports signed out while every account tool works, so believing it announced an
  expired session on every boot.

- **Delivery windows are read, never chosen.** `propositions` lists them for a set of coordinates
  or a pick-up location; 415 came back for one address, 306 available. `fees[].amountInCents` was
  null on every one — the fee is banded by order value in `rateCard` ($14.00 under $200, $9.00
  above), so there is no single amount to report and `get_delivery_windows` gives the bands.
  `tags` carries capability flags and, on a closed window, `unavailableReason:*`, repeated; the
  repeats are collapsed. The window's own id is not selected: it is the token a booking would use.

Unbound deliberately: `setCartFulfilment` (choosing a delivery slot) and everything downstream of
it. `setCartShoppingMode` moves the cart between the account's saved addresses without booking
anything, and is also unbound — nothing needs it.

### Attributes for choosing

`products(keys:, storeKey:)` carries, on the concrete variant type: `ingredients`,
`allergenContained`, `nutritionalInformation` (a list, one panel per basis), `servingSize`,
`servingsPerPack`, `directionsOfUse`, `tgaWarnings`, `productWarnings`, `ageRestriction`,
`countryOfOrigin`, `barcode`, `volumeSize`, `richDescription` (HTML) and `assets`.
`purchasingUnits` gives the unit, minimum and the step the product is sold in, which is what
explains a substituted quantity.

`get_product_label` returns the product's own image URLs. Whether any of them shows the ingredients
panel is not stated by the site, and the tool says so rather than implying a label is available.

## Sign-in

Login is **Keycloak OIDC with Auth0 Universal Login as the credential UI**. Gigya survives only as
a federated broker behind Keycloak; its published API key resolves to a deleted Gigya site, so
`accounts.login` cannot work.

```
GET  www/api/v1.0/bff/initiate-oidc-signin?redirectUrl=<base64>
  -> iam/realms/wwnz-customers/protocol/openid-connect/auth
       ?response_type=code&client_id=trader-prod-20230731&scope=openid&kc_idp_hint=gigya
  -> auth.woolworths.co.nz/u/login/identifier?state=<S>   (HTML form)
POST auth/u/login/identifier   {state, username}
POST auth/u/login/password     {state, username, password}
  -> authorize/resume -> iam broker -> bff/login-callback
POST www/api/graphql  { me { id } }  confirms
```

Plain authorization-code flow, no PKCE; the BFF hands over the whole authorize URL. Auth0's ULP is
two-step — identifier, then password.

**The server does not perform this.** Auth0 serves a Cloudflare Turnstile challenge to
non-browser clients, and the form carries a `captcha` field a real browser is not asked to fill.
`npm run login` opens a real browser, the person signs in, and the captured cookies are POSTed to
`<mcp-path>/session`. The server persists them and reloads at boot; an unreadable stored session
is fatal rather than ignored.

`npm run login` captures every `woolworths.co.nz` cookie the browser holds and then verifies the
capture by making the call the tools make — a cart read that proves `me`. A capture that does not
work is reported as such rather than saved silently.

The sign-in check itself moved: `bff/get-user` lost the shopper's email, user id and first name in
the migration and has been observed still reporting `isLoggedIn: false` after a completed sign-in,
so the login script polls GraphQL `me` as well and prints what each signal said. Only a plainly
stated answer counts as "not yet"; anything it cannot read throws.

The shop session cookie `cw-lrkswrdjp` is dated 7 days ahead. That date is the site's claim about
the cookie, an upper bound rather than a guarantee — a sign-out elsewhere, a password change or a
security event ends the session earlier and the cookie keeps its original date. Only a live call
proves a session, so the cookie date is reported as `cookieExpiresAt` only while account access
has been demonstrated.

**`/shell` is not a sufficient sign-in check.** `context.shopper.isLoggedIn` has been observed
reading true while `trolleys/my` returned 401 on the same server at the same moment: the shop
session satisfies the storefront while API authorisation is already gone. Edge caching is not the
cause — `/shell` and `trolleys/my` both answer `cache-control: no-cache` — but the mechanism is
otherwise unconfirmed, most likely separate validations over the shop session cookie and the
API's own authorisation. `auth_status` therefore makes a real account call and reports what it
demonstrated, keeping the shell's claim beside it as `shellReportsSignedIn` so a half-dead session
is visible. `requireSignedIn` still reads `/shell` as a cheap pre-check, with the 401 guard as the
authority.

## Stack and deployment

TypeScript, `@modelcontextprotocol/sdk`. Two entry points: stdio for local use, stateless
Streamable HTTP for the NAS. Strict compiler settings cover `src` and `scripts`; no shell scripts.

Docker on the Synology NAS, public HTTPS via Tailscale Funnel at
the tailnet hostname in `PUBLIC_BASE_URL`, MCP served only at `/mcp/<MCP_PATH_TOKEN>` — everything else
404s with an empty body, so whole-port Funnel needs no path juggling.

`npm run deploy` ships HEAD over SSH as a tarball (DSM disables SFTP, and the host then needs no
git credentials),
builds there, restarts, waits for health. It refuses a dirty tree.

Recreating the deployment needs this repo plus `.env` (git-ignored; keep copies in a password
manager). The only
persistent state is the signed-in session under `/data`, and losing it costs one `npm run login`.

The MCP layer is stateless per request; the Woolworths session is not, so the throttle stays
global and the deployment remains one shopper.

**Known environment quirk:** `.ts.net` does not resolve through the local router's DNS on the dev
Mac, though public resolvers answer it. Verification from the Mac pins the address or uses the LAN
port.

**SDK types predate `exactOptionalPropertyTypes`** — `sessionIdGenerator` is typed `() => string`
while `undefined` is the documented stateless setting, and `Transport.onclose` is typed
non-optional. Both are cast in one place in `src/http.ts`.

## Tools

Catalogue: `search_products`, `search_products_batch`, `get_product`, `get_product_label`,
`list_categories`, `browse_category`, `get_specials`, `find_stores`.
Location: `get_location`, `set_location`, `get_delivery_windows`.
Account: `sign_in`, `auth_status`, `get_cart`, `set_cart_quantity`, `set_cart_quantities`,
`remove_from_cart`, `get_buy_it_again`, `get_order_history`.

`npm run smoke` covers the catalogue — signed in, because there is no anonymous mode left —
`npm run smoke:account` the cart, location, windows, history and orders sequence,
`npm run check:stdio` / `check:http` the protocol layer, `check:login` the sign-in chain,
`check:adjustment` the quantity-substitution wording, `check:graphql-cart` the GraphQL cart
contract against the captured payloads — the guest cart, the errors array, the cart-key guard and
the money — and `check:session-death` a session dying mid-use. Everything in `npm run check` runs
offline; the checks that exercise an anonymous session drive scripted transports from
`scripts/cart-fixtures.ts` rather than the real site, so a canned `fetch` still goes through the
same `graphql-request` client the server uses.
