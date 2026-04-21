/**
 * Persona memory: pgvector retrieval and writes.
 * Implemented at J17.
 */

export type Memory = {
  id: string;
  personaId: string;
  content: string;
  createdAt: string;
  importance: number; // 0..1
};

export async function recallRelevant(
  personaId: string,
  query: string,
  limit = 5,
): Promise<Memory[]> {
  void personaId;
  void query;
  void limit;
  return [];
}
