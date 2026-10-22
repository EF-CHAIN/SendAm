/**
 * Categorizes an entity record into one of the titled sections:
 * 'Users', 'Transactions', 'Stellar Accounts'.
 */
export function getRecordCategory(record) {
  if (record.category) {
    const cat = String(record.category).toLowerCase();
    if (cat.includes("user")) return "Users";
    if (cat.includes("account") || cat.includes("wallet")) return "Stellar Accounts";
    return "Transactions";
  }
  if (record.publicKey) return "Stellar Accounts";
  if (record.whatsappName || (record.role && !record.txHash)) return "Users";
  return "Transactions";
}

export const CATEGORY_ORDER = ["Users", "Transactions", "Stellar Accounts"];
