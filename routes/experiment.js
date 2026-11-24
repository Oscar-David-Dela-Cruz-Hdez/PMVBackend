import { Router } from 'express';
import { ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import {
  COLLECTIONS, WORKSHOP_CODES, EXPERIMENT_ID, ASSISTANCE_LEVELS, INCIDENT_TYPES, SEVERE_INCIDENT_TYPES,
} from '../config/collections.js';
import { requireAuth, requireRepairer, requireAdmin } from '../lib/auth.js';
import {
  checkAnonymizedText, cleanString, parseDate, parseIntField, rejectSensitiveBody, serializeDoc, stripNulls,
} from '../lib/validate.js';

const PMV_VERSION = 'pmv-1.0.0';

// Umbrales E1 (documentados en README).
const THRESHOLDS = { completitud: 70, autonomia: 80, medianaMinutos: 5, tiemposMedidos: 90 };
const JOURNEYS_PER_WORKSHOP = 7;
const MIN_ELIGIBLE_PER_WORKSHOP = 10;
const MIN_ELIGIBLE_TOTAL = 30;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeSummary(records, incidents, workshopCode) {
  const recs = workshopCode ? records.filter((r) => r.workshopCode === workshopCode) : records;
  const incs = workshopCode ? incidents.filter((i) => i.workshopCode === workshopCode) : incidents;

  const eligible = recs.filter((r) => r.isEligible);
  const nElegibles = eligible.length;
  const cCompletos = eligible.filter((r) => r.isCompleteAndTimely).length;
  const aCompletosSinAyuda = eligible.filter((r) => r.isCompleteAndTimely && r.assistanceLevel === 'none').length;
  const intentosDeCaptura = recs.filter((r) => r.captureAttempted).length;
  const tiempos = recs.filter((r) => r.additionalMinutes !== null && r.additionalMinutes !== undefined)
    .map((r) => r.additionalMinutes);
  const tiemposMedidos = tiempos.length;
  const jornadasRealizadas = new Set(recs.map((r) => r.journeyNumber)).size;
  const incidentesGraves = incs.filter((i) => SEVERE_INCIDENT_TYPES.includes(i.type)).length;

  const completitudPorcentaje = nElegibles > 0 ? round2((cCompletos / nElegibles) * 100) : null;
  const autonomiaPorcentaje = cCompletos > 0 ? round2((aCompletosSinAyuda / cCompletos) * 100) : 'no definida';
  const porcentajeTiemposMedidos = intentosDeCaptura > 0 ? round2((tiemposMedidos / intentosDeCaptura) * 100) : null;
  // Mediana desde los tiempos individuales (nunca promedio de medianas por taller).
  const medianaMinutosAdicionales = median(tiempos);

  return {
    ...(workshopCode ? { workshopCode } : {}),
    jornadasRealizadas,
    nElegibles,
    cCompletos,
    aCompletosSinAyuda,
    completitudPorcentaje,
    autonomiaPorcentaje,
    tiemposMedidos,
    intentosDeCaptura,
    porcentajeTiemposMedidos,
    medianaMinutosAdicionales,
    incidentesGraves,
    resultadoInterpretabilidad: null, // se calcula aparte (ver interpretResult)
    _records: recs,
  };
}

function interpretResult(summary, allSummaries) {
  if (summary.incidentesGraves > 0) return 'detención';

  if (allSummaries) {
    // Vista agregada: no interpretable si faltan jornadas/elegibles por taller,
    // menos de 30 elegibles totales o menos de 90% de tiempos medidos por taller.
    const totalElegibles = allSummaries.reduce((sum, s) => sum + s.nElegibles, 0);
    const anyWorkshopIncomplete = allSummaries.some(
      (s) => s.jornadasRealizadas < JOURNEYS_PER_WORKSHOP
        || s.nElegibles < MIN_ELIGIBLE_PER_WORKSHOP
        || (s.porcentajeTiemposMedidos ?? 0) < THRESHOLDS.tiemposMedidos,
    );
    if (totalElegibles < MIN_ELIGIBLE_TOTAL || anyWorkshopIncomplete) return 'no interpretable';
  } else {
    if (summary.jornadasRealizadas < JOURNEYS_PER_WORKSHOP
      || summary.nElegibles < MIN_ELIGIBLE_PER_WORKSHOP
      || (summary.porcentajeTiemposMedidos ?? 0) < THRESHOLDS.tiemposMedidos) {
      return 'no interpretable';
    }
  }

  const autonomia = typeof summary.autonomiaPorcentaje === 'number' ? summary.autonomiaPorcentaje : 0;
  const completitud = summary.completitudPorcentaje ?? 0;
  const mediana = summary.medianaMinutosAdicionales ?? Infinity;
  const pctTiempos = summary.porcentajeTiemposMedidos ?? 0;

  if (completitud >= THRESHOLDS.completitud
    && autonomia >= THRESHOLDS.autonomia
    && mediana <= THRESHOLDS.medianaMinutos
    && pctTiempos >= THRESHOLDS.tiemposMedidos) {
    return 'apoyo exploratorio';
  }
  return 'no cumple';
}

export function createExperimentRouter(getDb) {
  const router = Router();

  router.use('/experiment-records', requireAuth);
  router.use('/experiment-incidents', requireAuth);

  // -------------------------------------------------------------------------
  // Registros E1 por reparación
  // -------------------------------------------------------------------------

  function validateRecordBody(body, { partial = false } = {}) {
    const errors = {};
    const values = {};

    if (!partial || body.repairFolio !== undefined) {
      values.repairFolio = cleanString(body.repairFolio);
      if (!values.repairFolio) errors.repairFolio = 'El folio de la reparación es obligatorio.';
    }
    if (!partial || body.journeyNumber !== undefined) {
      const j = parseIntField(body.journeyNumber, { min: 1, max: 7 });
      if (j.error) errors.journeyNumber = `La jornada debe ser un entero de 1 a 7. ${j.error}`;
      else values.journeyNumber = j.value;
    }
    if (!partial || body.isEligible !== undefined) {
      if (typeof body.isEligible !== 'boolean') errors.isEligible = 'Indica si la reparación es elegible (sí/no).';
      else values.isEligible = body.isEligible;
    }
    if (values.isEligible === false || (!partial && body.isEligible === false)) {
      values.eligibilityReason = cleanString(body.eligibilityReason);
      if (!values.eligibilityReason) errors.eligibilityReason = 'El motivo es obligatorio cuando la reparación no es elegible.';
    } else if (body.eligibilityReason !== undefined) {
      values.eligibilityReason = cleanString(body.eligibilityReason);
    }
    if (!partial || body.requiredEvents !== undefined) {
      const r = parseIntField(body.requiredEvents, { min: 0 });
      if (r.error) errors.requiredEvents = `Eventos exigibles: ${r.error}`;
      else values.requiredEvents = r.value;
    }
    if (!partial || body.timelyEvents !== undefined) {
      const t = parseIntField(body.timelyEvents, { min: 0 });
      if (t.error) errors.timelyEvents = `Eventos oportunos: ${t.error}`;
      else values.timelyEvents = t.value;
    }
    if (values.requiredEvents !== undefined && values.timelyEvents !== undefined
      && values.timelyEvents > values.requiredEvents) {
      errors.timelyEvents = 'Los eventos oportunos no pueden ser más que los exigibles.';
    }
    if (!partial || body.captureAttempted !== undefined) {
      if (typeof body.captureAttempted !== 'boolean') errors.captureAttempted = 'Indica si se intentó la captura (sí/no).';
      else values.captureAttempted = body.captureAttempted;
    }

    // Tiempos de captura: solo si hubo intento; faltantes quedan en null (nunca 0).
    const captureAttempted = values.captureAttempted ?? partial ? values.captureAttempted : undefined;
    if (values.captureAttempted === false) {
      if (body.captureStartedAt || body.captureCompletedAt || body.additionalMinutes !== undefined && body.additionalMinutes !== null && body.additionalMinutes !== '') {
        errors.captureAttempted = 'Si no hubo intento de captura no debe registrar inicio, fin ni minutos adicionales.';
      }
      values.captureStartedAt = null;
      values.captureCompletedAt = null;
      values.additionalMinutes = null;
    } else {
      const started = parseDate(body.captureStartedAt);
      if (started.error) errors.captureStartedAt = started.error;
      else values.captureStartedAt = started.value;
      const completed = parseDate(body.captureCompletedAt);
      if (completed.error) errors.captureCompletedAt = completed.error;
      else values.captureCompletedAt = completed.value;
      if (values.captureStartedAt && values.captureCompletedAt && values.captureCompletedAt < values.captureStartedAt) {
        errors.captureCompletedAt = 'El fin de la captura no puede ser anterior al inicio.';
      }
      if (body.additionalMinutes === undefined || body.additionalMinutes === null || body.additionalMinutes === '') {
        // Si hay inicio y fin, se calcula; si no, queda vacío (null), nunca 0.
        if (values.captureStartedAt && values.captureCompletedAt) {
          values.additionalMinutes = round2((values.captureCompletedAt - values.captureStartedAt) / 60000);
        } else {
          values.additionalMinutes = null;
        }
      } else {
        const minutes = Number(body.additionalMinutes);
        if (!Number.isFinite(minutes) || minutes < 0) errors.additionalMinutes = 'Los minutos adicionales deben ser un número mayor o igual a 0 (vacío si no se midió).';
        else values.additionalMinutes = round2(minutes);
      }
    }

    if (!partial || body.assistanceLevel !== undefined) {
      const level = cleanString(body.assistanceLevel);
      if (!level || !ASSISTANCE_LEVELS.includes(level)) {
        errors.assistanceLevel = `Nivel de ayuda inválido. Usa uno de: ${ASSISTANCE_LEVELS.join(', ')}.`;
      } else values.assistanceLevel = level;
    }

    if (body.assistanceNote !== undefined) values.assistanceNote = cleanString(body.assistanceNote);
    if (body.incidentId !== undefined) values.incidentId = cleanString(body.incidentId);
    if (body.observations !== undefined) values.observations = cleanString(body.observations);
    if (body.pmvVersion !== undefined) values.pmvVersion = cleanString(body.pmvVersion) ?? PMV_VERSION;

    for (const field of ['assistanceNote', 'observations']) {
      if (values[field]) {
        const problem = checkAnonymizedText(values[field]);
        if (problem) errors[field] = problem;
      }
    }

    // isCompleteAndTimely se calcula en servidor para que las métricas sean reproducibles.
    const reqEvents = values.requiredEvents ?? (partial ? undefined : undefined);
    const timEvents = values.timelyEvents ?? (partial ? undefined : undefined);
    const eligible = values.isEligible ?? (partial ? undefined : undefined);
    if (reqEvents !== undefined && timEvents !== undefined && eligible !== undefined) {
      values.isCompleteAndTimely = eligible && reqEvents > 0 && timEvents >= reqEvents;
    }

    return { errors, values };
  }

  router.post('/experiment-records', requireRepairer, async (req, res, next) => {
    try {
      if (rejectSensitiveBody(req.body, res)) return;
      const body = req.body ?? {};
      const db = getDb();
      const { errors, values } = validateRecordBody(body);
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: 'Datos inválidos del registro E1.', details: errors });
      }

      const workshopId = new ObjectId(req.auth.workshopId);
      const repair = await db.collection(COLLECTIONS.repairs).findOne({
        workshopId,
        folio: values.repairFolio,
      });
      if (!repair) {
        return res.status(404).json({ error: `No existe la reparación "${values.repairFolio}" en tu taller.` });
      }

      const records = db.collection(COLLECTIONS.experiment_records);
      const existing = await records.findOne({ experimentId: EXPERIMENT_ID, repairId: repair._id });
      if (existing) {
        return res.status(409).json({
          error: 'Ya existe un registro E1 para esta reparación.',
          details: { repairFolio: `Usa PATCH /api/experiment-records/${existing._id.toString()} para actualizarlo.` },
        });
      }

      const now = new Date();
      const doc = stripNulls({
        experimentId: EXPERIMENT_ID,
        workshopCode: req.auth.workshopCode,
        repairId: repair._id,
        repairFolio: repair.folio,
        journeyNumber: values.journeyNumber,
        isEligible: values.isEligible,
        eligibilityReason: values.eligibilityReason,
        requiredEvents: values.requiredEvents,
        timelyEvents: values.timelyEvents,
        isCompleteAndTimely: values.isCompleteAndTimely,
        captureAttempted: values.captureAttempted,
        captureStartedAt: values.captureStartedAt,
        captureCompletedAt: values.captureCompletedAt,
        additionalMinutes: values.additionalMinutes,
        assistanceLevel: values.assistanceLevel,
        assistanceNote: values.assistanceNote,
        pmvVersion: values.pmvVersion ?? PMV_VERSION,
        incidentId: values.incidentId,
        observations: values.observations,
        createdAt: now,
        updatedAt: now,
      });

      await records.insertOne(doc);
      res.status(201).json(serializeDoc({ ...doc, repairId: doc.repairId }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/experiment-records', async (req, res, next) => {
    try {
      const db = getDb();
      const filter = { experimentId: EXPERIMENT_ID };

      if (req.auth.role === 'repairer') {
        filter.workshopCode = req.auth.workshopCode;
      } else if (req.query.workshopCode !== undefined) {
        const code = cleanString(req.query.workshopCode);
        if (!WORKSHOP_CODES.includes(code)) {
          return res.status(400).json({ error: `workshopCode inválido. Usa uno de: ${WORKSHOP_CODES.join(', ')}.` });
        }
        filter.workshopCode = code;
      }
      if (req.query.repairFolio !== undefined) {
        const folio = cleanString(req.query.repairFolio);
        if (folio) filter.repairFolio = folio;
      }
      if (req.query.journeyNumber !== undefined) {
        const j = parseIntField(req.query.journeyNumber, { min: 1, max: 7 });
        if (j.error) return res.status(400).json({ error: `journeyNumber inválido: ${j.error}` });
        filter.journeyNumber = j.value;
      }

      const docs = await db.collection(COLLECTIONS.experiment_records)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(docs.map((d) => serializeDoc({ ...d, repairId: d.repairId?.toString?.() ?? d.repairId })));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/experiment-records/:id', requireRepairer, async (req, res, next) => {
    try {
      if (rejectSensitiveBody(req.body, res)) return;
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: 'El id del registro E1 no es válido.' });
      }
      const db = getDb();
      const records = db.collection(COLLECTIONS.experiment_records);
      const current = await records.findOne({ _id: new ObjectId(req.params.id) });
      if (!current) {
        return res.status(404).json({ error: 'No existe ese registro E1.' });
      }
      if (current.workshopCode !== req.auth.workshopCode) {
        return res.status(403).json({ error: 'Acceso denegado: ese registro pertenece a otro taller.' });
      }

      const body = req.body ?? {};
      const { errors, values } = validateRecordBody(body, { partial: true });

      // Merge con el documento actual para recalcular isCompleteAndTimely.
      const merged = {
        repairFolio: current.repairFolio,
        journeyNumber: values.journeyNumber ?? current.journeyNumber,
        isEligible: values.isEligible ?? current.isEligible,
        eligibilityReason: values.eligibilityReason !== undefined ? values.eligibilityReason : current.eligibilityReason,
        requiredEvents: values.requiredEvents ?? current.requiredEvents,
        timelyEvents: values.timelyEvents ?? current.timelyEvents,
        captureAttempted: values.captureAttempted ?? current.captureAttempted,
        captureStartedAt: values.captureStartedAt !== undefined ? values.captureStartedAt : current.captureStartedAt,
        captureCompletedAt: values.captureCompletedAt !== undefined ? values.captureCompletedAt : current.captureCompletedAt,
        additionalMinutes: values.additionalMinutes !== undefined ? values.additionalMinutes : current.additionalMinutes,
        assistanceLevel: values.assistanceLevel ?? current.assistanceLevel,
      };

      if (merged.timelyEvents > merged.requiredEvents) {
        errors.timelyEvents = 'Los eventos oportunos no pueden ser más que los exigibles.';
      }
      if (merged.isEligible === false && !cleanString(merged.eligibilityReason)) {
        errors.eligibilityReason = 'El motivo es obligatorio cuando la reparación no es elegible.';
      }
      if (merged.captureAttempted === false
        && (merged.captureStartedAt || merged.captureCompletedAt || merged.additionalMinutes !== null && merged.additionalMinutes !== undefined)) {
        errors.captureAttempted = 'Si no hubo intento de captura no debe quedar inicio, fin ni minutos adicionales.';
      }

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: 'Datos inválidos del registro E1.', details: errors });
      }

      const now = new Date();
      const set = stripNulls({
        ...(values.journeyNumber !== undefined ? { journeyNumber: values.journeyNumber } : {}),
        ...(values.isEligible !== undefined ? { isEligible: values.isEligible } : {}),
        ...(values.eligibilityReason !== undefined ? { eligibilityReason: values.eligibilityReason } : {}),
        ...(values.requiredEvents !== undefined ? { requiredEvents: values.requiredEvents } : {}),
        ...(values.timelyEvents !== undefined ? { timelyEvents: values.timelyEvents } : {}),
        ...(values.captureAttempted !== undefined ? { captureAttempted: values.captureAttempted } : {}),
        ...(values.captureStartedAt !== undefined ? { captureStartedAt: values.captureStartedAt } : {}),
        ...(values.captureCompletedAt !== undefined ? { captureCompletedAt: values.captureCompletedAt } : {}),
        ...(values.additionalMinutes !== undefined ? { additionalMinutes: values.additionalMinutes } : {}),
        ...(values.assistanceLevel !== undefined ? { assistanceLevel: values.assistanceLevel } : {}),
        ...(values.assistanceNote !== undefined ? { assistanceNote: values.assistanceNote } : {}),
        ...(values.incidentId !== undefined ? { incidentId: values.incidentId } : {}),
        ...(values.observations !== undefined ? { observations: values.observations } : {}),
        ...(values.pmvVersion !== undefined ? { pmvVersion: values.pmvVersion } : {}),
        isCompleteAndTimely: merged.isEligible && merged.requiredEvents > 0 && merged.timelyEvents >= merged.requiredEvents,
        updatedAt: now,
      });
      // Si no hubo captura, los campos de tiempo deben quedar vacíos (null), nunca en 0.
      const unset = {};
      if (merged.captureAttempted === false) {
        unset.captureStartedAt = '';
        unset.captureCompletedAt = '';
        unset.additionalMinutes = '';
      }

      const updateDoc = { $set: set };
      if (Object.keys(unset).length > 0) updateDoc.$unset = unset;

      const result = await records.findOneAndUpdate(
        { _id: current._id },
        updateDoc,
        { returnDocument: 'after' },
      );

      res.json(serializeDoc({ ...result, repairId: result.repairId?.toString?.() ?? result.repairId }));
    } catch (error) {
      next(error);
    }
  });

  // Resumen agregado E1: solo equipo investigador (cuenta admin de prueba).
  router.get('/experiment-records/summary', requireAdmin, async (req, res, next) => {
    try {
      const db = getDb();
      const records = await db.collection(COLLECTIONS.experiment_records)
        .find({ experimentId: EXPERIMENT_ID })
        .toArray();
      const incidents = await db.collection(COLLECTIONS.experiment_incidents)
        .find({ experimentId: EXPERIMENT_ID })
        .toArray();

      const perWorkshop = WORKSHOP_CODES.map((code) => {
        const s = computeSummary(records, incidents, code);
        const { _records, ...rest } = s;
        return { ...rest, resultadoInterpretabilidad: interpretResult(rest, null) };
      });

      const agg = computeSummary(records, incidents, null);
      const { _records, ...aggRest } = agg;
      const agregado = {
        ...aggRest,
        totalElegibles: aggRest.nElegibles,
        resultadoInterpretabilidad: interpretResult(aggRest, perWorkshop),
      };

      res.json({
        experimentId: EXPERIMENT_ID,
        pmvVersion: PMV_VERSION,
        generadoEn: new Date().toISOString(),
        umbrales: THRESHOLDS,
        porTaller: perWorkshop,
        agregado,
      });
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------------------
  // Incidencias E1
  // -------------------------------------------------------------------------

  router.post('/experiment-incidents', async (req, res, next) => {
    try {
      if (rejectSensitiveBody(req.body, res)) return;
      const body = req.body ?? {};
      const errors = {};

      let workshopCode;
      if (req.auth.role === 'admin') {
        workshopCode = cleanString(body.workshopCode);
        if (!WORKSHOP_CODES.includes(workshopCode)) {
          errors.workshopCode = `El taller es obligatorio para el equipo investigador. Usa uno de: ${WORKSHOP_CODES.join(', ')}.`;
        }
      } else {
        workshopCode = req.auth.workshopCode;
      }

      const j = parseIntField(body.journeyNumber, { min: 1, max: 7 });
      if (j.error) errors.journeyNumber = `La jornada debe ser un entero de 1 a 7. ${j.error}`;

      const date = parseDate(body.date);
      if (date.error || !date.value) errors.date = 'La fecha del incidente es obligatoria.';

      const type = cleanString(body.type);
      if (!INCIDENT_TYPES.includes(type)) {
        errors.type = `Tipo inválido. Usa uno de: ${INCIDENT_TYPES.join(', ')}.`;
      }

      const description = cleanString(body.description);
      if (!description) errors.description = 'La descripción del incidente es obligatoria.';

      const impact = cleanString(body.impact);
      const actionTaken = cleanString(body.actionTaken);
      const resolution = cleanString(body.resolution);

      for (const [field, value] of [['description', description], ['impact', impact], ['actionTaken', actionTaken], ['resolution', resolution]]) {
        if (value) {
          const problem = checkAnonymizedText(value);
          if (problem) errors[field] = problem;
        }
      }

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: 'Datos inválidos de la incidencia.', details: errors });
      }

      const db = getDb();
      const incidents = db.collection(COLLECTIONS.experiment_incidents);
      const incidentId = cleanString(body.incidentId) ?? `INC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

      const existing = await incidents.findOne({ experimentId: EXPERIMENT_ID, incidentId });
      if (existing) {
        return res.status(409).json({ error: `Ya existe una incidencia con el id "${incidentId}".` });
      }

      const doc = stripNulls({
        experimentId: EXPERIMENT_ID,
        incidentId,
        workshopCode,
        journeyNumber: j.value,
        date: date.value,
        type,
        description,
        impact,
        actionTaken,
        resolution,
        createdAt: new Date(),
      });

      await incidents.insertOne(doc);
      res.status(201).json(serializeDoc(doc));
    } catch (error) {
      next(error);
    }
  });

  router.get('/experiment-incidents', async (req, res, next) => {
    try {
      const db = getDb();
      const filter = { experimentId: EXPERIMENT_ID };

      if (req.auth.role === 'repairer') {
        filter.workshopCode = req.auth.workshopCode;
      } else if (req.query.workshopCode !== undefined) {
        const code = cleanString(req.query.workshopCode);
        if (!WORKSHOP_CODES.includes(code)) {
          return res.status(400).json({ error: `workshopCode inválido. Usa uno de: ${WORKSHOP_CODES.join(', ')}.` });
        }
        filter.workshopCode = code;
      }
      if (req.query.type !== undefined) {
        const type = cleanString(req.query.type);
        if (!INCIDENT_TYPES.includes(type)) {
          return res.status(400).json({ error: `Tipo inválido. Usa uno de: ${INCIDENT_TYPES.join(', ')}.` });
        }
        filter.type = type;
      }
      if (req.query.journeyNumber !== undefined) {
        const j = parseIntField(req.query.journeyNumber, { min: 1, max: 7 });
        if (j.error) return res.status(400).json({ error: `journeyNumber inválido: ${j.error}` });
        filter.journeyNumber = j.value;
      }

      const docs = await db.collection(COLLECTIONS.experiment_incidents)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(docs.map(serializeDoc));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
