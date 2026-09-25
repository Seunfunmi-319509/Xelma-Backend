# Client migration: monetary fields are decimal strings

**Issue:** [#501](https://github.com/TevaLabs/Xelma-Backend/issues/501)

## What changed

Balances, stakes, payouts, pools, entry fees, prize pools, and round prices
are now serialized as **fixed-scale decimal strings** (`Decimal(20,8)` → 8
fractional digits). They are **never JSON numbers**.

```json
{
  "balance": "1000.33333333",
  "poolUp": "125.50000000",
  "payout": null
}
```

This applies to **production and hackathon** HTTP responses and to money
fields on Socket.IO events (`round:updated`, `bet:accepted`, `prediction:placed`).

Request bodies still accept numeric `amount` values. Only **responses** changed.

## Why

IEEE-754 JSON numbers cannot represent stroop-scale values. Mixed `number` /
`string` money fields caused frontend rounding bugs and cross-endpoint drift.

## Client checklist

1. Treat money fields as strings. Do **not** use `JSON.parse` numbers as
   balances or stakes.
2. Prefer a decimal library (`decimal.js`, `bignumber.js`, or BigInt stroops)
   for display math. Avoid `parseFloat` for anything that must stay exact.
3. Compare amounts as strings at 8 dp, or convert both sides with the same
   decimal helper.
4. Update TypeScript types: `amount: string`, `balance: string`,
   `poolUp: string`, `payout: string | null`.
5. OpenAPI `$ref` is `#/components/schemas/MoneyAmount` (or `NullableMoneyAmount`).

## Canonical helper

Server-side serialization is centralized in `src/serializers/monetary.serializer.ts`
and `serializeMoney()` in `src/utils/decimal.util.ts`.
