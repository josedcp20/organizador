-- Fase 4 (Web Push): estado de cada suscripcion. Las tablas ya existen desde 0001.
-- last_error: codigo del ultimo fallo de envio (p. ej. 'rejected_403', 'retry_503'); NULL tras un exito.
-- expires_at: PushSubscription.expirationTime en ISO-8601 UTC (normalmente NULL; Apple siempre NULL).
ALTER TABLE push_subscriptions ADD COLUMN last_error TEXT;
ALTER TABLE push_subscriptions ADD COLUMN expires_at TEXT;
