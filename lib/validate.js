// Utilidades de validación y sanitización compartidas por las rutas.

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function cleanString(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

// Elimina claves con null/undefined (el validador de algunas colecciones no
// acepta null en campos opcionales de tipo string).
export function stripNulls(obj) {
  for (const key of Object.keys(obj)) {
    if (obj[key] === null || obj[key] === undefined) delete obj[key];
  }
  return obj;
}

export function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseAmount(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return { error: 'El monto debe ser un número mayor o igual a 0.' };
  }
  return { value: num };
}

export function parseDate(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: 'La fecha no es válida (usa formato AAAA-MM-DD o AAAA-MM-DDTHH:mm).' };
  return { value: date };
}

export function parseIntField(value, { min, max } = {}) {
  if (value === undefined || value === null || value === '') return { error: 'Campo obligatorio.' };
  const num = Number(value);
  if (!Number.isInteger(num)) return { error: 'Debe ser un número entero.' };
  if (min !== undefined && num < min) return { error: `Debe ser mayor o igual a ${min}.` };
  if (max !== undefined && num > max) return { error: `Debe ser menor o igual a ${max}.` };
  return { value: num };
}

// ---------------------------------------------------------------------------
// Privacidad: rechazo explícito de campos sensibles aunque lleguen en el body
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = [
  'imei', 'serial', 'telefono', 'phone', 'movil', 'celular', 'whatsapp',
  'password', 'passwd', 'contrasena', 'pin', 'contacto', 'contactos',
  'nombrecompleto', 'fullname', 'email', 'correo', 'direccion',
  'contenidodispositivo', 'devicecontent', 'notasinternas',
];

function normalizeKey(key) {
  return String(key).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Devuelve la lista de claves sensibles presentes en el body (o []). */
export function findSensitiveKeys(body) {
  if (!body || typeof body !== 'object') return [];
  const normalized = new Set(SENSITIVE_KEYS);
  return Object.keys(body).filter((key) => normalized.has(normalizeKey(key)));
}

/** Lanza respuesta 400 si el body trae campos sensibles. */
export function rejectSensitiveBody(body, res) {
  const found = findSensitiveKeys(body);
  if (found.length > 0) {
    res.status(400).json({
      error: `Campos sensibles no permitidos: ${found.join(', ')}. El PMV no almacena IMEI, teléfonos, contraseñas, contactos ni contenido de dispositivos.`,
    });
    return true;
  }
  return false;
}

// Texto que nunca debe entrar en observaciones/notas (datos anonimizados).
const SENSITIVE_TEXT_PATTERNS = [
  { re: /\bimei\b/i, msg: 'IMEI' },
  { re: /\b\d{10,}\b/, msg: 'números de teléfono o identificadores largos (posible IMEI/teléfono)' },
  { re: /\b(contraseña|contrasena|password|passcode|código de desbloqueo|codigo de desbloqueo)\b/i, msg: 'contraseñas o códigos de desbloqueo' },
  { re: /\b(teléfono|telefono|celular|contacto|whatsapp|correo)\b/i, msg: 'datos de contacto' },
  { re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, msg: 'correos electrónicos' },
];

/** Devuelve un mensaje de error si el texto contiene datos sensibles, o null. */
export function checkAnonymizedText(text) {
  if (!isNonEmptyString(text)) return null;
  for (const { re, msg } of SENSITIVE_TEXT_PATTERNS) {
    if (re.test(text)) return `El texto contiene ${msg}; no se permite en observaciones anonimizadas.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Serializadores
// ---------------------------------------------------------------------------

// Serializa un documento de MongoDB para la API (sin exponer ObjectId crudos).
export function serializeDoc(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

export function serializeRepair(doc) {
  if (!doc) return null;
  const { _id, workshopId, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

// Vista pública de solo lectura: excluye notas internas y datos sensibles.
export function serializePublicRepair(doc) {
  return {
    folio: doc.folio,
    deviceType: doc.deviceType,
    reportedIssue: doc.reportedIssue,
    diagnosis: doc.diagnosis ?? null,
    status: doc.status,
    initialBudget: doc.initialBudget ?? null,
    estimatedDate: doc.estimatedDate ?? null,
    timeline: (doc.timeline ?? []).map(({ status, createdAt }) => ({ status, createdAt })),
    budgetChanges: (doc.budgetChanges ?? []).map(({ reason, amount, authorizationStatus, createdAt }) => ({
      reason, amount, authorizationStatus, createdAt,
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
