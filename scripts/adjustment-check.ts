/**
 * Checks the cart-adjustment wording against the quantities Woolworths actually applied.
 *
 * The cases are live observations: sku 133211 (loose bananas) requested at 0.3 Kg comes back as
 * 0.5 Kg; sku 245902 (limes) accepts 0.3 Kg unchanged. This runs no network calls, so it also
 * guards the wording against regressions without touching a real trolley.
 *
 * Run with `npm run check:adjustment`.
 */
import { toCartAdjustment } from "../src/woolworths/mappers.js";

interface Case {
  readonly name: string;
  readonly requestedQuantity: number;
  readonly appliedQuantity: number;
  readonly requestedPricingUnit: string;
  readonly appliedPricingUnit: string;
  readonly quantityIncrement: number | undefined;
  readonly expectAdjusted: boolean;
  readonly expectInNote: readonly string[];
}

const cases: readonly Case[] = [
  {
    name: "bananas 133211: 0.3 Kg requested, 0.5 Kg applied",
    requestedQuantity: 0.3,
    appliedQuantity: 0.5,
    requestedPricingUnit: "KG",
    appliedPricingUnit: "KG",
    quantityIncrement: undefined,
    expectAdjusted: true,
    expectInNote: ["applied 0.5 KG", "not the 0.3 KG requested", "minimum order quantity"],
  },
  {
    // Live: the site sells loose bananas in 0.25 Kg steps, so 0.3 Kg moves to 0.5 Kg.
    name: "bananas 133211 explained by the 0.25 Kg step the site sells in",
    requestedQuantity: 0.3,
    appliedQuantity: 0.5,
    requestedPricingUnit: "KG",
    appliedPricingUnit: "KG",
    quantityIncrement: 0.25,
    expectAdjusted: true,
    expectInNote: ["sold in steps of 0.25", "nearest step"],
  },
  {
    // Live: limes average 0.1 Kg each, so 0.3 Kg is exactly 3 limes and needs no adjustment.
    name: "limes 245902: 0.3 Kg requested and applied",
    requestedQuantity: 0.3,
    appliedQuantity: 0.3,
    requestedPricingUnit: "KG",
    appliedPricingUnit: "KG",
    quantityIncrement: 0.1,
    expectAdjusted: false,
    expectInNote: [],
  },
  {
    name: "counted item: 3 Each requested and applied",
    requestedQuantity: 3,
    appliedQuantity: 3,
    requestedPricingUnit: "EACH",
    appliedPricingUnit: "EACH",
    quantityIncrement: undefined,
    expectAdjusted: false,
    expectInNote: [],
  },
  {
    // The reported defect: removing a Kg-priced line sent Each and the site echoed Kg.
    name: "removal of a Kg-priced line reports no adjustment",
    requestedQuantity: 0,
    appliedQuantity: 0,
    requestedPricingUnit: "EACH",
    appliedPricingUnit: "KG",
    quantityIncrement: undefined,
    expectAdjusted: false,
    expectInNote: [],
  },
  {
    name: "removal the site did not honour is still reported",
    requestedQuantity: 0,
    appliedQuantity: 0.5,
    requestedPricingUnit: "EACH",
    appliedPricingUnit: "KG",
    quantityIncrement: undefined,
    expectAdjusted: true,
    expectInNote: ["applied 0.5 KG", "what is actually left on the line"],
  },
  {
    name: "site overrides the pricing unit",
    requestedQuantity: 1,
    appliedQuantity: 1,
    requestedPricingUnit: "EACH",
    appliedPricingUnit: "KG",
    quantityIncrement: undefined,
    expectAdjusted: true,
    expectInNote: ["priced this line as KG", "not the EACH requested"],
  },
  {
    name: "site lowers the quantity",
    requestedQuantity: 10,
    appliedQuantity: 4,
    requestedPricingUnit: "EACH",
    appliedPricingUnit: "EACH",
    quantityIncrement: undefined,
    expectAdjusted: true,
    expectInNote: ["applied 4 EACH", "lowered it"],
  },
];

let failures = 0;

for (const testCase of cases) {
  const result = toCartAdjustment(
    testCase.requestedQuantity,
    testCase.appliedQuantity,
    testCase.requestedPricingUnit,
    testCase.appliedPricingUnit,
    testCase.quantityIncrement,
  );
  const note = result.note ?? "";
  const missing = testCase.expectInNote.filter((fragment) => !note.includes(fragment));
  const passed = result.adjusted === testCase.expectAdjusted && missing.length === 0;
  if (!passed) failures += 1;

  console.log(`  [${passed ? "PASS" : "FAIL"}] ${testCase.name}`);
  console.log(`         adjusted=${result.adjusted} (expected ${testCase.expectAdjusted})`);
  if (note !== "") console.log(`         note: ${note}`);
  if (missing.length > 0) console.log(`         MISSING: ${missing.join(" | ")}`);
}

console.log(
  failures === 0 ? "\nAdjustment wording check passed." : `\nFAILED: ${failures} case(s)`,
);
process.exitCode = failures === 0 ? 0 : 1;
