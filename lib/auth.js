import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Autenticación de demostración (solo PMV local).
//
// MECANISMO: token firmado con HMAC-SHA256 (payload base64url + firma).
// LIMITACIONES (documentadas en el README):
//  - La firma usa PMV_SESSION_SECRET si existe; si no, un secreto fijo de demo
//    SOLO válido para entorno local. Nunca usar el valor por defecto en producción.
//  - No hay revocación de sesiones (token stateless con expiración de 8 h);
//    el cierre de sesión es local del cliente.
//  - Las contraseñas de las cuentas demo se guardan como hash SHA-256 y son
//    públicas en la documentación porque son cuentas ficticias de prueba.
//  - No es un sistema de producción: no hay rate limiting, bloqueo por
//    intentos ni rotación de claves.
// ---------------------------------------------------------------------------

const SECRET = process.env.PMV_SESSION_SECRET || 'pmv-e1-demo-secret-solo-local';
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas

export function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

export function issueToken({ id, workshopId, workshopCode, displayName, role }) {
  const payload = {
    sub: String(id),
    w: workshopId ? String(workshopId) : null,
    code: workshopCode ?? null,
    name: displayName ?? null,
    role: role ?? 'repairer',
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!payload?.sub || !payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** Requiere cualquier sesión de demostración válida (reparador o investigador). */
export function requireAuth(req, res, next) {
  const payload = verifyToken(extractToken(req));
  if (!payload) {
    return res.status(401).json({ error: 'Sesión ausente o inválida. Inicia sesión con una cuenta de demostración.' });
  }
  req.auth = {
    id: payload.sub,
    workshopId: payload.w ?? null,
    workshopCode: payload.code ?? null,
    displayName: payload.name ?? null,
    role: payload.role === 'admin' ? 'admin' : 'repairer',
  };
  next();
}

/** Solo cuentas de reparador de taller (no el equipo investigador). */
export function requireRepairer(req, res, next) {
  if (req.auth?.role !== 'repairer' || !req.auth.workshopId) {
    return res.status(403).json({ error: 'Se requiere una cuenta de reparador de un taller E1.' });
  }
  next();
}

/** Solo la cuenta administradora de prueba / equipo investigador. */
export function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({ error: 'Esta vista es solo para el equipo investigador (cuenta administradora de prueba).' });
  }
  next();
}
