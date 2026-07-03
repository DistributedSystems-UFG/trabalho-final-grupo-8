-- ─────────────────────────────────────────────────────────────────────────────
-- Aquarela.io — Massa de teste para os cenários T5 (restauração pós-restart)
-- e T7 (replicação). Semeia canvas_chunks com histórico de pinceladas e uma
-- `version` OCC conhecida, para provar:
--   • que o `canvas_state` restaura o histórico após `docker compose restart gateway`
--   • que `chunkVersionManager.initChunk` hidrata o Redis com a versão correta
--     (a 1ª pincelada com version == a versão semeada deve ser ACEITA, não conflito)
--
-- Uso:
--   docker exec -i aquarela-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < tests/sql/seed_canvas.sql
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO canvas_chunks (room_id, chunk_id, pixel_data, version) VALUES
  ('sala-seed', '4_4',
   '[
      {"x":640,"y":300,"color":"#120A8F","brushSize":8,"opacity":1.0,"eraser":false,"userId":"seed","timestamp":1751430000000},
      {"x":648,"y":305,"color":"#120A8F","brushSize":8,"opacity":1.0,"eraser":false,"userId":"seed","timestamp":1751430000100},
      {"x":660,"y":310,"color":"#C81E1E","brushSize":12,"opacity":1.0,"eraser":false,"userId":"seed","timestamp":1751430000200}
    ]'::jsonb,
   3),
  ('sala-seed', '1_2',
   '[
      {"x":200,"y":150,"color":"#1E8F3A","brushSize":6,"opacity":1.0,"eraser":false,"userId":"seed","timestamp":1751430000300}
    ]'::jsonb,
   1)
ON CONFLICT (room_id, chunk_id) DO UPDATE
  SET pixel_data = EXCLUDED.pixel_data,
      version    = EXCLUDED.version,
      last_updated = NOW();

-- Conferência: deve listar 2 chunks (4_4 v3, 1_2 v1).
SELECT room_id, chunk_id, jsonb_array_length(pixel_data) AS n_strokes, version
FROM canvas_chunks
WHERE room_id = 'sala-seed'
ORDER BY chunk_id;
