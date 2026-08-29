const logger = require('../utils/logger');
const { response } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');

const generateCaseNumber = () => {
  const prefix = 'CASE';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
};

const createSupportCase = async (req, res) => {
  try {
    const { userId, category, title, description, transactionId, walletId, priority = 'normal' } = req.body;
    const adminId = req.user?.id;

    if (!['payment_dispute', 'kyc_issue', 'error_investigation', 'account_access', 'other'].includes(category)) {
      return response(res, 400, { success: false, message: 'Invalid case category' });
    }

    if (!title || !description) {
      return response(res, 400, { success: false, message: 'Title and description are required' });
    }

    // Capture customer context at case creation
    const user = userId ? await req.app.locals.prisma.user.findUnique({ where: { id: userId } }) : null;
    const wallet = walletId ? await req.app.locals.prisma.wallet.findUnique({ where: { id: walletId } }) : null;
    const transaction = transactionId ? await req.app.locals.prisma.transaction.findUnique({ where: { id: transactionId } }) : null;

    const caseData = {
      caseNumber: generateCaseNumber(),
      userId,
      category,
      title,
      description,
      transactionId,
      walletId,
      priority,
      assignedTo: adminId,
    };

    const supportCase = await req.app.locals.prisma.$transaction(async (tx) => {
      const newCase = await tx.supportCase.create({ data: caseData });

      // Create creation snapshot with customer context
      await tx.supportCaseSnapshot.create({
        data: {
          caseId: newCase.id,
          snapshotType: 'creation',
          userData: user ? {
            id: user.id,
            phoneNumber: user.phoneNumber,
            kycTier: user.kycTier,
            riskScore: user.riskScore,
          } : {},
          walletData: wallet ? {
            id: wallet.id,
            chain: wallet.chain,
            publicKey: wallet.publicKey,
            funded: wallet.funded,
          } : null,
          transactionData: transaction ? {
            id: transaction.id,
            type: transaction.type,
            amount: transaction.amount,
            status: transaction.status,
            rail: transaction.rail,
          } : null,
        },
      });

      // Create creation comment
      await tx.supportCaseComment.create({
        data: {
          caseId: newCase.id,
          authorType: 'admin',
          authorId: adminId,
          actionType: 'comment',
          body: `Case created: ${description}`,
        },
      });

      return newCase;
    });

    // Log case creation for audit trail
    if (req.app.locals.auditLog) {
      await req.app.locals.auditLog({
        actorType: 'administrator',
        actorId: adminId,
        action: 'support.case.create',
        entityType: 'SupportCase',
        entityId: supportCase.id,
        metadata: {
          category,
          caseNumber: supportCase.caseNumber,
          userId,
          transactionId,
        },
      });
    }

    return response(res, 201, {
      success: true,
      message: 'Support case created',
      data: supportCase,
    });
  } catch (err) {
    logger.error('Error creating support case', err.message);
    return response(res, 500, { success: false, message: 'Failed to create support case' });
  }
};

const listSupportCases = async (req, res) => {
  try {
    const { userId, status = 'open', priority, assignedTo, limit = 50, cursor } = req.query;

    const where = {};
    if (userId) where.userId = userId;
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (assignedTo) where.assignedTo = assignedTo;

    const cases = await req.app.locals.prisma.supportCase.findMany({
      where,
      take: parseInt(limit, 10),
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, phoneNumber: true } },
        comments: { take: 5, orderBy: { createdAt: 'desc' } },
      },
    });

    return response(res, 200, {
      success: true,
      data: cases,
    });
  } catch (err) {
    logger.error('Error listing support cases', err.message);
    return response(res, 500, { success: false, message: 'Failed to list support cases' });
  }
};

const getSupportCase = async (req, res) => {
  try {
    const { caseId } = req.params;

    const supportCase = await req.app.locals.prisma.supportCase.findUnique({
      where: { id: caseId },
      include: {
        user: { select: { id: true, phoneNumber: true, kycTier: true } },
        comments: { orderBy: { createdAt: 'asc' } },
        snapshots: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!supportCase) {
      return response(res, 404, { success: false, message: 'Case not found' });
    }

    return response(res, 200, {
      success: true,
      data: supportCase,
    });
  } catch (err) {
    logger.error('Error fetching support case', err.message);
    return response(res, 500, { success: false, message: 'Failed to fetch support case' });
  }
};

const addCaseComment = async (req, res) => {
  try {
    const { caseId } = req.params;
    const { body, actionType = 'comment' } = req.body;
    const adminId = req.user?.id;

    if (!body || body.trim().length === 0) {
      return response(res, 400, { success: false, message: 'Comment body is required' });
    }

    const supportCase = await req.app.locals.prisma.supportCase.findUnique({ where: { id: caseId } });
    if (!supportCase) {
      return response(res, 404, { success: false, message: 'Case not found' });
    }

    const comment = await req.app.locals.prisma.supportCaseComment.create({
      data: {
        caseId,
        authorType: 'admin',
        authorId: adminId,
        actionType,
        body,
      },
    });

    // Log comment for audit trail
    if (req.app.locals.auditLog) {
      await req.app.locals.auditLog({
        actorType: 'administrator',
        actorId: adminId,
        action: 'support.case.comment',
        entityType: 'SupportCase',
        entityId: caseId,
        metadata: { actionType },
      });
    }

    return response(res, 201, {
      success: true,
      message: 'Comment added',
      data: comment,
    });
  } catch (err) {
    logger.error('Error adding case comment', err.message);
    return response(res, 500, { success: false, message: 'Failed to add comment' });
  }
};

const updateSupportCase = async (req, res) => {
  try {
    const { caseId } = req.params;
    const { status, priority, assignedTo, resolution } = req.body;
    const adminId = req.user?.id;

    if (status && !['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
      return response(res, 400, { success: false, message: 'Invalid case status' });
    }

    if (priority && !['low', 'normal', 'high', 'critical'].includes(priority)) {
      return response(res, 400, { success: false, message: 'Invalid priority' });
    }

    const supportCase = await req.app.locals.prisma.supportCase.findUnique({ where: { id: caseId } });
    if (!supportCase) {
      return response(res, 404, { success: false, message: 'Case not found' });
    }

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (priority !== undefined) updateData.priority = priority;
    if (assignedTo !== undefined) updateData.assignedTo = assignedTo;

    if (status === 'resolved') {
      updateData.resolvedBy = adminId;
      updateData.resolvedAt = new Date();
      if (resolution) updateData.resolution = resolution;
    } else if (status === 'closed') {
      updateData.closedAt = new Date();
    }

    const updated = await req.app.locals.prisma.supportCase.update({
      where: { id: caseId },
      data: updateData,
    });

    // Log status change for audit trail
    if (req.app.locals.auditLog) {
      await req.app.locals.auditLog({
        actorType: 'administrator',
        actorId: adminId,
        action: 'support.case.update',
        entityType: 'SupportCase',
        entityId: caseId,
        metadata: {
          previousStatus: supportCase.status,
          newStatus: status,
          previousAssignedTo: supportCase.assignedTo,
          newAssignedTo: assignedTo,
        },
      });
    }

    return response(res, 200, {
      success: true,
      message: 'Case updated',
      data: updated,
    });
  } catch (err) {
    logger.error('Error updating support case', err.message);
    return response(res, 500, { success: false, message: 'Failed to update case' });
  }
};

module.exports = {
  createSupportCase,
  listSupportCases,
  getSupportCase,
  addCaseComment,
  updateSupportCase,
};
