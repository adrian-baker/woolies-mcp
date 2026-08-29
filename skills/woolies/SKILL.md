---
name: woolies
description: Adds groceries to the Woolworths New Zealand cart through the woolies MCP server — a whole shopping list or a single item. Use for "do the shopping", "add this week's list", "put these in my grocery cart", "order groceries", "top up the staples", or any pasted list of food and household items. Chooses products and fills the trolley; never places an order or pays.
---

# Woolies

Turn a shopping request into a filled Woolworths trolley. You choose products; the person reviews
and orders on the website.

## Before anything else

1. `get_location`. Prices and stock are per delivery location, and the session is shared, so it may
   be set to somewhere else. Report the location you are shopping from; change it only if asked, or
   if the person named a different one.
2. Read the person's standing grocery preferences if they keep them somewhere. They are the few
   rules that hold regardless of the dish. Ask once if you do not know where they are.
3. Get the list — the document they named, or what they pasted.
4. If the list came from a document that also holds a menu or dishes, read those: they supply
   purpose (below). Do not go hunting for a menu that was not offered.
## Choosing products

Search per item, then pick. `search_products_batch` does several searches in one call, which is
worth using for a list of any length — the upstream throttle makes sequential searches slow.

Rules, in order of precedence:

1. **Standing preferences win.** They are few and absolute.
2. **Purpose decides the rest.** Cream fat, olive oil intensity, potato variety and cut of meat
   follow the dish, not habit. When the choice turns on an attribute, `get_product` returns
   `ingredients`, `claims` (e.g. "Intensity: 3" on olive oil), `nutrition` and `origins`.
3. **When purpose is unknown, pick and say so.** "Chose Vivaldi; if these are for roasting, Agria
   is better." Never make a silent judgement call on a purpose-sensitive item.
4. **Repeat staples come from history.** `get_past_purchases` for things like toilet paper or
   coffee. Use only the purchase-history section; the promotional section is Woolworths
   advertising, not anything this person has bought. It returns a general list rather than
   answering a query, so read it for the item you want rather than expecting a filtered result.
5. **Compare on `unitPrice`.** Where a larger pack is better value than the person will use, size
   for the week and say what the cheaper-per-unit option was.
6. Read product names, not just search rank. Grades and forms matter ("tasty" is a maturity, not a
   brand; blocks, slices and grated all match the same search).

Search results carry a `coverage` line saying whether you are seeing everything. When it says the
set is partial, request further pages before claiming anything is the cheapest or the only option —
and treat the match count as approximate.

## Quantities

- `purchasingUnit` tells you what to send: `Each` for counted items, `Kg` for loose produce.
- For `Kg`, quantity is a **weight in kilograms**, not a count of items. To buy a number of items,
  read `averageWeightPerUnit` from `get_product` and multiply: 3 bananas at 0.25 kg each is `0.75`.
- Quantities are **absolute**, not deltas. Setting 3 means the line becomes 3.
- Woolworths rounds a weight up to a whole number of items, so a request can come back larger than
  asked. Report `appliedQuantity` when it differs from what you requested.
- Size for two adults for a week unless told otherwise.

## Filling the cart

1. `get_cart` first. The cart carries over between sessions, so items may already be there.
2. Adjust or remove an existing line when the list calls for it — too small a quantity, a
   duplicate, a better match for the dish — and report the change. Leave lines that already
   satisfy the list.
3. Add everything in one `set_cart_quantities` call rather than one call per item.
4. Check the per-item outcomes. Report any failure; retry a single failed line with
   `set_cart_quantity` before giving up on it.
5. `get_cart` afterwards to confirm.

## Never

- No checkout, no payment, no delivery slot. No tool does these; do not look for a way.
- Do not empty the cart or "start fresh" without being asked.

## Reporting

Give, in this order:

1. What you added — product, size, quantity, price.
2. What you changed or removed from what was already there, and why.
3. What you left alone because it already satisfied the list.
4. Anything you could not find, and why.
5. **Every pick where purpose was ambiguous**, with the alternative you did not choose.
6. Cart line count and total.

Keep it short. If a search returned a `coverage` line saying the result set was partial, do not
claim anything was the cheapest or only option available.
