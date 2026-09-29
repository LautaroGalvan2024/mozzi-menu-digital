export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals<T>(actual: T, expected: T, message = "Values are not equal"): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}\nActual: ${left}\nExpected: ${right}`);
}

export async function assertRejects(
  action: () => unknown | Promise<unknown>,
  predicate?: (error: unknown) => boolean,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!predicate || predicate(error)) return;
    throw new Error(`Rejected with an unexpected error: ${String(error)}`);
  }
  throw new Error("Expected action to reject");
}
