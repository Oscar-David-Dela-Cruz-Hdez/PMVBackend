import crypto from 'node:crypto';
import { COLLECTIONS, WORKSHOP_CODES } from '../config/collections.js';
import { hashPassword } from './auth.js';

// Contraseña de las cuentas FICTICIAS de demostración (documentada en el README).
// No es una contraseña real; existe solo para probar el flujo local del PMV.
export const DEMO_PASSWORD = 'demo1234';

export const DEMO_RESEARCHER_USERNAME = 'investigador';

const WORKSHOP_NAMES = {
  'E1-T01': 'Taller E1-T01',
  'E1-T02': 'Taller E1-T02',
  'E1-T03': 'Taller E1-T03',
};

async function upsertWorkshop(db, code) {
  const workshops = db.collection(COLLECTIONS.workshops);
  let workshop = await workshops.findOne({ code });
  if (!workshop) {
    const doc = { code, name: WORKSHOP_NAMES[code] ?? `Taller ${code}`, createdAt: new Date() };
    const result = await workshops.insertOne(doc);
    workshop = { ...doc, _id: result.insertedId };
  }
  return workshop;
}

async function upsertRepairer(db, workshop, index) {
  const repairers = db.collection(COLLECTIONS.repairers);
  let repairer = await repairers.findOne({ workshopId: workshop._id });
  if (!repairer) {
    const doc = {
      workshopId: workshop._id,
      displayName: `Técnico de demostración ${workshop.code}`,
      role: 'repairer',
      passwordHash: hashPassword(DEMO_PASSWORD),
      createdAt: new Date(),
    };
    const result = await repairers.insertOne(doc);
    repairer = { ...doc, _id: result.insertedId };
  }
  return repairer;
}

async function upsertResearcher(db) {
  const researchers = db.collection(COLLECTIONS.researchers);
  let researcher = await researchers.findOne({ username: DEMO_RESEARCHER_USERNAME });
  if (!researcher) {
    const doc = {
      username: DEMO_RESEARCHER_USERNAME,
      passwordHash: hashPassword(DEMO_PASSWORD),
      displayName: 'Equipo investigador E1',
      role: 'admin',
      createdAt: new Date(),
    };
    const result = await researchers.insertOne(doc);
    researcher = { ...doc, _id: result.insertedId };
  }
  return researcher;
}

// Datos ficticios de demostración únicamente si el taller no tiene reparaciones.
async function seedDemoRepairs(db, workshopId) {
  const repairs = db.collection(COLLECTIONS.repairs);
  const count = await repairs.countDocuments({ workshopId });
  if (count > 0) return false;

  const now = new Date();
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * 60_000);

  const docs = [
    {
      workshopId,
      folio: 'DEMO-001',
      clientAlias: 'Cliente A.',
      deviceType: 'Samsung Galaxy A54',
      reportedIssue: 'No carga el dispositivo',
      diagnosis: 'Conector de carga dañado; se requiere limpieza y posible reemplazo.',
      status: 'diagnosis',
      publicToken: crypto.randomBytes(24).toString('hex'),
      timeline: [
        { status: 'received', note: 'Reparación registrada', createdAt: at(600) },
        { status: 'diagnosis', note: 'En diagnóstico', createdAt: at(120) },
      ],
      budgetChanges: [],
      isDemo: true,
      createdAt: at(600),
      updatedAt: at(120),
    },
    {
      workshopId,
      folio: 'DEMO-002',
      clientAlias: 'Cliente B.',
      deviceType: 'iPhone 12',
      reportedIssue: 'Pantalla rota',
      diagnosis: 'Display fracturado; se cotiza reemplazo de pantalla.',
      initialBudget: 1250,
      status: 'waiting_authorization',
      publicToken: crypto.randomBytes(24).toString('hex'),
      timeline: [
        { status: 'received', note: 'Reparación registrada', createdAt: at(1500) },
        { status: 'waiting_authorization', note: 'Presupuesto enviado, esperando autorización', createdAt: at(90) },
      ],
      budgetChanges: [
        { reason: 'Falla adicional detectada: daño en el marco', amount: 300, authorizationStatus: 'pending', createdAt: at(90) },
      ],
      isDemo: true,
      createdAt: at(1500),
      updatedAt: at(90),
    },
    {
      workshopId,
      folio: 'DEMO-003',
      clientAlias: 'Cliente C.',
      deviceType: 'Motorola G54',
      reportedIssue: 'Cambio de batería',
      diagnosis: 'Batería degradada por debajo del 80% de salud.',
      initialBudget: 650,
      status: 'ready_for_pickup',
      publicToken: crypto.randomBytes(24).toString('hex'),
      timeline: [
        { status: 'received', note: 'Reparación registrada', createdAt: at(3000) },
        { status: 'in_repair', note: 'Reparación en proceso', createdAt: at(2900) },
        { status: 'ready_for_pickup', note: 'Lista para recoger', createdAt: at(30) },
      ],
      budgetChanges: [],
      isDemo: true,
      createdAt: at(3000),
      updatedAt: at(30),
    },
  ];

  const { stripNulls } = await import('./validate.js');
  await repairs.insertMany(docs.map((doc) => stripNulls({
    ...doc,
    budgetChanges: doc.budgetChanges.map(stripNulls),
  })));
  return true;
}

/**
 * Crea/verifica los 3 talleres E1, una cuenta de reparador demo por taller y la
 * cuenta administradora de prueba. Inserta reparaciones ficticias (isDemo) solo
 * en talleres sin reparaciones. No crea datos del experimento.
 */
export async function seedDemoData(db) {
  const report = { workshops: [], researcher: false, demoRepairsSeeded: [] };
  for (const code of WORKSHOP_CODES) {
    const workshop = await upsertWorkshop(db, code);
    await upsertRepairer(db, workshop, code);
    const seeded = await seedDemoRepairs(db, workshop._id);
    if (seeded) report.demoRepairsSeeded.push(code);
    report.workshops.push(code);
  }
  await upsertResearcher(db);
  report.researcher = true;
  return report;
}
