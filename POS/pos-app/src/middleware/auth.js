'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const store = require('../store/excelStore');
const { PERMISSIONS } = require('../store/schema');
const { unauthorized, forbidden } = require('../lib/errors');

/**
 * Authentication and authorization.
 *
 * Two deliberate choices worth understanding before changing anything here:
 *
 * 1. The token is read from an httpOnly cookie, not from localStorage. A till
 *    browser in a restaurant is a shared, long-lived session on a machine
 *    several people touch; a token readable by JavaScript turns any injected
 *    script into a permanent manager session.
 *
 * 2. Permissions are checked against the user's CURRENT role from the store,
 *    not against the role baked into the token. Otherwise demoting or
 *    deactivating a staff member would not take effect until their token
 *    expired, which on a 12-hour shift token is not an acceptable delay when
 *    you have just fired someone.
 */

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), name: user.name, role: user.role },
    config.jwtSecret,
    { expiresIn: config.sessionTtl }
  );
}

function readToken(req) {
  if (req.cookies && req.cookies.pos_token) return req.cookies.pos_token;
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

function authenticate(req, _res, next) {
  const token = readToken(req);
  if (!token) return next(unauthorized());

  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(unauthorized('Your session has expired. Please sign in again.'));
  }

  const user = store.get('users', claims.sub);
  if (!user || !user.isActive) {
    return next(unauthorized('This account is no longer active.'));
  }

  req.user = { id: user.id, name: user.name, role: user.role };
  return next();
}

/**
 * Default deny: an endpoint without a `require(...)` guard is not reachable,
 * because every route file mounts one. Adding a new endpoint and forgetting the
 * guard should fail closed, so never mount a router without it.
 */
function require_(...needed) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    const granted = PERMISSIONS[req.user.role] || [];
    const ok = needed.every((p) => granted.includes(p));
    if (!ok) return next(forbidden());
    return next();
  };
}

module.exports = { signToken, authenticate, require: require_ };
