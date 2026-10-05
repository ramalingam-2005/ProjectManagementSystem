// A reversible representation for any JSON tool result. Repeated object keys
// become table columns; repeated values refer to an earlier JSON Pointer in the
// expanded data. No records, values or array order are lost in this pass.
export function encodeContextValue(value: unknown): unknown {
  const seen = new Map<string, string>();
  const pointer = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
  const reserved = (object: Record<string, unknown>) => ["$ref", "$columns", "$rows", "$literal"].some((key) => Object.hasOwn(object, key));
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);

  function encode(item: unknown, path: string): unknown {
    if (item === null || typeof item !== "object") return item;
    const key = JSON.stringify(item);
    if (key.length >= 100) {
      const previous = seen.get(key);
      if (previous !== undefined) return { $ref: previous };
      seen.set(key, path);
    }
    if (Array.isArray(item)) {
      const rows = item.map((entry, index) => encode(entry, pointer(path, index)));
      const first = item[0];
      if (item.length >= 2 && object(first) && !reserved(first)) {
        const columns = Object.keys(first);
        if (columns.length && item.every((row) => object(row) && !reserved(row)
          && Object.keys(row).length === columns.length && columns.every((column) => Object.hasOwn(row, column)))) {
          const table = { $columns: columns, $rows: rows.map((row) => {
            const data = row as Record<string, unknown>;
            return Object.hasOwn(data, "$ref") ? data : columns.map((column) => data[column]);
          }) };
          if (JSON.stringify(table).length < JSON.stringify(rows).length) return table;
        }
      }
      return rows;
    }
    const data = Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, encode(entry, pointer(path, name))]));
    return reserved(item as Record<string, unknown>) ? { $literal: data } : data;
  }
  return encode(value, "");
}

export function encodeToolContent(content: string, truncated = false): string {
  try {
    const data = JSON.parse(content);
    const plain = truncated ? JSON.stringify({ modelContextTruncated: true, data }) : content;
    const encoded = JSON.stringify({ modelContextEncoding: "json-tables-v1", ...(truncated ? { modelContextTruncated: true } : {}), data: encodeContextValue(data) });
    return encoded.length < plain.length ? encoded : plain;
  } catch {
    return truncated ? content + "\n[Tool result excerpt; remaining content omitted.]" : content;
  }
}
