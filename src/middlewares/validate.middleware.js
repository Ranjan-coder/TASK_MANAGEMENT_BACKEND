const ApiError = require("../utils/ApiError");

const validate = (schema) => (req, res, next) => {
  try {
    const parsed = schema.parse({
      body: req.body,
      query: req.query,
      params: req.params
    });
    if (parsed.body) req.body = parsed.body;
    if (parsed.query) req.query = parsed.query;
    if (parsed.params) req.params = parsed.params;
    next();
  } catch (error) {
    if (error.errors) {
      const validationErrors = error.errors.map((err) => ({
        path: err.path.join("."),
        message: err.message
      }));
      return next(new ApiError(400, "Validation failed", validationErrors));
    }
    return next(new ApiError(400, error.message));
  }
};

module.exports = validate;
