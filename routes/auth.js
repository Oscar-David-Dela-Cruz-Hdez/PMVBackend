import { Router } from 'express';
import { COLLECTIONS, WORKSHOP_CODES } from '../config/collections.js';
import { hashPassword, issueToken, requireAuth } from '../lib/auth.js';
import { cleanString } from '../lib/validate.js';

export function createAuthRouter(getDb) {
  const router = Router();

  // Inicio de sesión de demostración.
  // body: { workshopCode: 'E1-T01', password: '...' }  -> cuenta de reparador
  //     o { username: 'investigador', password: '...' } -> cuenta administradora
  router.post('/login', async (req, res, next) => {
    try {
      // Ojo: aquí SÍ se acepta "password" (es el endpoint de autenticación);
      // el rechazo de campos sensibles aplica a reparaciones y registros E1.
      const body = req.body ?? {};
      const password = typeof body.password === 'string' ? body.password : '';
      const workshopCode = cleanString(body.workshopCode);
      const username = cleanString(body.username);

      if (!password || (!workshopCode && !username)) {
        return res.status(400).json({ error: 'Indica código de taller (o usuario de investigador) y contraseña de demostración.' });
      }

      const db = getDb();
      let user = null;

      if (workshopCode) {
        if (!WORKSHOP_CODES.includes(workshopCode)) {
          return res.status(401).json({ error: 'Credenciales de demostración inválidas.' });
        }
        const workshop = await db.collection(COLLECTIONS.workshops).findOne({ code: workshopCode });
        const repairer = workshop
          ? await db.collection(COLLECTIONS.repairers).findOne({ workshopId: workshop._id })
          : null;
        if (repairer && repairer.passwordHash === hashPassword(password)) {
          user = {
            id: repairer._id.toString(),
            workshopId: workshop._id,
            workshopCode: workshop.code,
            displayName: repairer.displayName,
            role: 'repairer',
          };
        }
      } else {
        const researcher = await db.collection(COLLECTIONS.researchers).findOne({ username });
        if (researcher && researcher.passwordHash === hashPassword(password)) {
          user = {
            id: researcher._id.toString(),
            workshopId: null,
            workshopCode: null,
            displayName: researcher.displayName,
            role: 'admin',
          };
        }
      }

      if (!user) {
        return res.status(401).json({ error: 'Credenciales de demostración inválidas.' });
      }

      const token = issueToken(user);
      res.json({
        token,
        user: { id: user.id, workshopCode: user.workshopCode, displayName: user.displayName, role: user.role },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({
      user: {
        id: req.auth.id,
        workshopCode: req.auth.workshopCode,
        displayName: req.auth.displayName,
        role: req.auth.role,
      },
    });
  });

  // Cierre de sesión: el token es stateless, el cliente lo descarta (ver README).
  router.post('/logout', requireAuth, (req, res) => {
    res.json({ ok: true, message: 'Sesión cerrada. Descarta el token en el cliente.' });
  });

  return router;
}
