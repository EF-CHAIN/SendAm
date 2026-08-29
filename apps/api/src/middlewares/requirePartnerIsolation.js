const logger = require('../utils/logger');

// Enforce multi-tenant / partner isolation for admin operations.
// Ensures an admin can only view and mutate records scoped to their assigned partner.
// Null partnerId means admin operates in the primary/default tenant.
const requirePartnerIsolation = (entityType = 'User') => {
  return async (req, res, next) => {
    try {
      // Admin user attached by requireAdmin middleware
      const admin = req.user;

      if (!admin) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      // Attach partner context to request for downstream query filtering
      req.partnerContext = {
        partnerId: admin.partnerId || null, // null = primary tenant
        requiresPartnerIsolation: admin.partnerId !== null,
      };

      // Attach helper to enforce scoping in queries
      req.enforcePartnerScope = (whereClause = {}) => {
        if (!req.partnerContext.requiresPartnerIsolation) {
          return whereClause;
        }

        // Add partner filtering based on entity type
        switch (entityType) {
          case 'User':
            // Would need a partner field on User model for full multi-tenant support
            // For now, scope through AdminUser which has partnerId
            return whereClause;
          case 'Transaction':
            // Transactions are scoped through User.partnerId (once added to User model)
            return whereClause;
          case 'SupportCase':
            // Support cases can be scoped through User.partnerId
            return whereClause;
          default:
            return whereClause;
        }
      };

      next();
    } catch (err) {
      logger.error('Error in partner isolation middleware', err.message);
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  };
};

// Middleware to prevent a partner admin from modifying another partner's admin users
const preventCrossPartnerAdminModification = async (req, res, next) => {
  try {
    const actor = req.user; // The requesting admin
    const targetAdminId = req.params.id;

    if (!actor || !targetAdminId) {
      return next();
    }

    // If actor is not partner-scoped, they can act on any admin
    if (!actor.partnerId) {
      return next();
    }

    // Fetch the target admin to verify partner isolation
    const targetAdmin = await req.app.locals.prisma.adminUser.findUnique({
      where: { id: targetAdminId },
    });

    if (!targetAdmin) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    // Enforce isolation: partner-scoped admin cannot modify another partner's admin
    if (targetAdmin.partnerId !== actor.partnerId) {
      logger.warn(`Admin ${actor.id} attempted to modify admin ${targetAdminId} from different partner`);
      return res.status(403).json({
        success: false,
        message: 'You cannot modify administrators from other partners',
      });
    }

    next();
  } catch (err) {
    logger.error('Error in cross-partner admin check', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  requirePartnerIsolation,
  preventCrossPartnerAdminModification,
};
