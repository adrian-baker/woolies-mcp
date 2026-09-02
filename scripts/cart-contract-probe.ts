/**
 * Answers the questions about the GraphQL cart that only the live site can answer.
 *
 * Three things the cart client relies on cannot be established from a capture, because the
 * captured frontend never does them: whether a mutation returns every line or only the ones it
 * changed, whether zeroing a variant the cart does not hold is harmless, and whether a variant key
 * the site does not know is rejected rather than ignored. The first decides whether an absent line
 * means zero; the second is done on every write; the third is what makes building a key from a sku
 * safe.
 *
 * It WILL modify a real cart, and it restores what it changed. Run it deliberately, signed in:
 *
 *   npm run probe:cart
 */
import { readFile } from "node:fs/promises";
import { defaultSessionFilePath } from "../src/session-store.js";
import { GraphQlError, SessionGraphQlTransport } from "../src/woolworths/graphql-client.js";
import {
  CART_READ_DOCUMENT,
  CART_READ_OPERATION,
  CART_WRITE_DOCUMENT,
  CART_WRITE_OPERATION,
  cartWriteVariables,
} from "../src/woolworths/graphql-documents.js";
import { NotSignedInError } from "../src/woolworths/auth.js";
import { Session } from "../src/woolworths/session.js";
import { Throttle } from "../src/woolworths/throttle.js";
import { cartReadResponseSchema, cartWriteResponseSchema } from "../src/woolworths/schemas.js";

/** Counted item and weight-priced item, both used by the account smoke. */
const EACH_SKU = "958674";
const BOGUS_VARIANT = `${EACH_SKU}-ZZ`;

const sessionFile = process.env["WOOLIES_SESSION_FILE"] ?? defaultSessionFilePath();
const stored: unknown = JSON.parse(await readFile(sessionFile, "utf8"));
const cookies = (stored as { cookies: { setCookie: string; url: string }[] }).cookies;

const session = new Session();
await session.bootstrap();
const accepted = await session.importCookies(cookies);
console.log(`Loaded ${accepted}/${cookies.length} cookies from ${sessionFile}.\n`);

const transport = new SessionGraphQlTransport(session, new Throttle(1_000));

async function readCart() {
  const data = await transport.send(CART_READ_OPERATION, CART_READ_DOCUMENT, {});
  const parsed = cartReadResponseSchema.parse(data);
  if (parsed.me === null) throw new NotSignedInError();
  return parsed.customerCart;
}

async function write(updates: readonly { variantKey: string; quantity: number }[]) {
  const data = await transport.send(
    CART_WRITE_OPERATION,
    CART_WRITE_DOCUMENT,
    cartWriteVariables(updates),
  );
  return cartWriteResponseSchema.parse(data).setCartLineItemQuantity;
}

function describe(error: unknown): string {
  if (error instanceof GraphQlError)
    return `${error.name} [${error.codes.join(", ")}]: ${error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

console.log("1. the session upgrade and the identity guard");
const before = await readCart();
console.log(
  `   cart ${before.key}: ${before.lineItems.length} lines, ${before.totalItemQuantity} items`,
);
const snapshot = new Map(before.lineItems.map((line) => [line.productVariantSku, line.quantity]));
if (snapshot.has(`${EACH_SKU}-EA`) || snapshot.has(`${EACH_SKU}-KG`)) {
  console.error(
    `\nThe cart already holds ${EACH_SKU}. Pick a different probe sku; nothing was changed.`,
  );
  process.exit(1);
}

console.log("\n2. does a write return every line, or only the ones it changed?");
const added = await write([
  { variantKey: `${EACH_SKU}-EA`, quantity: 1 },
  { variantKey: `${EACH_SKU}-KG`, quantity: 0 },
]);
console.log(`   updates sent: 2 (one of them zeroing a variant the cart did not hold)`);
console.log(
  `   the write returned ${added.lineItems.length} lines; the cart held ${before.lineItems.length} before`,
);
const returnedKeys = new Set(added.lineItems.map((line) => line.productVariantSku));
const missing = [...snapshot.keys()].filter((key) => !returnedKeys.has(key));
console.log(
  missing.length === 0
    ? "   ANSWER: every pre-existing line came back, so an absent variant means the cart holds none."
    : `   ANSWER: only some lines came back (missing ${missing.join(", ")}). An absent variant does NOT mean zero.`,
);
console.log(
  `   zeroing a variant with no line: ${added.lineItems.some((line) => line.productVariantSku === `${EACH_SKU}-EA`) ? "accepted, the other update still applied" : "the write did not land"}`,
);

console.log("\n3. is a variant key the site does not know rejected, or ignored?");
try {
  const bogus = await write([{ variantKey: BOGUS_VARIANT, quantity: 1 }]);
  console.log(
    `   ANSWER: accepted silently. ${bogus.totalItemQuantity} items, ${bogus.lineItems.length} lines.`,
  );
  console.log(
    "   A key built from a sku can therefore fail without saying so; the guard must change.",
  );
} catch (error: unknown) {
  console.log(`   ANSWER: rejected loudly — ${describe(error)}`);
}

console.log("\n4. is a batch applied together, or partly?");
const beforeBatch = await readCart();
const quantityBefore = beforeBatch.lineItems.find(
  (line) => line.productVariantSku === `${EACH_SKU}-EA`,
)?.quantity;
try {
  await write([
    { variantKey: `${EACH_SKU}-EA`, quantity: 4 },
    { variantKey: BOGUS_VARIANT, quantity: 1 },
  ]);
  console.log("   the batch was accepted; checking what landed");
} catch (error: unknown) {
  console.log(`   the batch was rejected — ${describe(error)}`);
}
const afterBatch = await readCart();
const quantityAfter = afterBatch.lineItems.find(
  (line) => line.productVariantSku === `${EACH_SKU}-EA`,
)?.quantity;
console.log(
  quantityBefore === quantityAfter
    ? `   ANSWER: nothing changed (${String(quantityBefore)} before and after). The batch is all or nothing.`
    : `   ANSWER: the good half landed (${String(quantityBefore)} -> ${String(quantityAfter)}). The batch is NOT atomic.`,
);

console.log("\n5. restoring the cart");
await write([
  { variantKey: `${EACH_SKU}-EA`, quantity: 0 },
  { variantKey: `${EACH_SKU}-KG`, quantity: 0 },
]);
const after = await readCart();
const restored =
  after.lineItems.length === before.lineItems.length &&
  after.lineItems.every((line) => snapshot.get(line.productVariantSku) === line.quantity);
console.log(
  restored
    ? `   restored: ${after.lineItems.length} lines, ${after.totalItemQuantity} items, matching the snapshot.`
    : `   NOT RESTORED. Before: ${JSON.stringify([...snapshot])}. After: ${JSON.stringify(after.lineItems.map((line) => [line.productVariantSku, line.quantity]))}`,
);
process.exitCode = restored ? 0 : 1;
