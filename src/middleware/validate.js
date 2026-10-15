const { badRequest } = require('../utils/errors');

/** validate(schema, 'body' | 'query' | 'params') — replaces the value with the parsed result. */
const validate = (schema, where = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[where]);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return next(badRequest('VALIDATION_ERROR', 'Some fields are invalid', fields));
  }
  if (where === 'body') req.body = result.data; else req.validated = { ...(req.validated || {}), [where]: result.data };
  next();
};

module.exports = validate;
