// Validators placeholder for simple request body validations
// In a real app, use Joi or Zod

const isValidPublicKey = (key) => {
  return typeof key === 'string' && key.startsWith('G') && key.length === 56;
};

const isValidPhoneNumber = (phone) => {
  return typeof phone === 'string' && phone.length > 5;
};

module.exports = {
  isValidPublicKey,
  isValidPhoneNumber,
};
