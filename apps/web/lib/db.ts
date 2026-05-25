import pg from "pg";

const { Pool } = pg;

// A single shared pool per server process. In Next dev the module is re-evaluated
// on hot reload, so we stash it on globalThis to avoid leaking connections.
const g = globalThis as unknown as { __pgPool?: pg.Pool };
export const pool =
  g.__pgPool ??
  (g.__pgPool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://inferlog:inferlog@localhost:5432/inferlog",
    max: 10,
  }));

export interface Conversation {
  id: string;
  title: string | null;
  status: "active" | "cancelled";
  model: string | null;
  provider: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "system" | "user" | "assistant";
  content: string;
  created_at: string;
}

export async function listConversations(): Promise<Conversation[]> {
  const { rows } = await pool.query<Conversation>(
    `SELECT c.*, count(m.id) FILTER (WHERE m.role <> 'system') AS msg_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT 200`,
  );
  return rows;
}

export async function createConversation(): Promise<Conversation> {
  const { rows } = await pool.query<Conversation>(
    `INSERT INTO conversations DEFAULT VALUES RETURNING *`,
  );
  return rows[0];
}

export async function getConversation(
  id: string,
): Promise<{ conversation: Conversation; messages: Message[] } | null> {
  const conv = await pool.query<Conversation>(
    `SELECT * FROM conversations WHERE id = $1`,
    [id],
  );
  if (conv.rowCount === 0) return null;
  const msgs = await pool.query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [id],
  );
  return { conversation: conv.rows[0], messages: msgs.rows };
}

export async function cancelConversation(id: string): Promise<void> {
  await pool.query(
    `UPDATE conversations SET status = 'cancelled', updated_at = now() WHERE id = $1`,
    [id],
  );
}

export async function addMessage(
  conversationId: string,
  role: Message["role"],
  content: string,
  tokenCount?: number,
): Promise<Message> {
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages (conversation_id, role, content, token_count)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [conversationId, role, content, tokenCount ?? null],
  );
  return rows[0];
}

export async function setConversationMeta(
  id: string,
  fields: { title?: string; model?: string; provider?: string },
): Promise<void> {
  await pool.query(
    `UPDATE conversations
        SET title    = COALESCE($2, title),
            model    = COALESCE($3, model),
            provider = COALESCE($4, provider),
            updated_at = now()
      WHERE id = $1`,
    [id, fields.title ?? null, fields.model ?? null, fields.provider ?? null],
  );
}
