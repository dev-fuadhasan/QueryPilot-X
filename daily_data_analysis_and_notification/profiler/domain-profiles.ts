import type { BusinessDomainId, BusinessDomainProfile } from "./types";

export const BUSINESS_DOMAIN_PROFILES: Record<BusinessDomainId, BusinessDomainProfile> = {
  sales_ecommerce: {
    id: "sales_ecommerce",
    name: "Sales & E-commerce",
    shortName: "Sales",
    description: "Orders, invoices, revenue, product performance, discounts, margins, and regional sales.",
    tableKeywords: [
      "sale", "sales", "order", "orders", "invoice", "invoices", "checkout", "pos",
      "receipt", "commerce", "ecommerce", "retail", "store", "purchase", "order_item", "order_items", "line_item"
    ],
    fields: [
      {
        role: "orderId",
        label: "Order / Transaction ID",
        description: "Unique identifier for a sales order or invoice.",
        required: true,
        expectedCategories: ["identifier", "numeric", "text"],
        aliases: ["order_id", "orderid", "invoice_id", "sale_id", "transaction_id", "order_no", "order_number", "receipt_id", "bill_no", "tx_id", "tx_ref"],
        genericAliases: ["id"],
        tokenHints: ["order", "invoice", "sale", "receipt", "bill"],
        negativeTokens: ["customer", "user", "product", "item", "sku", "store", "warehouse", "campaign", "shipment"]
      },
      {
        role: "transactionDate",
        label: "Order / Sale Date",
        description: "Date or timestamp when the sale occurred.",
        required: true,
        expectedCategories: ["temporal", "text"],
        aliases: ["order_date", "orderdate", "sale_date", "invoice_date", "transaction_date", "ordered_at", "purchased_at", "purchase_timestamp", "order_time", "booked_on", "sold_at"],
        genericAliases: ["created_at", "date", "timestamp"],
        tokenHints: ["order", "sale", "purchase", "invoice", "sold", "date", "time"],
        negativeTokens: ["updated", "modified", "deleted", "birth", "dob", "expiry", "expire", "due", "shipped", "delivered"]
      },
      {
        role: "revenue",
        label: "Sales Revenue / Amount",
        description: "Total sales revenue, net sales, or selling price.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["total_revenue", "revenue", "net_sales", "gross_sales", "sales_amount", "sale_amount", "order_total", "grand_total", "net_total", "selling_price", "total_price", "subtotal", "sales"],
        genericAliases: ["total_amount", "amount", "total", "price", "net_amount", "gross_total", "unit_price"],
        tokenHints: ["revenue", "sales", "selling", "subtotal", "grand", "price"],
        negativeTokens: ["cost", "cogs", "expense", "discount", "tax", "refund", "shipping", "budget", "spend", "rating", "score", "qty", "quantity", "count", "salary", "wage"]
      },
      {
        role: "quantity",
        label: "Quantity / Units Sold",
        description: "Number of units sold per line item or order.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["quantity", "qty", "units_sold", "item_quantity", "order_quantity", "sold_qty", "units"],
        genericAliases: ["count"],
        tokenHints: ["qty", "quantity", "units", "sold"],
        negativeTokens: ["stock", "on_hand", "reorder", "price", "cost", "amount", "discount", "rating", "days"],
        valueConstraints: { min: 0, preferInteger: true }
      },
      {
        role: "cost",
        label: "Product Cost / COGS",
        description: "Unit cost or cost of goods sold.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["unit_cost", "total_cost", "item_cost", "cogs", "cost_price", "purchase_price", "buying_price", "cost"],
        tokenHints: ["cost", "cogs", "buying"],
        negativeTokens: ["shipping", "delivery", "marketing", "ad", "acquisition", "cac", "cpc", "cpa"]
      },
      {
        role: "profit",
        label: "Gross / Net Profit",
        description: "Calculated profit per line or order.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["gross_profit", "net_profit", "total_profit", "profit", "earnings", "margin_amount"],
        tokenHints: ["profit", "earnings"],
        negativeTokens: ["margin_pct", "margin_percent", "rate", "ratio"]
      },
      {
        role: "discount",
        label: "Discount Amount or Percent",
        description: "Discount applied to the order or item.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["discount_amount", "discount", "discount_percent", "discount_rate", "discount_pct", "promo_discount"],
        tokenHints: ["discount", "promo", "coupon", "markdown"],
        negativeTokens: ["code", "name", "type"]
      },
      {
        role: "product",
        label: "Product Name / SKU",
        description: "Product title, item name, or SKU label.",
        required: false,
        expectedCategories: ["text", "categorical", "identifier"],
        aliases: ["product_name", "item_name", "product_title", "item_title", "sku_name", "product", "item", "sku"],
        genericAliases: ["title", "name"],
        tokenHints: ["product", "item", "sku", "merchandise"],
        negativeTokens: ["customer", "client", "user", "category", "region", "campaign", "vendor", "supplier", "warehouse"]
      },
      {
        role: "category",
        label: "Product Category",
        description: "Category or department of the sold product.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["category", "product_category", "item_category", "department", "product_line", "collection"],
        genericAliases: ["type", "group"],
        tokenHints: ["category", "department", "collection"],
        negativeTokens: ["expense", "account", "ticket", "event", "device", "payment"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "status",
        label: "Order Status",
        description: "Lifecycle status of the order (Completed, Pending, Cancelled, Returned).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["order_status", "sale_status", "payment_status", "fulfillment_status"],
        genericAliases: ["status", "state"],
        tokenHints: ["status", "state"],
        negativeTokens: ["stock", "campaign", "subscription", "account", "ticket"],
        valueConstraints: {
          preferLowCardinality: true,
          expectedTokens: ["completed", "pending", "processing", "confirmed", "cancelled", "canceled", "returned", "delivered", "paid", "refunded"]
        }
      },
      {
        role: "customerId",
        label: "Customer Identifier",
        description: "Reference to the purchasing customer.",
        required: false,
        expectedCategories: ["identifier", "numeric", "text"],
        aliases: ["customer_id", "client_id", "buyer_id", "account_id", "member_id"],
        genericAliases: ["user_id"],
        tokenHints: ["customer", "client", "buyer", "member"],
        negativeTokens: ["name", "email", "phone", "gender", "rating", "segment"]
      },
      {
        role: "region",
        label: "Region / Location",
        description: "Geographic sales region, city, or country.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["region", "customer_region", "sales_region", "area", "territory", "city", "state", "country", "zone", "location"],
        tokenHints: ["region", "city", "country", "area", "zone", "territory", "location"],
        negativeTokens: ["warehouse", "ip", "currency"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "gender",
        label: "Customer Gender",
        description: "Demographic gender breakdown if tracked.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["customer_gender", "gender", "sex"],
        tokenHints: ["gender", "sex"],
        valueConstraints: { preferLowCardinality: true, expectedTokens: ["male", "female", "other", "non-binary", "not specified"] }
      },
      {
        role: "rating",
        label: "Customer Rating",
        description: "Order or product review rating score.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["customer_rating", "review_rating", "product_rating", "rating", "stars"],
        genericAliases: ["score"],
        tokenHints: ["rating", "star", "review"],
        negativeTokens: ["credit", "risk", "fraud", "nps"],
        valueConstraints: { min: 0, max: 5 }
      }
    ],
    expectedRelationships: [
      { fromRole: "customerId", toDomain: "customers_crm", toRole: "customerId", description: "Links orders to CRM customer records." },
      { fromRole: "product", toDomain: "inventory_supply_chain", toRole: "skuId", description: "Links sold items to inventory stock records." },
      { fromRole: "orderId", toDomain: "operations_fulfillment", toRole: "orderId", description: "Links sales orders to fulfillment shipments." }
    ],
    metrics: [
      { id: "totalOrders", label: "Total Orders", description: "Distinct completed orders.", requiredRoles: ["orderId", "transactionDate"] },
      { id: "totalProductLines", label: "Total Line Items", description: "Completed order line items.", requiredRoles: ["orderId", "transactionDate"] },
      { id: "totalUnitsSold", label: "Total Units Sold", description: "Sum of units sold.", requiredRoles: ["orderId", "transactionDate", "quantity"] },
      { id: "totalRevenue", label: "Total Revenue", description: "Completed sales revenue.", requiredRoles: ["orderId", "transactionDate", "revenue"] },
      { id: "averageOrderValue", label: "Average Order Value", description: "Revenue divided by distinct orders.", requiredRoles: ["orderId", "transactionDate", "revenue"] },
      { id: "grossProfit", label: "Gross Profit", description: "Direct profit or revenue minus cost.", requiredRoles: ["orderId", "transactionDate"], anyOfRoleGroups: [["profit"], ["revenue", "cost"]] },
      { id: "grossProfitMargin", label: "Gross Profit Margin", description: "Gross profit as a percentage of revenue.", requiredRoles: ["orderId", "transactionDate", "revenue"], anyOfRoleGroups: [["profit"], ["cost"]] },
      { id: "totalDiscounts", label: "Total Discounts", description: "Total discount value granted.", requiredRoles: ["orderId", "transactionDate", "discount"] },
      { id: "averageCustomerRating", label: "Average Rating", description: "Average customer rating.", requiredRoles: ["orderId", "transactionDate", "rating"] },
      { id: "cancellationRate", label: "Cancellation & Return Rate", description: "Share of cancelled or returned orders.", requiredRoles: ["orderId", "transactionDate", "status"] }
    ]
  },

  inventory_supply_chain: {
    id: "inventory_supply_chain",
    name: "Inventory & Supply Chain",
    shortName: "Inventory",
    description: "Stock levels, SKUs, warehouses, reorder thresholds, supplier lead times, and stock movements.",
    tableKeywords: [
      "inventory", "stock", "warehouse", "warehouses", "sku", "skus", "supply", "supplier",
      "suppliers", "stock_movement", "procurement", "purchase_order", "replenishment", "catalog", "products"
    ],
    fields: [
      {
        role: "skuId",
        label: "SKU / Item ID",
        description: "Unique identifier for an inventory SKU or stock item.",
        required: true,
        expectedCategories: ["identifier", "text", "numeric"],
        aliases: ["sku_id", "sku", "item_id", "product_id", "inventory_id", "part_number", "barcode", "stock_id"],
        genericAliases: ["id", "code"],
        tokenHints: ["sku", "inventory", "stock", "item", "product", "part", "barcode"],
        negativeTokens: ["warehouse", "supplier", "vendor", "order", "customer", "user"]
      },
      {
        role: "recordedDate",
        label: "Snapshot / Movement Date",
        description: "Date when stock level or inventory movement was recorded.",
        required: true,
        expectedCategories: ["temporal", "text"],
        aliases: ["recorded_at", "snapshot_date", "movement_date", "stock_date", "restocked_at", "received_date", "updated_at", "as_of_date"],
        genericAliases: ["created_at", "date", "timestamp"],
        tokenHints: ["snapshot", "movement", "stock", "restock", "received", "recorded", "updated", "date"],
        negativeTokens: ["birth", "dob", "expiry"]
      },
      {
        role: "stockOnHand",
        label: "Stock On Hand",
        description: "Current available inventory quantity.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["stock_on_hand", "quantity_on_hand", "on_hand_qty", "available_stock", "stock_quantity", "stock_level", "current_stock", "qty_available", "in_stock"],
        genericAliases: ["quantity", "qty"],
        tokenHints: ["stock", "onhand", "available", "inventory", "qty"],
        negativeTokens: ["reorder", "min", "max", "sold", "shipped", "received", "cost", "value", "price"],
        valueConstraints: { min: 0, preferInteger: true }
      },
      {
        role: "reorderPoint",
        label: "Reorder Point / Min Stock",
        description: "Minimum stock threshold that triggers replenishment.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["reorder_point", "reorder_level", "min_stock", "safety_stock", "par_level", "threshold_qty"],
        tokenHints: ["reorder", "safety", "min_stock", "threshold", "par"],
        valueConstraints: { min: 0, preferInteger: true }
      },
      {
        role: "unitCost",
        label: "Unit Cost",
        description: "Cost per unit of inventory.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["unit_cost", "cost_per_unit", "standard_cost", "purchase_cost", "landed_cost", "item_cost", "cost"],
        tokenHints: ["cost", "landed"],
        negativeTokens: ["shipping", "total_value", "inventory_value", "selling", "retail"]
      },
      {
        role: "inventoryValue",
        label: "Inventory Valuation",
        description: "Total monetary value of stock on hand.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["inventory_value", "stock_value", "valuation", "total_stock_value", "carrying_value"],
        tokenHints: ["valuation", "stock_value", "inventory_value"],
        negativeTokens: ["unit_cost", "qty", "quantity"]
      },
      {
        role: "quantityReceived",
        label: "Quantity Received",
        description: "Inbound units received from suppliers.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["quantity_received", "qty_received", "inbound_qty", "received_units", "restocked_qty"],
        tokenHints: ["received", "inbound", "restock"],
        valueConstraints: { min: 0, preferInteger: true }
      },
      {
        role: "quantityShipped",
        label: "Quantity Issued / Shipped",
        description: "Outbound units issued or shipped.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["quantity_shipped", "qty_shipped", "outbound_qty", "issued_qty", "dispatched_qty"],
        tokenHints: ["shipped", "outbound", "issued", "dispatched"],
        valueConstraints: { min: 0, preferInteger: true }
      },
      {
        role: "warehouse",
        label: "Warehouse / Location",
        description: "Storage facility or warehouse identifier.",
        required: false,
        expectedCategories: ["categorical", "text", "identifier"],
        aliases: ["warehouse", "warehouse_name", "warehouse_id", "depot", "bin_location", "facility", "store_location"],
        tokenHints: ["warehouse", "depot", "facility", "bin"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "supplier",
        label: "Supplier / Vendor",
        description: "Supplier providing the inventory item.",
        required: false,
        expectedCategories: ["categorical", "text", "identifier"],
        aliases: ["supplier", "supplier_name", "supplier_id", "vendor", "vendor_name", "manufacturer"],
        tokenHints: ["supplier", "vendor", "manufacturer"]
      },
      {
        role: "leadTimeDays",
        label: "Supplier Lead Time (Days)",
        description: "Days required for replenishment from supplier.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["lead_time_days", "lead_time", "replenishment_days", "delivery_lead_days"],
        tokenHints: ["lead", "replenishment"],
        valueConstraints: { min: 0 }
      },
      {
        role: "product",
        label: "Item / Product Name",
        description: "Human-readable name of the stocked item.",
        required: false,
        expectedCategories: ["text", "categorical"],
        aliases: ["product_name", "item_name", "sku_name", "material_name"],
        genericAliases: ["name", "title"],
        tokenHints: ["product", "item", "material"],
        negativeTokens: ["warehouse", "supplier", "vendor", "category"]
      },
      {
        role: "category",
        label: "Inventory Category",
        description: "Classification group for inventory items.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["category", "item_category", "product_category", "stock_group", "department"],
        tokenHints: ["category", "group"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "status",
        label: "Stock Status",
        description: "Inventory availability status (In Stock, Low Stock, Out of Stock, Backordered).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["stock_status", "inventory_status", "availability_status"],
        genericAliases: ["status"],
        tokenHints: ["status", "availability"],
        valueConstraints: {
          preferLowCardinality: true,
          expectedTokens: ["in stock", "low stock", "out of stock", "backorder", "backordered", "discontinued", "active"]
        }
      }
    ],
    expectedRelationships: [
      { fromRole: "skuId", toDomain: "sales_ecommerce", toRole: "product", description: "Connects inventory items to sales demand." },
      { fromRole: "warehouse", toDomain: "operations_fulfillment", toRole: "warehouse", description: "Connects warehouses to fulfillment operations." }
    ],
    metrics: [
      { id: "totalSkus", label: "Active SKUs", description: "Distinct SKUs tracked.", requiredRoles: ["skuId", "recordedDate"] },
      { id: "totalStockOnHand", label: "Total Stock On Hand", description: "Sum of available inventory units.", requiredRoles: ["skuId", "recordedDate", "stockOnHand"] },
      { id: "lowStockItems", label: "Low Stock Items", description: "SKUs at or below reorder point.", requiredRoles: ["skuId", "recordedDate", "stockOnHand", "reorderPoint"] },
      { id: "outOfStockItems", label: "Out of Stock Items", description: "SKUs with zero stock on hand.", requiredRoles: ["skuId", "recordedDate", "stockOnHand"] },
      { id: "totalInventoryValue", label: "Inventory Value", description: "Valuation from inventoryValue or stockOnHand * unitCost.", requiredRoles: ["skuId", "recordedDate"], anyOfRoleGroups: [["inventoryValue"], ["stockOnHand", "unitCost"]] },
      { id: "averageLeadTime", label: "Average Lead Time", description: "Mean supplier lead time in days.", requiredRoles: ["skuId", "recordedDate", "leadTimeDays"] },
      { id: "netStockMovement", label: "Net Stock Movement", description: "Received minus shipped units.", requiredRoles: ["skuId", "recordedDate", "quantityReceived", "quantityShipped"] }
    ]
  },

  marketing_campaigns: {
    id: "marketing_campaigns",
    name: "Marketing & Campaigns",
    shortName: "Marketing",
    description: "Ad campaigns, spend, impressions, clicks, CTR, leads, conversions, and ROAS.",
    tableKeywords: [
      "marketing", "campaign", "campaigns", "ads", "ad_spend", "advertising", "attribution",
      "lead", "leads", "funnel", "promotion", "promotions", "channel", "ppc", "social_ads"
    ],
    fields: [
      {
        role: "campaignId",
        label: "Campaign ID",
        description: "Unique identifier for a marketing campaign or ad set.",
        required: true,
        expectedCategories: ["identifier", "text", "numeric"],
        aliases: ["campaign_id", "ad_id", "adset_id", "promo_id", "marketing_id"],
        genericAliases: ["id"],
        tokenHints: ["campaign", "ad", "promo"],
        negativeTokens: ["customer", "user", "order", "product", "account"]
      },
      {
        role: "campaignDate",
        label: "Campaign / Report Date",
        description: "Date of campaign performance metrics.",
        required: true,
        expectedCategories: ["temporal", "text"],
        aliases: ["campaign_date", "report_date", "stat_date", "ad_date", "run_date", "metric_date", "launch_date"],
        genericAliases: ["date", "created_at", "timestamp"],
        tokenHints: ["campaign", "report", "stat", "ad", "metric", "date"],
        negativeTokens: ["end_date", "expiry", "updated"]
      },
      {
        role: "campaignName",
        label: "Campaign Name",
        description: "Name of the marketing campaign.",
        required: false,
        expectedCategories: ["text", "categorical"],
        aliases: ["campaign_name", "ad_name", "promo_name", "campaign_title", "campaign"],
        genericAliases: ["name", "title"],
        tokenHints: ["campaign", "promo", "ad"],
        negativeTokens: ["channel", "source", "customer", "product"]
      },
      {
        role: "channel",
        label: "Marketing Channel / Source",
        description: "Acquisition or ad channel (Google Ads, Meta, Email, Organic).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["channel", "marketing_channel", "ad_channel", "utm_source", "utm_medium", "source", "platform", "traffic_source"],
        tokenHints: ["channel", "utm", "source", "medium", "platform"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "spend",
        label: "Ad Spend / Marketing Cost",
        description: "Amount spent on the campaign.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["ad_spend", "marketing_spend", "spend", "campaign_cost", "media_spend", "ad_cost", "cost"],
        genericAliases: ["amount"],
        tokenHints: ["spend", "ad_cost", "media", "marketing_cost"],
        negativeTokens: ["revenue", "sales", "budget", "cpc", "cpa", "cpm", "roas", "clicks", "impressions"],
        valueConstraints: { min: 0 }
      },
      {
        role: "impressions",
        label: "Impressions",
        description: "Number of times ads or content were displayed.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["impressions", "ad_impressions", "views", "reach", "impression_count"],
        tokenHints: ["impression", "reach", "views"],
        valueConstraints: { min: 0, preferInteger: true }
      },
      {
        role: "clicks",
        label: "Clicks",
        description: "Total ad or link clicks.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["clicks", "ad_clicks", "link_clicks", "click_count"],
        tokenHints: ["click"],
        negativeTokens: ["rate", "ctr", "cpc", "cost"],
        valueConstraints: { min: 0, preferInteger: true }
      },
      {
        role: "conversions",
        label: "Conversions",
        description: "Completed conversions attributed to the campaign.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["conversions", "conversion_count", "purchases", "signups", "acquisitions"],
        tokenHints: ["conversion", "acquisition", "signup"],
        negativeTokens: ["rate", "cvr", "value", "revenue"],
        valueConstraints: { min: 0, preferInteger: true }
      },
      {
        role: "leads",
        label: "Leads Generated",
        description: "Number of qualified or raw leads generated.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["leads", "lead_count", "mqls", "sqls", "qualified_leads"],
        tokenHints: ["lead", "mql", "sql"],
        valueConstraints: { min: 0, preferInteger: true }
      },
      {
        role: "attributedRevenue",
        label: "Attributed Revenue",
        description: "Revenue generated from the campaign.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["attributed_revenue", "campaign_revenue", "conversion_value", "revenue", "sales_value"],
        tokenHints: ["revenue", "conversion_value", "roas_revenue"],
        negativeTokens: ["spend", "cost", "budget", "cpc", "cpa"]
      },
      {
        role: "status",
        label: "Campaign Status",
        description: "Operational state (Active, Paused, Ended, Draft).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["campaign_status", "ad_status"],
        genericAliases: ["status"],
        tokenHints: ["status"],
        valueConstraints: { preferLowCardinality: true, expectedTokens: ["active", "paused", "ended", "completed", "draft", "scheduled"] }
      }
    ],
    expectedRelationships: [
      { fromRole: "channel", toDomain: "customers_crm", toRole: "acquisitionChannel", description: "Connects marketing channels to customer acquisition." }
    ],
    metrics: [
      { id: "totalSpend", label: "Total Ad Spend", description: "Sum of campaign spend.", requiredRoles: ["campaignId", "campaignDate", "spend"] },
      { id: "totalImpressions", label: "Total Impressions", description: "Total impressions delivered.", requiredRoles: ["campaignId", "campaignDate", "impressions"] },
      { id: "totalClicks", label: "Total Clicks", description: "Total clicks.", requiredRoles: ["campaignId", "campaignDate", "clicks"] },
      { id: "clickThroughRate", label: "CTR (%)", description: "Clicks divided by impressions.", requiredRoles: ["campaignId", "campaignDate", "clicks", "impressions"] },
      { id: "totalConversions", label: "Total Conversions", description: "Attributed conversions.", requiredRoles: ["campaignId", "campaignDate", "conversions"] },
      { id: "conversionRate", label: "Conversion Rate (%)", description: "Conversions divided by clicks.", requiredRoles: ["campaignId", "campaignDate", "conversions", "clicks"] },
      { id: "costPerClick", label: "Cost Per Click (CPC)", description: "Spend divided by clicks.", requiredRoles: ["campaignId", "campaignDate", "spend", "clicks"] },
      { id: "costPerAcquisition", label: "Cost Per Acquisition (CPA)", description: "Spend divided by conversions.", requiredRoles: ["campaignId", "campaignDate", "spend", "conversions"] },
      { id: "returnOnAdSpend", label: "ROAS", description: "Attributed revenue divided by spend.", requiredRoles: ["campaignId", "campaignDate", "attributedRevenue", "spend"] }
    ]
  },

  finance_expenses: {
    id: "finance_expenses",
    name: "Finance & Expenses",
    shortName: "Finance",
    description: "Ledger transactions, expenses, income, cash flow, budgets, taxes, vendors, and departments.",
    tableKeywords: [
      "finance", "financial", "expense", "expenses", "ledger", "accounting", "journal",
      "cashflow", "cash_flow", "budget", "budgets", "payroll", "payout", "billing", "ap", "ar", "gl", "transactions"
    ],
    fields: [
      {
        role: "transactionId",
        label: "Ledger / Entry ID",
        description: "Unique identifier for a financial entry or voucher.",
        required: true,
        expectedCategories: ["identifier", "text", "numeric"],
        aliases: ["transaction_id", "ledger_id", "expense_id", "entry_id", "voucher_id", "journal_id", "bill_id", "payout_id", "tx_id"],
        genericAliases: ["id"],
        tokenHints: ["ledger", "expense", "voucher", "journal", "entry", "transaction", "payout"],
        negativeTokens: ["customer", "user", "product", "campaign", "shipment"]
      },
      {
        role: "transactionDate",
        label: "Posting / Transaction Date",
        description: "Date the financial transaction was booked or paid.",
        required: true,
        expectedCategories: ["temporal", "text"],
        aliases: ["transaction_date", "expense_date", "posting_date", "entry_date", "booked_date", "payment_date", "paid_at", "billing_date"],
        genericAliases: ["date", "created_at", "timestamp"],
        tokenHints: ["posting", "expense", "payment", "paid", "billing", "transaction", "entry", "date"],
        negativeTokens: ["due_date", "updated", "birth"]
      },
      {
        role: "amount",
        label: "Transaction Amount",
        description: "Monetary amount of the ledger or expense entry.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["transaction_amount", "net_amount", "total_amount", "amount", "entry_amount", "ledger_amount", "bill_amount", "payment_amount"],
        tokenHints: ["amount", "payment", "bill"],
        negativeTokens: ["tax", "budget", "qty", "quantity", "rate", "percent", "discount"]
      },
      {
        role: "expenseAmount",
        label: "Expense / Debit Amount",
        description: "Explicit outflow or expense column.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["expense_amount", "expense", "debit", "debit_amount", "outflow", "cost_amount", "disbursement"],
        tokenHints: ["expense", "debit", "outflow", "disbursement"],
        negativeTokens: ["income", "credit", "inflow", "budget", "category", "date"]
      },
      {
        role: "incomeAmount",
        label: "Income / Credit Amount",
        description: "Explicit inflow or credit column.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["income_amount", "income", "credit", "credit_amount", "inflow", "receipt_amount"],
        tokenHints: ["income", "credit", "inflow"],
        negativeTokens: ["expense", "debit", "outflow", "card"]
      },
      {
        role: "transactionType",
        label: "Entry Type (Income / Expense)",
        description: "Indicates whether the row is an inflow or outflow.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["transaction_type", "entry_type", "flow_type", "direction", "debit_credit", "cash_direction"],
        genericAliases: ["type"],
        tokenHints: ["type", "direction", "flow"],
        valueConstraints: {
          preferLowCardinality: true,
          expectedTokens: ["income", "expense", "debit", "credit", "inflow", "outflow", "revenue", "cost"]
        }
      },
      {
        role: "expenseCategory",
        label: "Account / Expense Category",
        description: "GL account or expense category (Payroll, Cloud, Rent, Travel).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["expense_category", "account_category", "cost_center", "gl_account", "account_name", "category"],
        tokenHints: ["expense_category", "account", "cost_center", "gl", "category"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "department",
        label: "Department",
        description: "Organizational department owning the expense or budget.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["department", "dept", "business_unit", "team", "division"],
        tokenHints: ["department", "dept", "division", "unit"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "vendor",
        label: "Vendor / Payee",
        description: "Payee or supplier receiving payment.",
        required: false,
        expectedCategories: ["text", "categorical"],
        aliases: ["vendor", "vendor_name", "payee", "merchant", "supplier", "counterparty"],
        tokenHints: ["vendor", "payee", "merchant", "counterparty"]
      },
      {
        role: "taxAmount",
        label: "Tax / VAT Amount",
        description: "Tax component of the financial entry.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["tax_amount", "vat_amount", "tax", "vat", "gst_amount"],
        tokenHints: ["tax", "vat", "gst"],
        negativeTokens: ["rate", "percent", "id"]
      },
      {
        role: "budgetAmount",
        label: "Budget Amount",
        description: "Planned budget allocation for comparison.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["budget_amount", "budget", "planned_amount", "allocated_budget"],
        tokenHints: ["budget", "planned", "allocated"]
      },
      {
        role: "status",
        label: "Approval / Payment Status",
        description: "Workflow status (Approved, Paid, Pending, Reimbursed, Void).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["payment_status", "approval_status", "expense_status", "bill_status"],
        genericAliases: ["status"],
        tokenHints: ["status", "approval"],
        valueConstraints: { preferLowCardinality: true, expectedTokens: ["paid", "approved", "pending", "rejected", "reimbursed", "void", "posted"] }
      }
    ],
    expectedRelationships: [
      { fromRole: "vendor", toDomain: "inventory_supply_chain", toRole: "supplier", description: "Connects vendor disbursements to suppliers." }
    ],
    metrics: [
      { id: "transactionCount", label: "Ledger Entries", description: "Total financial entries in period.", requiredRoles: ["transactionId", "transactionDate"] },
      { id: "totalExpenses", label: "Total Expenses", description: "Sum of outflows/expenses.", requiredRoles: ["transactionId", "transactionDate"], anyOfRoleGroups: [["expenseAmount"], ["amount"]] },
      { id: "totalIncome", label: "Total Income", description: "Sum of inflows/income.", requiredRoles: ["transactionId", "transactionDate"], anyOfRoleGroups: [["incomeAmount"], ["amount", "transactionType"]] },
      { id: "netCashFlow", label: "Net Cash Flow", description: "Income minus expenses.", requiredRoles: ["transactionId", "transactionDate"], anyOfRoleGroups: [["incomeAmount", "expenseAmount"], ["amount", "transactionType"]] },
      { id: "totalTax", label: "Total Tax", description: "Total tax recorded.", requiredRoles: ["transactionId", "transactionDate", "taxAmount"] },
      { id: "budgetVariance", label: "Budget Variance", description: "Budget minus actual spend.", requiredRoles: ["transactionId", "transactionDate", "budgetAmount"], anyOfRoleGroups: [["expenseAmount"], ["amount"]] }
    ]
  },

  customers_crm: {
    id: "customers_crm",
    name: "Customers & CRM",
    shortName: "Customers",
    description: "Customer directory, acquisition, segments, lifecycle stages, deals, retention, and churn.",
    tableKeywords: [
      "customer", "customers", "client", "clients", "crm", "contact", "contacts",
      "account", "accounts", "deal", "deals", "opportunity", "opportunities", "subscriber", "subscribers", "member", "members"
    ],
    fields: [
      {
        role: "customerId",
        label: "Customer / Account ID",
        description: "Unique identifier for a customer, client, or CRM account.",
        required: true,
        expectedCategories: ["identifier", "text", "numeric"],
        aliases: ["customer_id", "client_id", "account_id", "contact_id", "member_id", "subscriber_id", "crm_id"],
        genericAliases: ["id", "user_id"],
        tokenHints: ["customer", "client", "account", "contact", "member", "subscriber"],
        negativeTokens: ["order", "invoice", "product", "campaign", "shipment", "event"]
      },
      {
        role: "activityDate",
        label: "Signup / Activity Date",
        description: "Date the customer signed up, converted, or was updated.",
        required: true,
        expectedCategories: ["temporal", "text"],
        aliases: ["signup_date", "joined_at", "registered_at", "customer_since", "acquisition_date", "created_date", "last_activity_at", "close_date"],
        genericAliases: ["created_at", "date", "timestamp"],
        tokenHints: ["signup", "joined", "registered", "acquisition", "activity", "close", "created", "date"],
        negativeTokens: ["birth", "dob"]
      },
      {
        role: "segment",
        label: "Customer Segment",
        description: "Tier or segment (Enterprise, SMB, VIP, Consumer).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["customer_segment", "segment", "tier", "plan_tier", "account_tier", "customer_type", "cohort"],
        tokenHints: ["segment", "tier", "cohort", "plan"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "lifecycleStage",
        label: "Lifecycle / Deal Stage",
        description: "CRM funnel stage (Lead, Prospect, Qualified, Won, Active, Churned).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["lifecycle_stage", "deal_stage", "pipeline_stage", "funnel_stage", "stage"],
        tokenHints: ["stage", "lifecycle", "pipeline"],
        valueConstraints: {
          preferLowCardinality: true,
          expectedTokens: ["lead", "prospect", "qualified", "proposal", "won", "closed won", "lost", "active", "churned", "inactive"]
        }
      },
      {
        role: "dealValue",
        label: "Deal / LTV Value",
        description: "Pipeline deal value, ARR, or customer lifetime value.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["deal_value", "deal_amount", "opportunity_value", "ltv", "lifetime_value", "arr", "contract_value", "acv"],
        genericAliases: ["amount", "value"],
        tokenHints: ["deal", "ltv", "lifetime", "contract", "arr", "acv", "opportunity"],
        negativeTokens: ["cost", "discount", "score", "rating", "tickets", "count"]
      },
      {
        role: "acquisitionChannel",
        label: "Acquisition Channel",
        description: "How the customer was acquired.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["acquisition_channel", "lead_source", "signup_source", "referral_source", "channel", "utm_source"],
        tokenHints: ["acquisition", "source", "referral", "channel"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "churned",
        label: "Churned Flag",
        description: "Boolean indicator of whether the customer has churned.",
        required: false,
        expectedCategories: ["boolean"],
        aliases: ["is_churned", "churned", "has_churned", "is_cancelled", "is_active"],
        tokenHints: ["churn", "active"]
      },
      {
        role: "status",
        label: "Customer Status",
        description: "Account status (Active, Trial, Inactive, Churned, Suspended).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["customer_status", "account_status", "subscription_status", "member_status"],
        genericAliases: ["status"],
        tokenHints: ["status"],
        valueConstraints: { preferLowCardinality: true, expectedTokens: ["active", "inactive", "trial", "churned", "cancelled", "suspended", "vip"] }
      },
      {
        role: "satisfactionScore",
        label: "CSAT / NPS Score",
        description: "Customer satisfaction or Net Promoter score.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["csat", "csat_score", "nps", "nps_score", "satisfaction_score", "customer_rating"],
        tokenHints: ["csat", "nps", "satisfaction"],
        valueConstraints: { min: -100, max: 100 }
      },
      {
        role: "region",
        label: "Region / Country",
        description: "Customer geography.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["region", "country", "city", "state", "territory", "market"],
        tokenHints: ["region", "country", "city", "territory", "market"],
        valueConstraints: { preferLowCardinality: true }
      }
    ],
    expectedRelationships: [
      { fromRole: "customerId", toDomain: "sales_ecommerce", toRole: "customerId", description: "Connects customers to their order history." },
      { fromRole: "customerId", toDomain: "product_usage_saas", toRole: "userId", description: "Connects CRM accounts to product usage activity." }
    ],
    metrics: [
      { id: "totalCustomers", label: "Total Customers", description: "Distinct customers in scope.", requiredRoles: ["customerId", "activityDate"] },
      { id: "newCustomers", label: "New Customers", description: "Customers acquired in period.", requiredRoles: ["customerId", "activityDate"] },
      { id: "churnRate", label: "Churn Rate (%)", description: "Share of churned accounts.", requiredRoles: ["customerId", "activityDate"], anyOfRoleGroups: [["churned"], ["status"], ["lifecycleStage"]] },
      { id: "totalPipelineValue", label: "Total Deal / LTV Value", description: "Aggregate deal or customer value.", requiredRoles: ["customerId", "activityDate", "dealValue"] },
      { id: "averageDealValue", label: "Average Deal Value", description: "Mean deal value per customer.", requiredRoles: ["customerId", "activityDate", "dealValue"] },
      { id: "averageSatisfaction", label: "Average Satisfaction", description: "Mean CSAT or NPS score.", requiredRoles: ["customerId", "activityDate", "satisfactionScore"] }
    ]
  },

  operations_fulfillment: {
    id: "operations_fulfillment",
    name: "Operations & Fulfillment",
    shortName: "Operations",
    description: "Shipments, dispatch, delivery SLAs, processing times, carriers, tickets, and fulfillment quality.",
    tableKeywords: [
      "operation", "operations", "fulfillment", "shipment", "shipments", "delivery", "deliveries",
      "logistics", "dispatch", "courier", "shipping", "sla", "ticket", "tickets", "work_order", "service_request"
    ],
    fields: [
      {
        role: "shipmentId",
        label: "Shipment / Work Order ID",
        description: "Unique identifier for a shipment, dispatch, or operational ticket.",
        required: true,
        expectedCategories: ["identifier", "text", "numeric"],
        aliases: ["shipment_id", "fulfillment_id", "delivery_id", "tracking_id", "tracking_number", "dispatch_id", "work_order_id", "ticket_id"],
        genericAliases: ["id"],
        tokenHints: ["shipment", "fulfillment", "delivery", "tracking", "dispatch", "ticket", "work_order"],
        negativeTokens: ["customer", "user", "product", "campaign"]
      },
      {
        role: "eventDate",
        label: "Dispatch / Fulfillment Date",
        description: "Timestamp of dispatch, shipment, or operational ticket.",
        required: true,
        expectedCategories: ["temporal", "text"],
        aliases: ["shipped_at", "ship_date", "dispatch_date", "fulfillment_date", "delivered_at", "delivery_date", "opened_at", "resolved_at"],
        genericAliases: ["created_at", "date", "timestamp"],
        tokenHints: ["ship", "dispatch", "fulfillment", "deliver", "opened", "resolved", "date", "time"],
        negativeTokens: ["birth", "dob"]
      },
      {
        role: "orderId",
        label: "Related Order ID",
        description: "Sales order associated with this shipment.",
        required: false,
        expectedCategories: ["identifier", "text", "numeric"],
        aliases: ["order_id", "sales_order_id", "reference_order_id"],
        tokenHints: ["order"]
      },
      {
        role: "fulfillmentStatus",
        label: "Fulfillment Status",
        description: "Operational state (Delivered, In Transit, Delayed, Packed, Failed, Resolved).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["fulfillment_status", "shipment_status", "delivery_status", "dispatch_status", "ticket_status"],
        genericAliases: ["status", "state"],
        tokenHints: ["status", "state"],
        valueConstraints: {
          preferLowCardinality: true,
          expectedTokens: ["delivered", "in transit", "shipped", "packed", "pending", "delayed", "failed", "returned", "resolved", "open", "closed"]
        }
      },
      {
        role: "slaMet",
        label: "On-Time / SLA Met Flag",
        description: "Boolean indicating whether SLA or on-time delivery target was met.",
        required: false,
        expectedCategories: ["boolean"],
        aliases: ["sla_met", "is_on_time", "on_time", "within_sla", "met_sla", "sla_breached"],
        tokenHints: ["sla", "ontime"]
      },
      {
        role: "processingHours",
        label: "Processing / Resolution Hours",
        description: "Hours taken to pack, fulfill, or resolve.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["processing_hours", "handling_hours", "fulfillment_hours", "resolution_hours", "cycle_time_hours", "turnaround_hours"],
        tokenHints: ["processing", "handling", "resolution", "turnaround", "cycle", "hours"],
        valueConstraints: { min: 0 }
      },
      {
        role: "deliveryDays",
        label: "Delivery / Transit Days",
        description: "Days taken from dispatch to delivery.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["delivery_days", "transit_days", "shipping_days", "days_to_deliver"],
        tokenHints: ["delivery_days", "transit", "shipping_days"],
        valueConstraints: { min: 0 }
      },
      {
        role: "carrier",
        label: "Carrier / Logistics Partner",
        description: "Courier or shipping carrier.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["carrier", "shipping_carrier", "courier", "logistics_partner", "provider"],
        tokenHints: ["carrier", "courier", "logistics"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "warehouse",
        label: "Origin Warehouse / Hub",
        description: "Fulfillment center or hub.",
        required: false,
        expectedCategories: ["categorical", "text", "identifier"],
        aliases: ["warehouse", "warehouse_id", "fulfillment_center", "hub", "origin_hub", "facility"],
        tokenHints: ["warehouse", "hub", "facility", "center"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "shippingCost",
        label: "Shipping / Fulfillment Cost",
        description: "Cost to ship or fulfill the order.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["shipping_cost", "delivery_cost", "freight_cost", "fulfillment_cost", "postage"],
        tokenHints: ["shipping_cost", "freight", "delivery_cost", "postage"],
        valueConstraints: { min: 0 }
      },
      {
        role: "defectCount",
        label: "Defects / Incidents",
        description: "Count of damaged, lost, or defective items.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["defect_count", "damaged_qty", "error_count", "incident_count", "rework_count"],
        tokenHints: ["defect", "damaged", "incident", "rework"],
        valueConstraints: { min: 0, preferInteger: true }
      }
    ],
    expectedRelationships: [
      { fromRole: "orderId", toDomain: "sales_ecommerce", toRole: "orderId", description: "Connects shipments back to sales orders." },
      { fromRole: "warehouse", toDomain: "inventory_supply_chain", toRole: "warehouse", description: "Connects fulfillment centers to inventory warehouses." }
    ],
    metrics: [
      { id: "totalShipments", label: "Total Shipments / Tickets", description: "Total operational records processed.", requiredRoles: ["shipmentId", "eventDate"] },
      { id: "slaComplianceRate", label: "SLA / On-Time Rate (%)", description: "Percentage meeting SLA targets.", requiredRoles: ["shipmentId", "eventDate", "slaMet"] },
      { id: "averageProcessingTime", label: "Avg. Processing Hours", description: "Mean processing or resolution time.", requiredRoles: ["shipmentId", "eventDate", "processingHours"] },
      { id: "averageDeliveryDays", label: "Avg. Delivery Days", description: "Mean transit time in days.", requiredRoles: ["shipmentId", "eventDate", "deliveryDays"] },
      { id: "totalShippingCost", label: "Total Shipping Cost", description: "Aggregate freight and shipping cost.", requiredRoles: ["shipmentId", "eventDate", "shippingCost"] },
      { id: "defectRate", label: "Defect / Incident Count", description: "Total defects or incidents.", requiredRoles: ["shipmentId", "eventDate", "defectCount"] }
    ]
  },

  product_usage_saas: {
    id: "product_usage_saas",
    name: "Product Usage & SaaS Analytics",
    shortName: "Product Usage",
    description: "Product telemetry, active users (DAU/WAU/MAU), sessions, feature adoption, duration, errors, and SaaS plans.",
    tableKeywords: [
      "usage", "event", "events", "product_event", "product_events", "analytics", "telemetry",
      "activity", "activities", "session", "sessions", "feature", "features", "audit_log", "user_activity", "saas", "pageview", "pageviews"
    ],
    fields: [
      {
        role: "userId",
        label: "User / Actor ID",
        description: "Identifier for the active user or account performing the product event.",
        required: true,
        expectedCategories: ["identifier", "text", "numeric"],
        aliases: ["user_id", "actor_id", "member_id", "account_id", "visitor_id", "anonymous_id", "distinct_id"],
        genericAliases: ["customer_id", "client_id"],
        tokenHints: ["user", "actor", "visitor", "distinct", "member"],
        negativeTokens: ["event", "session", "feature", "order", "product"]
      },
      {
        role: "eventTimestamp",
        label: "Event Timestamp",
        description: "When the usage event or session occurred.",
        required: true,
        expectedCategories: ["temporal", "text"],
        aliases: ["event_timestamp", "event_time", "occurred_at", "activity_at", "logged_at", "session_start", "started_at", "event_date"],
        genericAliases: ["created_at", "timestamp", "date"],
        tokenHints: ["event", "occurred", "activity", "logged", "session", "started", "timestamp", "time"],
        negativeTokens: ["birth", "dob", "expiry"]
      },
      {
        role: "eventId",
        label: "Event ID",
        description: "Unique identifier for an individual telemetry event.",
        required: false,
        expectedCategories: ["identifier", "text", "numeric"],
        aliases: ["event_id", "log_id", "activity_id", "telemetry_id"],
        genericAliases: ["id"],
        tokenHints: ["event", "log", "telemetry"],
        negativeTokens: ["user", "session", "account", "customer"]
      },
      {
        role: "eventName",
        label: "Event Name / Action",
        description: "Action performed by the user (login, export_pdf, run_query, signup).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["event_name", "event_type", "action", "action_name", "activity_type", "event"],
        tokenHints: ["event_name", "event_type", "action"],
        negativeTokens: ["time", "date", "id", "timestamp", "count"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "featureName",
        label: "Feature / Module Name",
        description: "Product feature, screen, or module used.",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["feature_name", "feature", "module", "module_name", "screen_name", "page_name", "route", "tool_name"],
        tokenHints: ["feature", "module", "screen", "page", "route", "tool"],
        valueConstraints: { preferLowCardinality: true }
      },
      {
        role: "sessionId",
        label: "Session ID",
        description: "Identifier grouping events within a user session.",
        required: false,
        expectedCategories: ["identifier", "text", "numeric"],
        aliases: ["session_id", "visit_id", "trace_id"],
        tokenHints: ["session", "visit"]
      },
      {
        role: "durationSeconds",
        label: "Session / Action Duration",
        description: "Duration spent in seconds or milliseconds.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["duration_seconds", "duration_ms", "duration", "session_duration", "time_spent_seconds", "latency_ms", "elapsed_ms"],
        tokenHints: ["duration", "elapsed", "latency", "time_spent"],
        valueConstraints: { min: 0 }
      },
      {
        role: "planTier",
        label: "Plan / Subscription Tier",
        description: "SaaS plan tier (Free, Starter, Pro, Enterprise).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["plan_tier", "plan", "subscription_plan", "tier", "workspace_plan"],
        tokenHints: ["plan", "tier"],
        valueConstraints: { preferLowCardinality: true, expectedTokens: ["free", "starter", "pro", "business", "enterprise", "trial"] }
      },
      {
        role: "platform",
        label: "Platform / Device",
        description: "Client platform or device (Web, iOS, Android, Desktop).",
        required: false,
        expectedCategories: ["categorical", "text"],
        aliases: ["platform", "device_type", "device", "os", "client_type", "browser"],
        tokenHints: ["platform", "device", "os", "browser"],
        valueConstraints: { preferLowCardinality: true, expectedTokens: ["web", "ios", "android", "desktop", "mobile", "api"] }
      },
      {
        role: "errorFlag",
        label: "Error / Failure Flag",
        description: "Boolean indicating whether an event failed or raised an error.",
        required: false,
        expectedCategories: ["boolean"],
        aliases: ["is_error", "has_error", "error_flag", "failed", "is_success"],
        tokenHints: ["error", "failed", "success"]
      },
      {
        role: "mrr",
        label: "MRR / Recurring Revenue",
        description: "Monthly recurring revenue associated with the account.",
        required: false,
        expectedCategories: ["numeric"],
        aliases: ["mrr", "monthly_recurring_revenue", "subscription_amount", "plan_revenue"],
        tokenHints: ["mrr", "recurring"],
        valueConstraints: { min: 0 }
      }
    ],
    expectedRelationships: [
      { fromRole: "userId", toDomain: "customers_crm", toRole: "customerId", description: "Connects product usage telemetry to CRM customer accounts." }
    ],
    metrics: [
      { id: "dailyActiveUsers", label: "Daily Active Users (DAU)", description: "Distinct active users per day.", requiredRoles: ["userId", "eventTimestamp"] },
      { id: "totalEvents", label: "Total Usage Events", description: "Total product interactions logged.", requiredRoles: ["userId", "eventTimestamp"] },
      { id: "totalSessions", label: "Total Sessions", description: "Distinct user sessions.", requiredRoles: ["userId", "eventTimestamp", "sessionId"] },
      { id: "averageSessionDuration", label: "Avg. Duration", description: "Mean event or session duration.", requiredRoles: ["userId", "eventTimestamp", "durationSeconds"] },
      { id: "featureAdoptionRate", label: "Feature Adoption", description: "Active users per feature/event.", requiredRoles: ["userId", "eventTimestamp"], anyOfRoleGroups: [["featureName"], ["eventName"]] },
      { id: "errorRate", label: "Event Error Rate (%)", description: "Percentage of events flagged as errors.", requiredRoles: ["userId", "eventTimestamp", "errorFlag"] },
      { id: "monthlyRecurringRevenue", label: "MRR", description: "Sum of monthly recurring revenue.", requiredRoles: ["userId", "eventTimestamp", "mrr"] }
    ]
  }
};

export function getDomainProfile(domainId: BusinessDomainId): BusinessDomainProfile {
  return BUSINESS_DOMAIN_PROFILES[domainId];
}

export function listDomainProfiles(): BusinessDomainProfile[] {
  return Object.values(BUSINESS_DOMAIN_PROFILES);
}
