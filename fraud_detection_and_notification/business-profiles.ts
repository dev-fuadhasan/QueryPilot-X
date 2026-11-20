import type { BusinessProfile, BusinessProfileType } from "./types";

export const BUSINESS_PROFILES: Record<BusinessProfileType, BusinessProfile> = {
  ecommerce: {
    id: "ecommerce",
    name: "E-Commerce & Retail",
    tagline: "Orders, checkouts, transactions, and discount integrity",
    description:
      "Detects abnormal order sizes, duplicate checkouts, card stuffing burst velocity, extreme discount exploits (e.g. >80%), and suspicious refund spikes.",
    targetTables: ["sales", "orders", "transactions", "order_items", "payments", "invoices", "checkouts"],
    rules: [
      "OUTLIER_AMOUNT",
      "DUPLICATE_TRANSACTION",
      "VELOCITY_SPIKE",
      "ABNORMAL_DISCOUNT",
      "STATUS_ANOMALY",
      "AUDIT_TAMPER",
    ],
    defaultThreshold: 50,
  },
  social_platform: {
    id: "social_platform",
    name: "Social Media & Community (e.g., Facebook-like)",
    tagline: "Account takeovers, privilege escalation, and bot bursts",
    description:
      "Detects unauthorized role escalations (non-admin becoming admin/moderator), sudden mass bot registration bursts, credential changes, and anomalous activity floods.",
    targetTables: ["users", "accounts", "profiles", "members", "logins", "roles", "posts", "ad_campaigns"],
    rules: [
      "ROLE_ESCALATION",
      "VELOCITY_SPIKE",
      "AUDIT_TAMPER",
      "RECORD_DELETED",
      "STATUS_ANOMALY",
    ],
    defaultThreshold: 40,
  },
  fintech: {
    id: "fintech",
    name: "Fintech & Banking",
    tagline: "High-value transfers, rapid withdrawals, and balance depletion",
    description:
      "Detects abnormal fund transfers far above user baselines, rapid consecutive withdrawals, duplicate payment requests, and sudden negative account balances.",
    targetTables: ["transfers", "withdrawals", "deposits", "transactions", "accounts", "wallets", "balances"],
    rules: [
      "OUTLIER_AMOUNT",
      "VELOCITY_SPIKE",
      "DUPLICATE_TRANSACTION",
      "AUDIT_TAMPER",
      "STATUS_ANOMALY",
    ],
    defaultThreshold: 60,
  },
  saas: {
    id: "saas",
    name: "SaaS & Subscriptions",
    tagline: "Seat abuse, tier escalation, and billing bypass",
    description:
      "Detects trial abuse, unauthorized plan/tier elevation, abnormal credit consumption spikes, and rapid invoice cancellations.",
    targetTables: ["subscriptions", "invoices", "plans", "organizations", "users", "licenses", "usage"],
    rules: [
      "OUTLIER_AMOUNT",
      "ROLE_ESCALATION",
      "STATUS_ANOMALY",
      "AUDIT_TAMPER",
    ],
    defaultThreshold: 50,
  },
  universal: {
    id: "universal",
    name: "Universal / Any Dataset",
    tagline: "Automated anomaly detection across any table schema",
    description:
      "Scans any connected PostgreSQL / Supabase table for statistical outliers, record deletions, sensitive column tampering, and data integrity anomalies.",
    targetTables: [],
    rules: [
      "OUTLIER_AMOUNT",
      "VELOCITY_SPIKE",
      "DUPLICATE_TRANSACTION",
      "AUDIT_TAMPER",
      "RECORD_DELETED",
      "ROLE_ESCALATION",
    ],
    defaultThreshold: 50,
  },
};

export function detectBestProfile(tableNames: string[]): BusinessProfileType {
  const normalized = tableNames.map((t) => t.toLowerCase());

  // Check fintech keywords
  if (
    normalized.some((t) =>
      ["transfer", "wallet", "deposit", "withdrawal", "balance"].some((k) =>
        t.includes(k)
      )
    )
  ) {
    return "fintech";
  }

  // Check social / user platform keywords
  if (
    normalized.some((t) =>
      ["post", "comment", "profile", "feed", "member", "follower", "friend"].some((k) =>
        t.includes(k)
      )
    )
  ) {
    return "social_platform";
  }

  // Check e-commerce keywords
  if (
    normalized.some((t) =>
      ["sale", "order", "product", "cart", "item", "payment", "checkout"].some((k) =>
        t.includes(k)
      )
    )
  ) {
    return "ecommerce";
  }

  // Check SaaS keywords
  if (
    normalized.some((t) =>
      ["subscription", "tenant", "organization", "plan", "license"].some((k) =>
        t.includes(k)
      )
    )
  ) {
    return "saas";
  }

  return "universal";
}
