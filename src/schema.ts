import { z } from 'zod';

export const SellerSchema = z.object({
  id: z.number().int().nullable(),
  name: z.string(),
  profileUrl: z.string().url().nullable(),
  location: z.string().nullable(),
  /** As shown on KP, e.g. "14.03.2017." */
  memberSince: z.string().nullable(),
  /** ISO date (YYYY-MM-DD) parsed from memberSince. */
  memberSinceDate: z.string().nullable(),
  reviewsPositive: z.number().int().nullable(),
  reviewsNegative: z.number().int().nullable(),
  /** Total active ads of the seller (from their public "Svi oglasi" page). */
  activeAds: z.number().int().nullable(),
  /** "person" / "company" declaration, when KP shows it. */
  declarationType: z.string().nullable(),
  traderInfo: z.string().nullable(),
  responseInfo: z.string().nullable(),
  phoneVerified: z.boolean(),
  bankAccountVerified: z.boolean(),
  companyBankAccountVerified: z.boolean(),
  kpIzlog: z.boolean(),
  kpIzlogUrl: z.string().nullable(),
  /** Human-readable list of the badges above that are set. */
  badges: z.array(z.string()),
});

export const PriceSchema = z.object({
  /** Numeric price, null for "Dogovor", "Kontakt", "Kupujem", etc. */
  amount: z.number().nullable(),
  /** ISO currency code (EUR, RSD, …) when amount is set. */
  currency: z.string().nullable(),
  /** Price converted to EUR with KP's own middle rate (used for sorting). */
  amountEur: z.number().nullable(),
  /** Text exactly as KP shows it: "1.200 €", "Dogovor", "Kupujem"… */
  label: z.string(),
  fixed: z.boolean(),
  exchange: z.boolean(),
});

export const AdSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
  adType: z.string().nullable(),
  price: PriceSchema,
  condition: z.string().nullable(),
  category: z.object({
    id: z.number().int().nullable(),
    name: z.string().nullable(),
    groupId: z.number().int().nullable(),
    groupName: z.string().nullable(),
    path: z.string(),
  }),
  location: z.string().nullable(),
  /** "YYYY-MM-DD HH:mm:ss" (Europe/Belgrade) of posting or last renewal. */
  postedAt: z.string().nullable(),
  postedRelative: z.string().nullable(),
  isRenewed: z.boolean(),
  validUntil: z.string().nullable(),
  viewCount: z.number().int().nullable(),
  favoriteCount: z.number().int().nullable(),
  promoted: z.boolean(),
  description: z.string(),
  attributes: z.record(z.string(), z.string()),
  images: z.array(z.string().url()),
  delivery: z.object({
    immediatelyAvailable: z.boolean(),
    localPickup: z.boolean(),
    courier: z.boolean(),
  }),
  seller: SellerSchema,
  scrapedAt: z.string(),
});

export type Ad = z.infer<typeof AdSchema>;
export type Seller = z.infer<typeof SellerSchema>;
