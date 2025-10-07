import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? 'test-token';
process.env.HMAC_SECRET = process.env.HMAC_SECRET ?? 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://user:pass@localhost:5432/db';
process.env.KASPI_CARD = process.env.KASPI_CARD ?? '1234';
process.env.KASPI_NAME = process.env.KASPI_NAME ?? 'Test User';
process.env.KASPI_PHONE = process.env.KASPI_PHONE ?? '+70000000000';
process.env.SUPPORT_USERNAME = process.env.SUPPORT_USERNAME ?? 'test_support';
process.env.SUPPORT_URL = process.env.SUPPORT_URL ?? 'https://t.me/test_support';
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';

void (async () => {
  const { createPricingService } = await import('../src/services/pricing');

  const from = {
    query: 'A',
    address: 'Point A',
    latitude: 43.238949,
    longitude: 76.889709,
  } as const;

  const to = {
    query: 'B',
    address: 'Point B',
    latitude: 43.238949,
    longitude: 76.889709,
  } as const;

  const generalTariff = {
    base: 123,
    perKm: 456,
    perMin: 7,
  } as const;

  const pricingService = createPricingService(
    {
      taxi: {
        baseFare: 700,
        perKm: 200,
        minimumFare: 900,
      },
      delivery: {
        baseFare: 900,
        perKm: 250,
        minimumFare: 1_200,
      },
    },
    generalTariff,
  );

  const taxiQuote = pricingService.estimateTaxiPrice(from, to);
  const deliveryQuote = pricingService.estimateDeliveryPrice(from, to);

  const expectedAmount = Math.round((generalTariff.base + generalTariff.perMin * 5) / 10) * 10;

  assert.equal(taxiQuote.amount, expectedAmount, 'Taxi quote should respect the general tariff values');
  assert.equal(
    deliveryQuote.amount,
    expectedAmount,
    'Delivery quote should also respect the general tariff values',
  );

  assert.equal(
    deliveryQuote.amount,
    taxiQuote.amount,
    'Both taxi and delivery quotes should be aligned when a shared tariff is provided',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
