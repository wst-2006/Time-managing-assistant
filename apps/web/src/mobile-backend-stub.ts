/** Desktop builds never start an in-app backend; the phone build swaps in the real one. */
export async function startLocalBackend(): Promise<void> {
  throw new Error("The in-app backend only exists in the phone build");
}
