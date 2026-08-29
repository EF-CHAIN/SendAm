/**
 * Service: Support Data Minimization & Privacy Audit Service (#337)
 *
 * Defines granular access scopes for support customer data,
 * masks/redacts sensitive customer fields by default, and logs audit events for privileged access.
 */

const ACCESS_SCOPES = {
  MINIMAL: 'READ_MINIMAL',         // Default support view: masked phone/email/address
  STANDARD: 'READ_STANDARD',       // Standard support view: unmasked phone/email, masked balance/keys
  PRIVILEGED: 'READ_PRIVILEGED',   // Full admin/compliance view: unmasked details, audit log mandatory
};

class SupportPrivacyService {
  constructor() {
    this.auditLogs = [];
  }

  /**
   * Masks a phone number: "+2348012345678" -> "+234****5678"
   */
  maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '***';
    if (phone.length <= 6) return '***';
    return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
  }

  /**
   * Masks an email: "user@example.com" -> "u***@example.com"
   */
  maskEmail(email) {
    if (!email || !email.includes('@')) return '***@***.com';
    const [local, domain] = email.split('@');
    if (local.length <= 1) return `*@${domain}`;
    return `${local[0]}***@${domain}`;
  }

  /**
   * Masks a Stellar public key address: "GBX1234567890STEL" -> "GBX1...STEL"
   */
  maskAddress(address) {
    if (!address || typeof address !== 'string' || address.length < 10) return '***';
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  }

  /**
   * Sanitizes customer data based on agent access scope.
   */
  sanitizeCustomerData(customer, agentContext = {}) {
    const scope = agentContext.scope || ACCESS_SCOPES.MINIMAL;
    const agentId = agentContext.agentId || 'support_agent_anon';

    let sanitized = {
      id: customer.id,
      status: customer.status,
      createdAt: customer.createdAt,
    };

    if (scope === ACCESS_SCOPES.MINIMAL) {
      sanitized.name = customer.name;
      sanitized.phone = this.maskPhone(customer.phone);
      sanitized.email = this.maskEmail(customer.email);
      sanitized.walletAddress = this.maskAddress(customer.walletAddress);
      sanitized.accessLevel = 'MINIMAL_MASKED';
    } else if (scope === ACCESS_SCOPES.STANDARD) {
      sanitized.name = customer.name;
      sanitized.phone = customer.phone;
      sanitized.email = customer.email;
      sanitized.walletAddress = customer.walletAddress;
      sanitized.accessLevel = 'STANDARD';
    } else if (scope === ACCESS_SCOPES.PRIVILEGED) {
      sanitized = { ...customer, accessLevel: 'PRIVILEGED_FULL' };
    }

    // Log privileged audit access
    if (scope === ACCESS_SCOPES.PRIVILEGED || scope === ACCESS_SCOPES.STANDARD) {
      this.logAuditAccess({
        agentId,
        targetCustomerId: customer.id,
        scope,
        timestamp: new Date().toISOString(),
        justification: agentContext.justification || 'Support ticket inquiry',
      });
    }

    return sanitized;
  }

  /**
   * Logs an audit record for privileged access.
   */
  logAuditAccess(auditRecord) {
    const entry = {
      id: `audit_${Date.now()}_${this.auditLogs.length + 1}`,
      ...auditRecord,
    };
    this.auditLogs.push(entry);
    return entry;
  }

  /**
   * Retrieves audit logs for security reviews.
   */
  getAuditLogs(filter = {}) {
    return this.auditLogs.filter((log) => {
      if (filter.agentId && log.agentId !== filter.agentId) return false;
      if (filter.targetCustomerId && log.targetCustomerId !== filter.targetCustomerId) return false;
      return true;
    });
  }
}

const supportPrivacyService = new SupportPrivacyService();

module.exports = {
  ACCESS_SCOPES,
  SupportPrivacyService,
  supportPrivacyService,
};
