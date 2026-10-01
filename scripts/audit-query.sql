SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'HH24:MI:SS') AS time,
       "action", "outcome", "targetType", "targetId",
       coalesce("actorUserId", '<null>') AS actor,
       ip, "detail"
FROM "AuditEvent"
ORDER BY "createdAt" DESC
LIMIT 45;
