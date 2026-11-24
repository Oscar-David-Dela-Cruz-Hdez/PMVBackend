import { Router } from 'express';
import { ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { COLLECTIONS, REPAIR_STATUSES, BUDGET_CHANGE_STATUSES } from '../config/collections.js';
import { requireAuth, requireRepairer } from '../lib/auth.js';
import {
  cleanString, escapeRegex, isNonEmptyString, parseAmount, parseDate, rejectSensitiveBody,
  serializeRepair, serializePublicRepair, stripNulls,
} from '../lib/validate.js';

export function createRepairsRouter(getDb) {
  const router = Router();

  // Todas las rutas de trabajo son del taller de la sesión; nunca se acepta
  // workshopId arbitrario desde el frontend.
  router.use('/repairs', requireAuth, requireRepairer);

  function workshopObjectId(req) {
    return new ObjectId(req.auth.workshopId);
  }

  // Si el body intenta operar sobre otro taller, se niega con 403.
  function rejectForeignWorkshop(req, res) {
    const attempted = cleanString(req.body?.workshopId);
    if (attempted && attempted !== req.auth.workshopId) {
      res.status(403).json({
        error: `Acceso denegado: tu sesión pertenece al taller ${req.auth.workshopCode} y no puedes operar sobre otro taller.`,
      });
      return true;
    }
    return false;
  }

  router.get('/repairs', async (req, res, next) => {
    try {
      const db = getDb();
      const filter = { workshopId: workshopObjectId(req) };

      const { status, q, search } = req.query;
      const term = String(q ?? search ?? '').trim();

      if (isNonEmptyString(status) && status !== 'all' && status !== 'todos') {
        if (!REPAIR_STATUSES.includes(status)) {
          return res.status(400).json({ error: `Estado inválido. Usa uno de: ${REPAIR_STATUSES.join(', ')}.` });
        }
        filter.status = status;
      }

      if (term) {
        const regex = { $regex: escapeRegex(term), $options: 'i' };
        filter.$or = [
          { folio: regex }, { deviceType: regex }, { reportedIssue: regex },
          { diagnosis: regex }, { clientAlias: regex },
        ];
      }

      const docs = await db.collection(COLLECTIONS.repairs)
        .find(filter)
        .sort({ updatedAt: -1 })
        .toArray();

      res.json(docs.map(serializeRepair));
    } catch (error) {
      next(error);
    }
  });

  router.post('/repairs', async (req, res, next) => {
    try {
      if (rejectSensitiveBody(req.body, res)) return;
      if (rejectForeignWorkshop(req, res)) return;
      const body = req.body ?? {};
      const errors = {};

      const folio = cleanString(body.folio);
      const deviceType = cleanString(body.deviceType);
      const reportedIssue = cleanString(body.reportedIssue);
      const status = cleanString(body.status);

      if (!folio) errors.folio = 'El folio es obligatorio.';
      if (!deviceType) errors.deviceType = 'El tipo de equipo es obligatorio.';
      if (!reportedIssue) errors.reportedIssue = 'La falla reportada es obligatoria.';
      if (!status) errors.status = 'El estado inicial es obligatorio.';
      else if (!REPAIR_STATUSES.includes(status)) {
        errors.status = `Estado inválido. Usa uno de: ${REPAIR_STATUSES.join(', ')}.`;
      }

      const budget = parseAmount(body.initialBudget);
      if (budget.error) errors.initialBudget = budget.error;

      const estimated = parseDate(body.estimatedDate);
      if (estimated.error) errors.estimatedDate = estimated.error;

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: 'Faltan campos obligatorios o son inválidos.', details: errors });
      }

      const db = getDb();
      const workshopId = workshopObjectId(req);
      const repairs = db.collection(COLLECTIONS.repairs);

      const existing = await repairs.findOne({ workshopId, folio });
      if (existing) {
        return res.status(409).json({ error: `Ya existe una reparación con el folio "${folio}" en tu taller.` });
      }

      const now = new Date();
      const doc = stripNulls({
        workshopId,
        folio,
        clientAlias: cleanString(body.clientAlias),
        deviceType,
        reportedIssue,
        diagnosis: cleanString(body.diagnosis),
        initialBudget: budget.value,
        estimatedDate: estimated.value,
        status,
        publicToken: crypto.randomBytes(24).toString('hex'),
        timeline: [{ status, note: 'Reparación registrada', createdAt: now, repairerId: new ObjectId(req.auth.id) }],
        budgetChanges: [],
        isDemo: false,
        createdAt: now,
        updatedAt: now,
      });

      await repairs.insertOne(doc);
      res.status(201).json(serializeRepair(doc));
    } catch (error) {
      next(error);
    }
  });

  router.get('/repairs/:folio', async (req, res, next) => {
    try {
      const db = getDb();
      const doc = await db.collection(COLLECTIONS.repairs).findOne({
        workshopId: workshopObjectId(req),
        folio: req.params.folio,
      });
      if (!doc) {
        return res.status(404).json({ error: `No existe una reparación con el folio "${req.params.folio}" en tu taller.` });
      }
      res.json(serializeRepair(doc));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/repairs/:folio', async (req, res, next) => {
    try {
      if (rejectSensitiveBody(req.body, res)) return;
      if (rejectForeignWorkshop(req, res)) return;
      const body = req.body ?? {};
      const db = getDb();
      const workshopId = workshopObjectId(req);
      const repairs = db.collection(COLLECTIONS.repairs);

      const current = await repairs.findOne({ workshopId, folio: req.params.folio });
      if (!current) {
        return res.status(404).json({ error: `No existe una reparación con el folio "${req.params.folio}" en tu taller.` });
      }

      const errors = {};
      const updates = {};
      const unset = {};

      if (body.status !== undefined) {
        if (!REPAIR_STATUSES.includes(body.status)) {
          errors.status = `Estado inválido. Usa uno de: ${REPAIR_STATUSES.join(', ')}.`;
        } else {
          updates.status = body.status;
        }
      }
      if (body.diagnosis !== undefined) {
        const diagnosis = cleanString(body.diagnosis);
        if (diagnosis) updates.diagnosis = diagnosis;
        else unset.diagnosis = ''; // el esquema no admite null en diagnosis
      }
      if (body.initialBudget !== undefined) {
        const budget = parseAmount(body.initialBudget);
        if (budget.error) errors.initialBudget = budget.error;
        else updates.initialBudget = budget.value;
      }
      if (body.estimatedDate !== undefined) {
        const estimated = parseDate(body.estimatedDate);
        if (estimated.error) errors.estimatedDate = estimated.error;
        else updates.estimatedDate = estimated.value;
      }

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: 'Datos inválidos.', details: errors });
      }

      const now = new Date();
      updates.updatedAt = now;

      const updateDoc = { $set: updates };
      if (Object.keys(unset).length > 0) updateDoc.$unset = unset;
      if (updates.status && updates.status !== current.status) {
        updateDoc.$push = {
          timeline: {
            status: updates.status,
            note: cleanString(body.timelineNote) ?? 'Cambio de estado',
            createdAt: now,
            repairerId: new ObjectId(req.auth.id),
          },
        };
      }

      const result = await repairs.findOneAndUpdate(
        { workshopId, folio: req.params.folio },
        updateDoc,
        { returnDocument: 'after' },
      );

      res.json(serializeRepair(result));
    } catch (error) {
      next(error);
    }
  });

  router.post('/repairs/:folio/budget-changes', async (req, res, next) => {
    try {
      if (rejectSensitiveBody(req.body, res)) return;
      if (rejectForeignWorkshop(req, res)) return;
      const body = req.body ?? {};
      const errors = {};

      const reason = cleanString(body.reason);
      if (!reason) errors.reason = 'La razón de la falla adicional es obligatoria.';

      const amount = parseAmount(body.amount);
      if (amount.error) errors.amount = amount.error;
      else if (body.amount === undefined || body.amount === null || body.amount === '') {
        errors.amount = 'El monto es obligatorio.';
      }

      const authorizationStatus = cleanString(body.authorizationStatus);
      if (!authorizationStatus) errors.authorizationStatus = 'El estado de autorización es obligatorio.';
      else if (!BUDGET_CHANGE_STATUSES.includes(authorizationStatus)) {
        errors.authorizationStatus = `Estado de autorización inválido. Usa uno de: ${BUDGET_CHANGE_STATUSES.join(', ')}.`;
      }

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: 'Faltan campos obligatorios o son inválidos.', details: errors });
      }

      const db = getDb();
      const workshopId = workshopObjectId(req);
      const repairs = db.collection(COLLECTIONS.repairs);

      const now = new Date();
      const change = stripNulls({
        reason,
        amount: amount.value,
        authorizationStatus,
        authorizationNote: cleanString(body.authorizationNote),
        createdAt: now,
      });

      const result = await repairs.findOneAndUpdate(
        { workshopId, folio: req.params.folio },
        { $push: { budgetChanges: change }, $set: { updatedAt: now } },
        { returnDocument: 'after' },
      );

      if (!result) {
        return res.status(404).json({ error: `No existe una reparación con el folio "${req.params.folio}" en tu taller.` });
      }

      res.status(201).json(serializeRepair(result));
    } catch (error) {
      next(error);
    }
  });

  // Vista pública de solo lectura (sin autenticación, solo con el token público).
  router.get('/public/repairs/:token', async (req, res, next) => {
    try {
      const db = getDb();
      const doc = await db.collection(COLLECTIONS.repairs).findOne({ publicToken: req.params.token });
      if (!doc) {
        return res.status(404).json({ error: 'No existe una reparación con ese enlace público.' });
      }
      res.json(serializePublicRepair(doc));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
