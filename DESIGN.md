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
- **Only sell what's sellable.** Product tools default `inStockProductsOnly=true`; every item
  carries `availability`.
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

## Session

Base `https://www.woolworths.co.nz/api/v1`. Without both of these the API answers 400:

1. Bootstrap `GET https://www.woolworths.co.nz/` with a browser User-Agent; keep all cookies
   (Akamai). Plain 200, no redirect, sets `ak_bmsc` and `akavpau_vpwww`.
2. Every call carries `x-requested-with: OnlineShopping.WebApp`, the same UA, and the jar.

Redirects are followed by hand throughout: the edge sets cookies on intermediate hops that
automatic redirect handling discards.

## Endpoints

| Endpoint                                               | Notes                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `GET /products?target=search&search=<q>`               | `size`, `page`, `sort`, `inStockProductsOnly`                              |
| `GET /products?target=browse`                          | see `dasFilter` below                                                      |
| `GET /products?target=specials&useRankedSpecials=true` | accepts a department `dasFilter`                                           |
| `GET /products/{sku}`                                  | detail; see attribute fields below                                         |
| `GET /products/departments`                            | the browse tree                                                            |
| `GET /shell`                                           | `context.fulfilment`, `context.shopper.isLoggedIn`, `context.basketTotals` |
| `GET /suburbs?query=<name>`                            | suburb autocomplete; 404 without the query param                           |
| `PUT /fulfilment/my/suburbs/{id}`                      | sets delivery context; returns the shell envelope                          |
| `GET /addresses/pickup-addresses`                      | 364 pick-up locations, not delivery suburbs                                |
| `GET /trolleys/my`                                     | cart read                                                                  |
| `POST /trolleys/my/items`                              | cart write                                                                 |
| `GET /products/my/forgotten`                           | purchase history _and_ promotional suggestions                             |
| `GET /orders/my/past`                                  | order history                                                              |

### Response quirks

- **`products.items` mixes types.** `type: "Product"` alongside ad tiles (`PromoTile`,
  `PromotionalCarousel`) with entirely different shapes. Filter on `type` before mapping.
- **`size` and `totalItems` are close but not guaranteed exact.** `size=5` returned 7 products;
  `totalItems` has once come in one under the number returned, though it matched exactly on
  "red onion" (18), "leeks" (24) and "oat milk" (37). An empty page 2 is normal when page 1 held
  everything — that is what the "past the end" coverage sentence is for, and it is not evidence
  the count is wrong. Page until a page comes back short.
- **Order history is `shoppers/my/past-orders`, not `orders/my/past`.** The latter is the base
  for order-change actions and 404s on GET. The list returns `{filterList, items, totalItems}`;
  its `filterList` reports "Past 180 Days" as the selected window and a `filter` query parameter
  is ignored, so the response is the site's default window rather than all history.
- **Pick-up stores are listed once per region, plus a catch-all.** `/addresses/pickup-addresses`
  returned 364 rows for 188 distinct stores; every store also appears under "All Pick up
  locations", and name and address never differ between an id's rows. Dedupe by id and keep the
  named regions.
- **Account endpoints answer 401 once a session is not honoured.** `trolleys/my`,
  `products/my/forgotten` and `shoppers/my/past-orders` all 401 anonymously; none returns an
  empty 200, so there is no silent-wrong-answer path. `/shell` stays 200 and reports
  `isLoggedIn: false`, which is why it is the sign-in source. A 401 is handled apart from the
  400/403 session rejection in `client.ts`: re-bootstrapping yields an anonymous session, which
  is what 401s. It invalidates the cached sign-in and surfaces the sign-in instructions.
- **`CUPAsc` sorts by the raw cup price, not a normalised one.** Cup prices are published in
  different measures ($/L, $/100g, $/1ea) and the sort compares the bare number, so a mixed result
  set comes back in no meaningful order — an unfiltered specials search interleaved $12.99 wine
  with $2.70 household items. It is only useful within a single category or aisle. `PriceAsc` and
  `PriceDesc` sort correctly. Many products carry no cup price at all.
- **Product detail is not a search item.** No `stockLevel`, `slug`, `barcode` or `type`; `images`
  is an array not an object; adds `breadcrumb`, `productStoresStockLevel` and an HTML
  `description`.
- **`dasFilter` takes slugs, repeated per level**, and a narrower level needs the wider ones:
  `dasFilter=Department;;beer-wine;false&dasFilter=Aisle;;wine;false&dasFilter=Shelf;;rose-wine;false`.
  Numeric ids return `totalItems: -1` and no products. It does **not** work with `target=search` —
  every form returns zero, so `browse_category` is the only exhaustive category path.
- **Aisles have no slug.** Departments and shelves carry `url`; an aisle's slug is its slugified
  name ("Rose Wine" → "rose-wine").
- **`suburbId` in the fulfilment context reads 0** even after a successful change. `address` and
  `fulfilmentStoreId` are what move; `suburbId` is not surfaced.
- **`/suburbs` returns display names**: "Ponsonby" resolves to "Ponsonby, Auckland WA". Treat one
  result as the answer, several as ambiguous, and report which was chosen.
- **`orderCount` is null when anonymous and a decimal string when signed in.** Never a number.
- **`allergens` is `[]` on packaged goods and `null` on fresh produce, both meaning "not stated".**
  Paneer returns no allergens while its ingredients read "Milk". Modelled as stated / notStated;
  absence is never rendered as an assurance.
- **The trolley read nests lines under groups**: `items[]` are groups each carrying `products[]`.
  Totals come from `context.basketTotals`; the top-level count is `itemCount`.
- **Purchase history and advertising arrive together.** `/products/my/forgotten` returns sections:
  "Items previously purchased" and "Our picks this week". The second is advertising and is
  returned separately, never merged.

### Cart writes

`POST /trolleys/my/items` takes a single object, not a list:
`{"sku":"245902","quantity":1.2,"pricingUnit":"Kg","adId":null}`, with an optional `searchString`.

- `sku` is a string; `quantity` is **absolute**, not a delta; `0` removes the line.
- `pricingUnit` is `Each` or `Kg`; decimals are legal for `Kg`.
- The response carries `itemAdded {sku, quantity, unit, selectedPurchasingUnit}`,
  `totalItemQuantityInBasket` and `isSuccessful`. `selectedPurchasingUnit` echoes the request;
  `unit` does not and is not surfaced.
- **Woolworths substitutes its own quantity on some products**, rounding up to a whole number of
  items at `averageWeightPerUnit`. Bananas average 0.25 kg, so 0.3 kg becomes 0.5; limes average
  0.1 kg, so 0.3 kg passes unchanged. Writes report `requestedQuantity` and `appliedQuantity`
  separately and name the difference.

### Attributes for choosing

`GET /products/{sku}` carries `ingredients`, `allergens`, `allergenMaybePresent`, `nutrition`,
`healthStarRating`, `origins`, `claims`, `endorsements`, `warnings`, `contents`, `directions`,
`averageWeightPerUnit`, `supportsBothEachAndKgPricing` and `selectedPurchasingUnit`. `claims`
includes attributes such as "Intensity: 3" on olive oil and "Cage free eggs" on eggs.
`get_product_label` returns the packaging photo as an image block for the cases where a label is
the only source.

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
GET  www/api/v1/bff/get-user   confirms
```

Plain authorization-code flow, no PKCE; the BFF hands over the whole authorize URL. Auth0's ULP is
two-step — identifier, then password.

**The server does not perform this.** Auth0 serves a Cloudflare Turnstile challenge to
non-browser clients, and the form carries a `captcha` field a real browser is not asked to fill.
`npm run login` opens a real browser, the person signs in, and the captured cookies are POSTed to
`<mcp-path>/session`. The server persists them and reloads at boot; an unreadable stored session
is fatal rather than ignored.

`npm run check:login` verifies the unauthenticated half continuously, using no credentials.

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
Location: `get_location`, `set_location`.
Account: `sign_in`, `auth_status`, `get_cart`, `set_cart_quantity`, `set_cart_quantities`,
`remove_from_cart`, `get_past_purchases`, `get_order_history`.

`npm run smoke` covers the catalogue, `npm run smoke:account` the signed-in cart sequence,
`npm run check:stdio` / `check:http` the protocol layer, `check:login` the sign-in chain,
`check:adjustment` the quantity-substitution wording.
