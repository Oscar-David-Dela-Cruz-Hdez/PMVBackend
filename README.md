# Backend de ReparaYa — PMV E1

API REST con Express + MongoDB Atlas para el PMV de ReparaYa (talleres de reparación de celulares). Implementa la **infraestructura para medir el experimento E1**; no afirma que E1 se haya ejecutado, validado o resultado exitoso.

Fuera de alcance (intencionalmente): marketplace público, reseñas, pagos, suscripciones, inventario, WhatsApp automático y app móvil.

## Tecnologías y requisitos

- Node.js 20.12+ (recomendado 22/24; `process.loadEnvFile` carga `.env` solo, sin imprimirlo).
- MongoDB Atlas (cadena en `.env`).
- Dependencias: `express`, `cors`, `mongodb`.

## Configuración (sin secretos)

1. Copia `.env.example` como `.env` (nunca compartas `.env`; está en `.gitignore`).
2. Completa en `.env`:
   - `MONGO_URI` — cadena de Atlas (también se acepta `MONGODB_URI`).
   - `MONGODB_DB_NAME` — base de datos (p. ej. `reparaya_pmv`).
   - `PORT` — puerto del backend.
   - Opcionales: `ALLOWED_ORIGINS` (dominios de producción separados por comas; `http://localhost:4200` siempre se permite) y `PMV_SESSION_SECRET` (secreto para firmar sesiones; **no usar el valor por defecto fuera de local**).
3. `npm install`

## Arranque

```bash
npm start        # producción simple
npm run dev      # desarrollo con reinicio automático (node --watch)
npm run setup:collections   # crea/verifica colecciones e índices de forma aislada
```

Al arrancar se crean/verifican colecciones e índices, se aseguran los talleres demo **E1-T01, E1-T02, E1-T03**, una cuenta de reparador demo por taller, la cuenta `investigador` (rol admin) y —solo si un taller no tiene reparaciones— las reparaciones ficticias `DEMO-001…DEMO-003` marcadas con `isDemo: true`. **No se crean registros del experimento** (eso lo hace el flujo real).

## Cuentas de demostración (ficticias, solo local)

| Cuenta | Credencial | Rol |
| --- | --- | --- |
| Taller `E1-T01` / `E1-T02` / `E1-T03` | contraseña `demo1234` | reparador |
| Usuario `investigador` | contraseña `demo1234` | administrador / equipo investigador |

Estas contraseñas son **de demostración**, están pensadas para entorno local y no protegen nada real.

## Autenticación y limitaciones (leer antes de desplegar)

- `POST /api/auth/login` con `{ workshopCode, password }` (reparador) o `{ username, password }` (investigador) devuelve un **token firmado con HMAC-SHA256** (payload base64url + firma, expira en 8 h).
- El frontend envía `Authorization: Bearer <token>`; el backend deriva **taller y reparador desde la sesión**, nunca desde el frontend. Si el body trae un `workshopId` de otro taller, responde **403**.
- `GET /api/auth/me`, `POST /api/auth/logout` (el cierre es local del cliente porque el token es stateless).
- **Limitaciones del mecanismo (PMV, no producción):** secreto por defecto solo para local si no se define `PMV_SESSION_SECRET`; sin revocación de tokens; sin rate limiting ni bloqueo por intentos; contraseñas demo hasheadas con SHA-256 sin salt (aceptable solo para cuentas ficticias de prueba).

## Rutas API

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| GET | `/api/health` | pública | Estado del backend y ping a MongoDB. |
| POST | `/api/auth/login` | pública | Inicio de sesión demo → token. |
| GET | `/api/auth/me` | sí | Datos de la sesión actual. |
| POST | `/api/auth/logout` | sí | Cierre de sesión. |
| GET | `/api/repairs` | reparador | Reparaciones **del taller de la sesión**; filtros `?status=` y `?q=` (folio, equipo, falla, diagnóstico, alias). |
| POST | `/api/repairs` | reparador | Crea reparación (obligatorios: `folio`, `deviceType`, `reportedIssue`, `status`; 409 si el folio ya existe en el taller). |
| GET | `/api/repairs/:folio` | reparador | Detalle (404 si no es de tu taller). |
| PATCH | `/api/repairs/:folio` | reparador | Actualiza `diagnosis`, `initialBudget`, `estimatedDate`, `status`; cada cambio de estado agrega al `timeline` y refresca `updatedAt`. |
| POST | `/api/repairs/:folio/budget-changes` | reparador | Falla adicional: `reason`, `amount`, `authorizationStatus`, `authorizationNote?`. |
| GET | `/api/public/repairs/:token` | pública | Solo lectura: folio, equipo, falla, diagnóstico, estado, fecha estimada, historial sin notas, cambios de presupuesto, última actualización. **Sin alias, token, IDs internos, notas internas ni datos del reparador.** |
| POST | `/api/experiment-records` | reparador | Registro E1 de una reparación elegible (o exclusión justificada); 409 si ya existe registro para esa reparación (usar PATCH). |
| GET | `/api/experiment-records` | sí | Lista; el reparador ve solo su taller, el admin puede filtrar `?workshopCode=&repairFolio=&journeyNumber=`. |
| PATCH | `/api/experiment-records/:id` | reparador | Actualiza el registro de tu taller (403 si es de otro taller). |
| GET | `/api/experiment-records/summary` | **admin** | Resumen E1 por taller y agregado (ver abajo). |
| POST | `/api/experiment-incidents` | sí | Nueva incidencia E1 (`type`, `journeyNumber`, `date`, `description`, `impact?`, `actionTaken?`, `resolution?`, `incidentId?`). |
| GET | `/api/experiment-incidents` | sí | Lista de incidencias (reparador: su taller; admin: filtros opcionales). |

### Estados de reparación

`received`, `diagnosis`, `waiting_authorization`, `in_repair`, `waiting_part`, `ready_for_pickup`, `delivered`, `cancelled`.

### Registro E1 (`experiment_records`)

Campos: `experimentId` (`E1`), `workshopCode` (E1-T01/T02/T03, tomado de la sesión), `repairId`, `repairFolio`, `journeyNumber` (1–7), `isEligible`, `eligibilityReason` (obligatorio si no es elegible), `requiredEvents`, `timelyEvents`, `isCompleteAndTimely` (calculado en servidor), `captureAttempted`, `captureStartedAt`, `captureCompletedAt`, `additionalMinutes`, `assistanceLevel` (`none|partial|total`), `assistanceNote`, `pmvVersion`, `incidentId`, `observations`, `createdAt`, `updatedAt`.

Reglas:

- `additionalMinutes` queda **vacío (null) si no se midió; nunca se convierte a cero**. Si hay inicio y fin de captura y no se indicó, se calcula la diferencia.
- Si `captureAttempted: false` no se aceptan tiempos de captura (registro manual de caso no capturado).
- Una captura hecha completamente por la bina usa `assistanceLevel: 'total'` y **no cuenta como autónoma**.
- `observations` (y notas de ayuda/incidentes) se rechazan con 400 si contienen IMEI, teléfonos (10+ dígitos), contraseñas, correos o datos de contacto.
- Un registro E1 por reparación (índice único `{experimentId, repairId}`); la regla documentada de actualización es `PATCH` sobre el mismo documento.

### Resumen E1 (`GET /api/experiment-records/summary`, solo admin)

Devuelve `porTaller[]` y `agregado` con: `jornadasRealizadas`, `nElegibles`, `cCompletos`, `aCompletosSinAyuda`, `completitudPorcentaje` (C/N×100), `autonomiaPorcentaje` (A/C×100; `"no definida"` si C=0), `tiemposMedidos`, `intentosDeCaptura`, `porcentajeTiemposMedidos` (medidos/intentos×100), `medianaMinutosAdicionales` (**mediana agregada desde todos los tiempos individuales**, nunca promedio de medianas por taller), `incidentesGraves` (tipos `privacy_incident`/`withdrawal`) y `resultadoInterpretabilidad`.

Interpretación (documentada, no es una afirmación de resultado): `detención` si hay incidentes graves; `no interpretable` si falta alguna de: 7 jornadas por taller, 10 elegibles por taller, 30 elegibles totales, 90% de tiempos medidos por taller; si es interpretable, `apoyo exploratorio` cuando completitud ≥70%, autonomía ≥80%, mediana ≤5 min y tiempos medidos ≥90%; en otro caso `no cumple`. **Nunca se eliminan ni ocultan reparaciones elegibles no capturadas** (quedan con `captureAttempted: false` dentro de N).

## Privacidad y seguridad

- No se almacenan IMEI, contraseñas, teléfonos, contactos ni contenido de dispositivos: los cuerpos con campos sensibles (`imei`, `telefono`, `password`, `contacto`, `email`, …) se rechazan con 400.
- CORS restringido a `http://localhost:4200` + `ALLOWED_ORIGINS` (variable de entorno).
- `.env` nunca se imprime, registra ni devuelve por la API; está en `.gitignore` junto con `node_modules`, logs y compilados.
- Las reparaciones se delimitan por taller desde la sesión; un reparador no puede ver ni editar las de otro taller (404/403).

## Flujo de demostración

1. `npm run dev` (backend) y `npm start` en `Frontend/PMV`.
2. En Angular: inicia sesión con `E1-T01` / `demo1234`.
3. Crea una reparación, cambia su estado, registra una falla adicional.
4. En el detalle, pestaña **Registro E1**: registra la jornada y la captura (o el caso no capturado).
5. Copia el enlace público del detalle y ábrelo en `/seguimiento/:token` (sin sesión).
6. Como `investigador` / `demo1234`, abre **Resumen E1** e **Incidencias**.

## Operación manual, exportación, respaldos, pausa y cierre

- **Operación manual:** todo el flujo es manual desde el panel; no hay jobs automáticos.
- **Exportación anonimizada:** `ejemplos/ejemplo_exportacion_E1.csv` define las columnas (sin `repairId`, alias ni datos sensibles). Se puede exportar con un script de lectura sobre `experiment_records` usando ese formato.
- **Respaldos:** usa `mongodump` de Atlas sobre una base de **desarrollo identificada** (nunca producción).
- **Pausa:** dejar de usar el panel (no se crean registros nuevos); **cierre:** dejar de recolectar, exportar y archivar; el PMV no elimina datos.
- Pruebas que modifiquen información: usar solo datos demo o una base de desarrollo identificada.

## Verificación rápida con curl

```bash
B=http://localhost:4000/api
curl $B/health
TOKEN=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"workshopCode":"E1-T01","password":"demo1234"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
curl -H "Authorization: Bearer $TOKEN" $B/repairs
curl -H "Authorization: Bearer $TOKEN" -X POST $B/experiment-records -H 'Content-Type: application/json' \
  -d '{"repairFolio":"DEMO-001","journeyNumber":1,"isEligible":true,"requiredEvents":3,"timelyEvents":3,"captureAttempted":true,"captureStartedAt":"2026-11-24T10:00","captureCompletedAt":"2026-11-24T10:04","assistanceLevel":"none"}'
```

Ver `PMV/ejemplos/datos_demo.json` para el detalle de cuentas y datos ficticios.
