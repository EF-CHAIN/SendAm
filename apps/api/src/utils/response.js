const sendSuccess = (res, data, message = 'Success', statusCode = 200) => {
  res.status(statusCode).json({
    success: true,
    message,
    data,
  });
};

const sendError = (res, message = 'Error', statusCode = 400) => {
  res.status(statusCode).json({
    success: false,
    message,
  });
};

// Paginated list response. `data` stays a plain array so existing clients keep
// working, with a `pagination` block alongside for page controls.
const sendPaginated = (res, items, { page, limit, total }, message = 'Success') => {
  res.status(200).json({
    success: true,
    message,
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

module.exports = {
  sendSuccess,
  sendError,
  sendPaginated,
};
