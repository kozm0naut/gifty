$sql = 'SELECT to_char("createdAt" AT TIME ZONE ''UTC'', ''HH24:MI:SS'') AS time, "action", "outcome", "targetType", "targetId", coalesce("actorUserId",''<null>'') AS actor, ip, "detail" FROM "AuditEvent" ORDER BY "createdAt" DESC LIMIT 45;'
docker compose exec -T postgres psql -U gifty -d gifty -X -c $sql
