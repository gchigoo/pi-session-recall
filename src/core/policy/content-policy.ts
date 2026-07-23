import { POLICY_VERSION } from "../config/versions.js";
import { ERROR_CODES, type DiagnosticEvent } from "../diagnostics/error-codes.js";
import { canonicalizeText } from "../sessions/chunker.js";

/**
 * Content policy v1（roadmap §5.4）。
 */

export type PersistDisposition = "allow" | "redacted" | "reject";

export interface PolicyDecision {
  persistDisposition: PersistDisposition;
  autoEligible: boolean;
  text: string;
  policyVersion: string;
  ruleIds: string[];
  diagnostics: DiagnosticEvent[];
}

const PEM_PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;

const KNOWN_TOKEN_PREFIXES = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{20,})\b/g,
];

const CREDENTIAL_ASSIGNMENT =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD))\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi;

const URL_USERINFO = /((?:https?|git|ssh):\/\/)([^/\s@]+)@/gi;

const RECALL_MARKER = /\[\[pi-session-recall[\s\S]*?\]\]/i;
const PSEUDO_ROLE = /^\s*(system|developer)\s*:/im;
const INJECTION_HINT =
  /忽略[\s\S]{0,16}(?:指令|规则)|ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|you\s+must\s+run\s+tools/i;

const MAX_POLICY_SCALARS = 100_000;

/**
 * 对单个 text block 应用 policy 流水线。
 */
export function applyContentPolicy(rawText: string): PolicyDecision {
  const diagnostics: DiagnosticEvent[] = [];
  const ruleIds: string[] = [];

  try {
    let text = canonicalizeText(rawText);
    if (text.length === 0) {
      return {
        persistDisposition: "reject",
        autoEligible: false,
        text: "",
        policyVersion: POLICY_VERSION,
        ruleIds: ["empty"],
        diagnostics,
      };
    }

    if ([...text].length > MAX_POLICY_SCALARS) {
      ruleIds.push("size-reject");
      diagnostics.push({ code: ERROR_CODES.ENTRY_OVERSIZED, ruleId: "size-reject", count: 1 });
      return {
        persistDisposition: "reject",
        autoEligible: false,
        text: "",
        policyVersion: POLICY_VERSION,
        ruleIds,
        diagnostics,
      };
    }

    if (PEM_PRIVATE_KEY.test(text) || isMostlyCredential(text)) {
      ruleIds.push("secret-reject");
      diagnostics.push({ code: ERROR_CODES.SECRET_REJECTED, ruleId: "secret-reject", count: 1 });
      return {
        persistDisposition: "reject",
        autoEligible: false,
        text: "",
        policyVersion: POLICY_VERSION,
        ruleIds,
        diagnostics,
      };
    }

    const redactedText = redactKnownSecrets(text, ruleIds);
    const redacted = redactedText !== text;
    text = redactedText;

    let autoEligible = true;
    if (RECALL_MARKER.test(text) || PSEUDO_ROLE.test(text) || INJECTION_HINT.test(text)) {
      autoEligible = false;
      ruleIds.push("auto-safety");
    }

    return {
      persistDisposition: redacted ? "redacted" : "allow",
      autoEligible,
      text,
      policyVersion: POLICY_VERSION,
      ruleIds,
      diagnostics,
    };
  } catch {
    diagnostics.push({
      code: ERROR_CODES.SCANNER_FAIL_CLOSED,
      ruleId: "scanner-exception",
      count: 1,
    });
    return {
      persistDisposition: "reject",
      autoEligible: false,
      text: "",
      policyVersion: POLICY_VERSION,
      ruleIds: ["scanner-fail-closed"],
      diagnostics,
    };
  }
}

/**
 * 已知密钥确定性脱敏。
 */
function redactKnownSecrets(text: string, ruleIds: string[]): string {
  let out = text;
  for (const pattern of KNOWN_TOKEN_PREFIXES) {
    pattern.lastIndex = 0;
    const next = out.replace(pattern, "[REDACTED_TOKEN]");
    if (next !== out) {
      ruleIds.push("token-redact");
      out = next;
    }
  }

  CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  const assigned = out.replace(CREDENTIAL_ASSIGNMENT, "$1=[REDACTED_SECRET]");
  if (assigned !== out) {
    ruleIds.push("assignment-redact");
    out = assigned;
  }

  URL_USERINFO.lastIndex = 0;
  const urlSimple = out.replace(URL_USERINFO, "$1[REDACTED_USERINFO]@");
  if (urlSimple !== out) {
    ruleIds.push("url-userinfo-redact");
    out = urlSimple;
  }

  return out;
}

/**
 * 正文是否整段就是单一 credential blob（不含空白的句子）。
 */
function isMostlyCredential(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 24 || /\s/.test(trimmed)) {
    return false;
  }
  return /^[A-Za-z0-9_\-./+=]{24,}$/.test(trimmed);
}

/**
 * 角色 allowlist：仅 user/assistant。
 */
export function isIndexableRole(role: string): boolean {
  return role === "user" || role === "assistant";
}
