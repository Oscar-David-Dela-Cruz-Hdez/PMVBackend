import { connectToMongoDB, disconnectFromMongoDB } from './db.js';

export const COLLECTIONS = {
  workshops: 'workshops',
  repairers: 'repairers',
  researchers: 'researchers',
  repairs: 'repairs',
  experiment_records: 'experiment_records',
  experiment_incidents: 'experiment_incidents',
};

const statuses = [
  'received', 'diagnosis', 'waiting_authorization', 'in_repair',
  'waiting_part', 'ready_for_pickup', 'delivered', 'cancelled',
];

export const REPAIR_STATUSES = statuses;

export const BUDGET_CHANGE_STATUSES = ['pending', 'approved', 'rejected', 'not_applicable'];

export const WORKSHOP_CODES = ['E1-T01', 'E1-T02', 'E1-T03'];

export const EXPERIMENT_ID = 'E1';

export const ASSISTANCE_LEVELS = ['none', 'partial', 'total'];

export const INCIDENT_TYPES = [
  'access_error', 'network_error', 'data_entry_error', 'late_capture',
  'support_requested', 'withdrawal', 'privacy_incident', 'other',
];

// Incidentes considerados graves para la regla de "detención".
export const SEVERE_INCIDENT_TYPES = ['privacy_incident', 'withdrawal'];

export async function createPMVCollections() {
  const db = await connectToMongoDB();
  const existing = new Set((await db.listCollections().toArray()).map(({ name }) => name));

  if (!existing.has(COLLECTIONS.workshops)) {
    await db.createCollection(COLLECTIONS.workshops, {
      validator: { $jsonSchema: { bsonType: 'object', required: ['code', 'name', 'createdAt'], properties: {
        code: { bsonType: 'string' }, name: { bsonType: 'string' }, createdAt: { bsonType: 'date' },
      } } },
    });
  }

  if (!existing.has(COLLECTIONS.repairers)) {
    await db.createCollection(COLLECTIONS.repairers, {
      validator: { $jsonSchema: { bsonType: 'object', required: ['workshopId', 'displayName', 'role', 'createdAt'], properties: {
        workshopId: { bsonType: 'objectId' }, displayName: { bsonType: 'string' }, role: { enum: ['repairer'] },
        passwordHash: { bsonType: 'string' }, createdAt: { bsonType: 'date' },
      } } },
    });
  }

  // Cuenta administradora de prueba / equipo investigador (rol admin, fuera de los talleres E1).
  if (!existing.has(COLLECTIONS.researchers)) {
    await db.createCollection(COLLECTIONS.researchers, {
      validator: { $jsonSchema: { bsonType: 'object', required: ['username', 'passwordHash', 'role', 'createdAt'], properties: {
        username: { bsonType: 'string' }, passwordHash: { bsonType: 'string' },
        displayName: { bsonType: 'string' }, role: { enum: ['admin'] }, createdAt: { bsonType: 'date' },
      } } },
    });
  }

  if (!existing.has(COLLECTIONS.repairs)) {
    await db.createCollection(COLLECTIONS.repairs, {
      validator: { $jsonSchema: { bsonType: 'object', required: ['workshopId', 'folio', 'deviceType', 'reportedIssue', 'status', 'publicToken', 'createdAt', 'updatedAt'], properties: {
        workshopId: { bsonType: 'objectId' }, folio: { bsonType: 'string' }, clientAlias: { bsonType: 'string' },
        deviceType: { bsonType: 'string' }, reportedIssue: { bsonType: 'string' }, diagnosis: { bsonType: 'string' },
        initialBudget: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] }, estimatedDate: { bsonType: ['date', 'null'] },
        status: { enum: statuses }, publicToken: { bsonType: 'string' },
        timeline: { bsonType: 'array', items: { bsonType: 'object', required: ['status', 'createdAt'], properties: {
          status: { enum: statuses }, note: { bsonType: 'string' }, createdAt: { bsonType: 'date' }, repairerId: { bsonType: 'objectId' },
        } } },
        budgetChanges: { bsonType: 'array', items: { bsonType: 'object', required: ['reason', 'amount', 'authorizationStatus', 'createdAt'], properties: {
          reason: { bsonType: 'string' }, amount: { bsonType: ['double', 'int', 'long', 'decimal'] },
          authorizationStatus: { enum: ['pending', 'approved', 'rejected', 'not_applicable'] }, authorizationNote: { bsonType: 'string' }, createdAt: { bsonType: 'date' },
        } } },
        createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' },
      } } },
    });
  }

  // Registro E1 de métricas: un registro E1 por reparación (la regla de actualización
  // documentada es usar PATCH /api/experiment-records/:id sobre el mismo documento).
  if (!existing.has(COLLECTIONS.experiment_records)) {
    await db.createCollection(COLLECTIONS.experiment_records, {
      validator: { $jsonSchema: { bsonType: 'object', required: [
        'experimentId', 'workshopCode', 'repairId', 'repairFolio', 'journeyNumber',
        'isEligible', 'requiredEvents', 'timelyEvents', 'isCompleteAndTimely',
        'captureAttempted', 'assistanceLevel', 'pmvVersion', 'createdAt', 'updatedAt',
      ], properties: {
        experimentId: { enum: [EXPERIMENT_ID] },
        workshopCode: { enum: WORKSHOP_CODES },
        repairId: { bsonType: 'objectId' },
        repairFolio: { bsonType: 'string' },
        journeyNumber: { bsonType: 'int', minimum: 1, maximum: 7 },
        isEligible: { bsonType: 'bool' },
        eligibilityReason: { bsonType: 'string' },
        requiredEvents: { bsonType: 'int', minimum: 0 },
        timelyEvents: { bsonType: 'int', minimum: 0 },
        isCompleteAndTimely: { bsonType: 'bool' },
        captureAttempted: { bsonType: 'bool' },
        captureStartedAt: { bsonType: ['date', 'null'] },
        captureCompletedAt: { bsonType: ['date', 'null'] },
        // Vacío (null) si no se logró medir; nunca se convierte a cero.
        additionalMinutes: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] },
        assistanceLevel: { enum: ASSISTANCE_LEVELS },
        assistanceNote: { bsonType: 'string' },
        pmvVersion: { bsonType: 'string' },
        incidentId: { bsonType: 'string' },
        observations: { bsonType: 'string' },
        createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' },
      } } },
    });
  }

  if (!existing.has(COLLECTIONS.experiment_incidents)) {
    await db.createCollection(COLLECTIONS.experiment_incidents, {
      validator: { $jsonSchema: { bsonType: 'object', required: [
        'experimentId', 'incidentId', 'workshopCode', 'journeyNumber', 'date', 'type', 'description', 'createdAt',
      ], properties: {
        experimentId: { enum: [EXPERIMENT_ID] },
        incidentId: { bsonType: 'string' },
        workshopCode: { enum: WORKSHOP_CODES },
        journeyNumber: { bsonType: 'int', minimum: 1, maximum: 7 },
        date: { bsonType: 'date' },
        type: { enum: INCIDENT_TYPES },
        description: { bsonType: 'string' },
        impact: { bsonType: 'string' }, actionTaken: { bsonType: 'string' }, resolution: { bsonType: 'string' },
        createdAt: { bsonType: 'date' },
      } } },
    });
  }

  await Promise.all([
    db.collection(COLLECTIONS.workshops).createIndex({ code: 1 }, { unique: true }),
    db.collection(COLLECTIONS.repairers).createIndex({ workshopId: 1 }),
    db.collection(COLLECTIONS.researchers).createIndex({ username: 1 }, { unique: true }),
    db.collection(COLLECTIONS.repairs).createIndex({ workshopId: 1, status: 1, updatedAt: -1 }),
    db.collection(COLLECTIONS.repairs).createIndex({ workshopId: 1, folio: 1 }, { unique: true }),
    db.collection(COLLECTIONS.repairs).createIndex({ publicToken: 1 }, { unique: true }),
    // Un registro E1 por reparación (actualización vía PATCH documentada).
    db.collection(COLLECTIONS.experiment_records).createIndex({ experimentId: 1, repairId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.experiment_records).createIndex({ experimentId: 1, workshopCode: 1, journeyNumber: 1 }),
    db.collection(COLLECTIONS.experiment_records).createIndex({ workshopCode: 1, repairFolio: 1 }),
    db.collection(COLLECTIONS.experiment_incidents).createIndex({ experimentId: 1, incidentId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.experiment_incidents).createIndex({ experimentId: 1, workshopCode: 1, journeyNumber: 1 }),
    db.collection(COLLECTIONS.experiment_incidents).createIndex({ workshopCode: 1, type: 1 }),
  ]);
  console.log('Colecciones de ReparaYa PMV listas.');
}

if (process.argv[1]?.endsWith('collections.js')) {
  createPMVCollections().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  }).finally(disconnectFromMongoDB);
}
