import { config } from '../config';
import type { PricingConfig, TariffConfig, TariffRates } from '../config';
import type { OrderLocation, OrderPriceDetails } from '../types';

const EARTH_RADIUS_KM = 6371;
const AVERAGE_SPEED_KMH = 27;
const PICKUP_BUFFER_MINUTES = 5;
const MINIMUM_TRIP_MINUTES = 5;

const toRadians = (value: number): number => (value * Math.PI) / 180;

export const calculateDistanceKm = (
  from: OrderLocation,
  to: OrderLocation,
): number => {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);

  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.max(0, EARTH_RADIUS_KM * c);
};

const roundPrice = (amount: number): number => Math.round(amount / 10) * 10;

export const estimateEtaMinutes = (distanceKm: number): number => {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return MINIMUM_TRIP_MINUTES;
  }

  const travelMinutes = (distanceKm / AVERAGE_SPEED_KMH) * 60;
  const total = Math.ceil(travelMinutes + PICKUP_BUFFER_MINUTES);

  return Math.max(MINIMUM_TRIP_MINUTES, total);
};

const computeAmount = (
  distanceKm: number,
  etaMinutes: number,
  serviceTariff: TariffConfig,
  generalTariff: TariffRates | null,
): number => {
  if (generalTariff) {
    const raw =
      generalTariff.base +
      generalTariff.perKm * distanceKm +
      generalTariff.perMin * etaMinutes;

    return roundPrice(raw);
  }

  const raw = serviceTariff.baseFare + distanceKm * serviceTariff.perKm;
  const rounded = roundPrice(raw);

  return Math.max(serviceTariff.minimumFare, rounded);
};

const buildQuote = (
  from: OrderLocation,
  to: OrderLocation,
  tariff: TariffConfig,
  generalTariff: TariffRates | null,
): OrderPriceDetails => {
  const distanceKm = calculateDistanceKm(from, to);
  const etaMinutes = estimateEtaMinutes(distanceKm);
  const amount = computeAmount(distanceKm, etaMinutes, tariff, generalTariff);

  return {
    amount,
    currency: 'KZT',
    distanceKm,
    etaMinutes,
  } satisfies OrderPriceDetails;
};

type PricingEstimator = (from: OrderLocation, to: OrderLocation) => OrderPriceDetails;

interface PricingService {
  estimateTaxiPrice: PricingEstimator;
  estimateDeliveryPrice: PricingEstimator;
}

const createEstimator = (
  tariff: TariffConfig,
  generalTariff: TariffRates | null,
): PricingEstimator => (from, to) => buildQuote(from, to, tariff, generalTariff);

export const createPricingService = (
  pricing: PricingConfig,
  generalTariff: TariffRates | null = null,
): PricingService => ({
  estimateTaxiPrice: createEstimator(pricing.taxi, generalTariff),
  estimateDeliveryPrice: createEstimator(pricing.delivery, null),
});

const defaultPricingService = createPricingService(config.pricing, config.tariff);

export const estimateTaxiPrice = defaultPricingService.estimateTaxiPrice;
export const estimateDeliveryPrice = defaultPricingService.estimateDeliveryPrice;

const priceFormatter = new Intl.NumberFormat('ru-RU');
const durationFormatter = new Intl.NumberFormat('ru-RU');

export const formatPriceAmount = (amount: number, currency: string): string =>
  `${priceFormatter.format(amount)} ${currency}`;

export const formatPriceDetails = (price: OrderPriceDetails): string =>
  formatPriceAmount(price.amount, price.currency);

export const formatDistance = (distanceKm: number): string => {
  if (!Number.isFinite(distanceKm)) {
    return 'н/д';
  }

  if (distanceKm < 0.1) {
    return '<0.1';
  }

  return distanceKm.toFixed(1);
};

export const formatEtaMinutes = (etaMinutes: number): string => {
  if (!Number.isFinite(etaMinutes) || etaMinutes <= 0) {
    return 'н/д';
  }

  if (etaMinutes < 1) {
    return '<1';
  }

  return durationFormatter.format(Math.round(etaMinutes));
};
