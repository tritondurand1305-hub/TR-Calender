/**
 * Run an async mapper over a list with a fixed concurrency limit, preserving
 * input order. Used so a page with many `.ics` links does not open one
 * connection per event or run serially for a minute.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(limit, items.length || 1));
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
