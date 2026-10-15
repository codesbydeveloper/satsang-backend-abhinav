const { query } = require('../db');

/**
 * Record an admin action. Never throws: an audit-write failure must not break the request,
 * but it is logged loudly.
 * @param {import('express').Request} req   used for admin identity, IP and user agent
 */
async function audit(req, action, { entityType = null, entityId = null, details = null, admin = null } = {}) {
  try {
    const a = admin || req.admin || {};
    await query(
      'INSERT INTO audit_log (admin_id, admin_email, action, entity_type, entity_id, details, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)',
      [a.id || null, a.email || null, action, entityType, entityId == null ? null : String(entityId),
        details ? JSON.stringify(details) : null, req.ip || null, (req.get && req.get('user-agent') || '').slice(0, 255) || null],
    );
  } catch (err) {
    console.error('AUDIT WRITE FAILED', action, err.message);
  }
}

module.exports = { audit };
