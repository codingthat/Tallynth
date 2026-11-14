CREATE OR REPLACE FUNCTION valid_tags(value TEXT)
RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value::jsonb) <> 'array' THEN FALSE
    ELSE jsonb_array_length(value::jsonb) <= 20
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(value::jsonb) AS tag(element)
        WHERE jsonb_typeof(tag.element) <> 'string'
          OR length(tag.element #>> '{}') = 0
          OR tag.element #>> '{}' <> btrim(tag.element #>> '{}')
      )
      AND jsonb_array_length(value::jsonb) = (
        SELECT count(DISTINCT tag.element)
        FROM jsonb_array_elements_text(value::jsonb) AS tag(element)
      )
  END;
$$;
