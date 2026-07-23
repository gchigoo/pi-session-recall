/**
 * 包级元数据与阶段标记。
 */
export const PACKAGE_NAME = "pi-session-recall";
export const PACKAGE_VERSION = "1.0.1";

/** 当前实施阶段。 */
export const IMPLEMENTATION_PHASE = "P6" as const;

/** 产品默认值（roadmap §2）。 */
export const PRODUCT_DEFAULTS = {
  autoRecall: false,
  indexRoles: ["user", "assistant"] as const,
  manualSearchDefaultLimit: 5,
  manualSearchMaxLimit: 20,
  toolSearchDefaultLimit: 5,
  toolSearchMaxLimit: 10,
  autoRecallMaxRecords: 4,
  autoRecallMaxEstimatedTokens: 600,
} as const;
